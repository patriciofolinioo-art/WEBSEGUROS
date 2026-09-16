# Cotizador multi-compañía — Entrega para integrar en otro sistema

Este documento describe un **cotizador de seguros de auto multi-compañía** ya funcionando
con **5 compañías**: Provincia, Paraná, Mercantil, Digna y Galicia. Está pensado para que
otro proyecto/chat lo integre sin tener que redescubrir los problemas que ya resolvimos
(que fueron varios).

> **Qué está en producción y qué no:** ver la tabla al principio de `NOTAS.md`. Resumen:
> Provincia y Paraná salen a producción por defecto; Mercantil, Digna y Galicia salen a
> **testing** salvo que estén cargadas `MERCANTIL_HOST`, `DIGNA_BASE_URL` y `GALICIA_BASE`.

## Arquitectura (cómo funciona)

- El **frontend** (HTML/JS) tiene un array `CO_CIAS` con las compañías. Al cotizar, llama a
  **todas en paralelo** (`Promise.all`) a una función serverless por compañía.
- **Cada función serverless** (Netlify Functions, Node, sin dependencias npm salvo Digna)
  recibe el mismo objeto con los datos del auto/cliente y **devuelve siempre el mismo
  contrato**:

  ```json
  { "opciones": [ { "plan": "", "cobertura": "", "premio": 0, "suma": 0 } ], "error": "opcional" }
  ```

- El frontend junta todas las `opciones`, las **ordena por precio** y las muestra. Cada
  opción se etiqueta con la compañía de origen. Si una compañía falla, devuelve
  `{error, opciones:[]}` y el frontend simplemente no la muestra (loguea el motivo en consola).

### Datos que manda el frontend a cada función (POST JSON)
```
{ nombre, tel, email, cp, marca, modelo, anio, uso, gnc, gnc_monto, nac, genero, ... }
```
`uso`: "particular"|"comercial". `gnc`: "si"|"no". `nac`: "AAAA-06-15". `genero`: "M"|"F".

### Frontend — puntos clave
- `CO_CIAS = [{ id, nombre, proxy:'/.netlify/functions/xxx-cot', color, soportaBuscarModelo }]`
- Fetch en paralelo con **timeout de 26 segundos por compañía** (AbortController). ⚠️ NO bajarlo:
  Provincia tarda 12–20s (hace login + búsqueda de modelo en vivo + cotización). Con 12s se
  abortaba y no cotizaba nunca. 26s le da margen.
- Una compañía lenta NO debe colgar a las demás (por eso el timeout individual).

---

## Las 5 funciones (netlify/functions/)

### provincia-cot.js — Provincia Seguros (PS2)
- API real de Provincia: `authp.provinciaseguros.com.ar` (login OAuth) + `apimprod...PS-COTIZACION/2.2`.
- **Descuento**: constante `BONIF_ADICIONAL = 25` (campo `40088_bonifAdicional`). Subirlo NO
  bajó el precio en las pruebas: el descuento efectivo lo aplica la **promo PSPLUS/PSTOTAL**
  que Provincia agrega sola. La comisión (20%) va en la cuenta del productor, no en el payload.
- Respuesta: `planes[].promocionesPorPlan[].premio`. Se lee ese `premio` (NO `importe_base`,
  que es sin promo y ~2,4x más caro).
- **Es LENTA** → de acá sale la necesidad del timeout de 26s.
- Env vars: `PROVINCIA_USER`, `PROVINCIA_PASS`. (`API_KEY`/`CLIENT_SECRET` hoy hardcodeados,
  conviene moverlos a env vars.)

### digna-cot.js — Digna Seguros
- Resuelve el vehículo **100% local** contra `infoauto.json` (códigos InfoAuto) — no pega a
  ninguna API de vehículos. `infoauto.json` = `{ "MARCA": [ {n:descripcion, c:codigoRef, t:idAutoTipo} ] }`.
- **Descuento**: `descuentosPoliza: [{ idDescuento: 29 }]` (20%). ⚠️ **OJO: `descuentosPoliza: []`
  (vacío) ROMPE la cotización de Digna.** Para subir el precio hay que pedirle a Digna un
  **código de recargo** y agregarlo al array (no lo teníamos).
- Env vars: `DIGNA_USER`, `DIGNA_PASS`, `DIGNA_BASE_URL` (testing/desarrollo), `DIGNA_COD_PRODUCTOR`.

### mercantil-cot.js — Mercantil Andina
- Flujo: login (OAuth password) → busca vehículo en api-vehiculos → cotiza en `/cotizaciones/v2/auto`.
- ⚠️ **Lecciones aprendidas (claves para que cotice):**
  1. El vehículo se manda como **`vehiculo.infoauto`** (código InfoAuto), NO como `vehiculo.id`.
     Con `id` daba `MCA204 "Error en llamado Vehiculos"`.
  2. La cuenta exige **`bonificacion: 0`**. Con bonif ≠ 0 rechaza con `MCA008` ("combinación
     comisión/bonificación no válida"). Comisiones válidas: 10/20/25/30.
  3. La **búsqueda de vehículo** no admite un `q` largo (HTTP 400 `ERR0014` "demasiados
     caracteres") → usar marca + 2 primeras palabras del modelo, capado a ~40 chars.
  4. Al elegir el vehículo entre varias líneas (ej. "L/14" vs "L/16"), preferir la línea cuyo
     año NO sea posterior al pedido (un auto 2015 no puede ser línea 2016).
- **Entorno por `MERCANTIL_HOST`** — default `apidev.mercantilandina.com.ar` (**TEST**, precios
  de prueba viejos). Producción: `MERCANTIL_HOST = https://api.mercantilandina.com.ar` (ya no
  hace falta tocar el código) + subkey/productor de producción.
- Env vars: `MERCANTIL_USER`, `MERCANTIL_PASS`, `MERCANTIL_SUBKEY` (Ocp-Apim-Subscription-Key),
  `MERCANTIL_PRODUCTOR` (id; en test = 15056), `MERCANTIL_HOST`, `MERCANTIL_CLIENT_ID` y
  `MERCANTIL_LOGIN_URL` (opcionales).

### parana-cot.js — Paraná Seguros (SOAP)
- API SOAP (GeneXus), método `AWSCOTIZARAUTOMOTORES.Execute` (namespace `tempuri.org`).
- El vehículo usa **códigos propios de Paraná** (`MarcaCodigo`/`ModeloCodigo`), resueltos local
  contra `parana_vehiculos.js`. El CP se traduce a SubCódigo postal con `parana_cp.json`
  (Paraná **rechaza** `SubCodigoPostal = 0`).
- **Entorno por `PARANA_BASE`** — default **PRODUCCIÓN**
  (`productores.paranaseguros.com.ar/PARANA_COMERCIAL_PROD`). La variable solo sirve para
  **volver** a testing (`ws.paranaseguros.com.ar/PARANA_COMERCIAL_PRUE`).
- ⚠️ **Bonificación**: default `0`. El origen de TESTING no admite modificarla ("El origen de
  cotización no admite modificar la Bonificación"); en producción, si el origen lo permite,
  `PARANA_BONIFICACION = 20`.
- ⚠️ El manual no trae ejemplo de RESPONSE → el parseo de premios se afinó con `?debug=1`,
  que devuelve el XML crudo.
- Env vars: `PARANA_SISTEMA_ORIGEN` y `PARANA_PRODUCTOR` (**obligatorias**), `PARANA_BASE`,
  `PARANA_PLAN` (NPM), `PARANA_RAMA` (04), `PARANA_TIPO_POLIZA` (AUT01), `PARANA_CAT_IVA` (5),
  `PARANA_FORMA_PAGO` (0), `PARANA_MODO_FACT` (NPM), `PARANA_COND_PAGO` (201),
  `PARANA_BONIFICACION` (0), `PARANA_VIGENCIA_DESDE` (solo testing).

### galicia-cot.js — Galicia Seguros (SURA)
- API "Technical Pricing" (REST/JSON, OAuth password grant, .NET/WCF):
  `POST /Security/token` (token dura 28h, cacheado) → `POST /Motor/api/TechnicalPricing/Cotizar`.
- ⚠️ El `Accept` **tiene que llevar `version=3`** (`application/json;version=3`). Sin la versión
  el server responde con la 1 → 404 `The API 'Version1.TechnicalPricing' doesn't exist`.
- `IdCobertura = 99` trae **todas** las coberturas en una sola llamada (RC, Terceros, Todo Riesgo).
- El vehículo se resuelve local por `IdInfoAuto` contra `infoauto.json` (el mismo de Digna).
- **Entorno por `GALICIA_BASE`** — default `productores-pre.galiciaseguros.com.ar` (**PRE/TEST**).
  Producción: `GALICIA_BASE = https://productores.galiciaseguros.com.ar`. Si producción da 404
  "API doesn't exist", ajustar la ruta con `GALICIA_COTIZAR_PATH`.
- ⚠️ **Zona de riesgo sin resolver**: la tabla Localidad tiene 20k filas, hoy se manda un default
  (Buenos Aires). Afecta el precio por zona — resolver `IdProvincia`/`IdLocalidad` desde el CP.
- Env vars: `GALICIA_USER`, `GALICIA_PASS`, `GALICIA_INSTITUCION`, `GALICIA_PRODUCTOR`,
  `GALICIA_PRODUCTO`, `GALICIA_BASE`, `GALICIA_STORE` (B2B), `GALICIA_ACCEPT`,
  `GALICIA_COTIZAR_PATH`, `GALICIA_ID_ESTADO_CIVIL`, `GALICIA_ID_FORMA_PAGO`,
  `GALICIA_CANT_CUOTAS`, `GALICIA_ID_VIGENCIA`.

---

## Variables de entorno (Netlify → Environment variables)
- **Provincia**: `PROVINCIA_USER`, `PROVINCIA_PASS`
- **Paraná**: `PARANA_SISTEMA_ORIGEN`, `PARANA_PRODUCTOR`, `PARANA_BASE`, `PARANA_PLAN`,
  `PARANA_BONIFICACION`, `PARANA_COND_PAGO`, etc.
- **Mercantil**: `MERCANTIL_USER`, `MERCANTIL_PASS`, `MERCANTIL_SUBKEY`, `MERCANTIL_HOST`,
  `MERCANTIL_CLIENT_ID`, `MERCANTIL_PRODUCTOR`
- **Digna**: `DIGNA_USER`, `DIGNA_PASS`, `DIGNA_BASE_URL`, `DIGNA_COD_PRODUCTOR`
- **Galicia**: `GALICIA_USER`, `GALICIA_PASS`, `GALICIA_BASE`, `GALICIA_INSTITUCION`,
  `GALICIA_PRODUCTOR`, `GALICIA_PRODUCTO`, `GALICIA_STORE`

## Archivos que se entregan
```
netlify/functions/provincia-cot.js
netlify/functions/parana-cot.js
netlify/functions/mercantil-cot.js
netlify/functions/digna-cot.js
netlify/functions/galicia-cot.js
netlify/functions/infoauto.json          (códigos InfoAuto — Digna y Galicia; ~780 KB)
netlify/functions/parana_vehiculos.js    (códigos propios de Paraná; ~467 KB)
netlify/functions/parana_cp.json         (CP → SubCódigo postal de Paraná)
netlify/functions/infoauto-list.js       (listado auxiliar de marcas/modelos)
netlify.toml                              (config de functions + redirects + headers CORS)
```
Y en el HTML: el array `CO_CIAS`, la función que cotiza en paralelo (`coCotizar`) y el render
de planes. Contrato de cada función: `{ opciones:[{plan,cobertura,premio,suma}], error? }`.

## Estado actual
- **Producción sin depender de variables**: Provincia (25%) y Paraná (bonificación 0).
- **Testing salvo que estén cargadas las variables**: Mercantil (`MERCANTIL_HOST`),
  Digna (`DIGNA_BASE_URL`), Galicia (`GALICIA_BASE`).
- Pendiente comercial: definir valores/recargos reales para Provincia y Digna.
- Pendiente técnico: zona de riesgo real en Galicia (hoy default Buenos Aires).

## Cómo se lo paso a otro chat/proyecto
1. Copiá este documento como contexto (explica el diseño y los "gotchas").
2. Sumá los archivos de `netlify/functions/` + `netlify.toml` (y el snippet `CO_CIAS`/`coCotizar` del HTML).
3. Para agregar una compañía nueva: una línea en `CO_CIAS` + una función proxy que devuelva
   `{ opciones:[{plan,cobertura,premio,suma}] }`.
