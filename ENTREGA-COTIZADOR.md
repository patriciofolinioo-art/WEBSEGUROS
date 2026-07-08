# Cotizador multi-compañía — Entrega para integrar en otro sistema

Este documento describe un **cotizador de seguros de auto multi-compañía** ya funcionando
(Provincia, Digna y Mercantil). Está pensado para que otro proyecto/chat lo integre sin
tener que redescubrir los problemas que ya resolvimos (que fueron varios).

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

## Las 3 funciones (netlify/functions/)

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
- **HOY apunta a TEST** (`apidev.mercantilandina.com.ar`) → devuelve **precios de prueba
  viejos** (no reales). Para producción: cambiar la constante `HOST` a la URL productiva y usar
  subkey/productor de producción.
- Env vars: `MERCANTIL_USER`, `MERCANTIL_PASS`, `MERCANTIL_SUBKEY` (Ocp-Apim-Subscription-Key),
  `MERCANTIL_PRODUCTOR` (id; en test = 15056), `MERCANTIL_LOGIN_URL` (opcional).

---

## Variables de entorno (Netlify → Environment variables)
- **Provincia**: `PROVINCIA_USER`, `PROVINCIA_PASS`
- **Digna**: `DIGNA_USER`, `DIGNA_PASS`, `DIGNA_BASE_URL`, `DIGNA_COD_PRODUCTOR`
- **Mercantil**: `MERCANTIL_USER`, `MERCANTIL_PASS`, `MERCANTIL_SUBKEY`, `MERCANTIL_PRODUCTOR`, `MERCANTIL_LOGIN_URL`

## Archivos que se entregan
```
netlify/functions/provincia-cot.js
netlify/functions/digna-cot.js
netlify/functions/mercantil-cot.js
netlify/functions/infoauto.json      (base de vehículos para Digna — pesada, ~780 KB)
netlify.toml                          (config de functions + redirects + headers CORS)
```
Y en el HTML: el array `CO_CIAS`, la función que cotiza en paralelo (`coCotizar`) y el render
de planes. Contrato de cada función: `{ opciones:[{plan,cobertura,premio,suma}], error? }`.

## Estado actual
- Provincia (25%) y Digna (20%): cotizan OK con precios reales.
- Mercantil: cotiza OK pero en **TEST** (precios de prueba) hasta tener la URL de producción.
- Pendiente comercial: definir valores/recargos reales para Provincia y Digna.

## Cómo se lo paso a otro chat/proyecto
1. Copiá este documento como contexto (explica el diseño y los "gotchas").
2. Sumá los archivos de `netlify/functions/` + `netlify.toml` (y el snippet `CO_CIAS`/`coCotizar` del HTML).
3. Para agregar una compañía nueva: una línea en `CO_CIAS` + una función proxy que devuelva
   `{ opciones:[{plan,cobertura,premio,suma}] }`.
