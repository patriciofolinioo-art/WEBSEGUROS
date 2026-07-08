# WebSeguros — Estado y pendientes

## ✅ Hecho (ya commiteado y pusheado)

1. **WhatsApp** → cambiado a **11 5452-2619** (`5491154522619`) en todo el sitio
   (index.html y cotizar.html: hero, footer, botones de contacto y cotizador).

2. **Año de nacimiento** → el cotizador pide solo el **año** (antes pedía fecha completa).
   Internamente arma la fecha `AAAA-06-15`. La función `provincia-cot` NO usa la fecha de
   nacimiento, así que no afecta los precios.

3. **Auto en 3 pasos: Marca → Modelo → Versión** → antes modelo y versión iban juntos.
   Ahora se separan agrupando la base de Paraná por modelo base → versiones.
   Lógica en `coModelosDe()` (en index.html y cotizar.html): junta compuestos reales
   (Land Cruiser, Eco Sport, Grand Vitara, Santa Fe…) y evita falsos compuestos por
   equipamiento (lista `CO_TRIMS`).

4. **Descuento Provincia** → en `netlify/functions/provincia-cot.js` se agregó la constante
   `BONIF_ADICIONAL = 25` (campo `40088_bonifAdicional`), para cotizar con 25% de descuento.
   La comisión (20%) la toma de la cuenta del productor (credenciales en variables de
   entorno de Netlify), no va en el payload.

## ⏳ Pendiente

- [ ] **Subir a Netlify** el deploy con el 25% (`webseguros-CON-25-descuento.zip`).
      Nota: la sesión NO pudo desplegar automáticamente (Netlify devuelve 403). Hay que
      hacer drag & drop manual en https://app.netlify.com/projects/sanisidroseguros/deploys
      (incluir SIEMPRE la carpeta `netlify/functions/` o se rompe el backend de precios).

- [ ] **Verificar el descuento**: cotizar Ford Focus 2.0 SE 2015 en la web y comparar con
      el portal PS2. Referencia portal (con 25% desc + 20% comisión):
      PSPLUS Plan 22 = $124.385 · PSTOTAL Plan 22 = $169.725 · PSTOTAL Plan 2 = $148.603.

- [ ] **Ajuste fino del precio** (si no queda igual al portal): el "Precio Promocional" del
      portal mezcla 25% + promo propia de Provincia + suma asegurada exacta. Para clavarlo,
      capturar el payload + respuesta que manda el portal (F12 → Network) y replicarlo.
      Posible causa de diferencia: la web manda `40220_ValorDelVehiculo` en 0 (no se pide
      suma asegurada), y Provincia usa su valuación por defecto.

- [x] **Mercantil Andina** agregada (`mercantil-cot.js`). **DESACTIVADA en el cotizador**
      (línea comentada en `CO_CIAS`, index.html y cotizar.html) hasta destrabar el acceso.
      Diagnóstico 07/2026 (con el debug ?debug=1, ya quitado): login OK (da token), busca y
      **encuentra el vehículo** OK, pero al cotizar en `apidev.mercantilandina.com.ar` devuelve
      **HTTP 403 · MCA007: "No cuenta con permisos para cotizar con esta cuenta de productor"**
      (productor.id 87139). Las 4 env vars están cargadas y la suscripción "FOLINTST" figura
      Active. O sea: la API abre, pero el productor 87139 NO está habilitado para cotizar en el
      entorno de test. **Bloqueado del lado de Mercantil.**
      **Para destrabar:** que Mercantil (a) habilite al productor 87139 para cotizar, o (b) dé
      acceso a **producción** (URL + suscripción/subkey productivos). Cuando eso esté:
      - [ ] Pasar `HOST` a producción en `mercantil-cot.js` (hoy `apidev.mercantilandina.com.ar`).
      - [ ] Descomentar la línea de Mercantil en `CO_CIAS` (index.html y cotizar.html).
      - [ ] Confirmar código de **uso comercial** (`USO_COMERCIAL`, hoy 2).

- [x] **Provincia — verificado OK (07/2026)**. Con el debug se confirmó que la web SÍ aplica
      las promociones (`PSPLUS`/`PSTOTAL`) y lee el `premio` correcto. NO había bug de precio
      inflado: la web usa la API `PS-COTIZACION/2.2/cotizar` que devuelve `planes[].promocionesPorPlan[].premio`
      (formato distinto al del portal `{content:[importe_premio_1]}`). De hecho sale más barata
      que el portal porque manda `40220_ValorDelVehiculo=0` y Provincia usa su valuación por
      defecto. El parser quedó reforzado para tolerar ambos formatos.

- [x] **Digna Seguros agregada** (`digna-cot.js` + `infoauto.json` + línea en `CO_CIAS`,
      color naranja). Resuelve el vehículo 100% local contra `infoauto.json` (códigos
      InfoAuto). Descuento 20% (código 29) — se bajó de 30% (29+25) para alinear con
      Provincia/Mercantil, porque Digna salía demasiado barato. 99/102 marcas de Paraná matchean con
      infoauto (no matchean: Land Rover, I.k.a., Jac).
      **Falta para que funcione en vivo:** variables de entorno en Netlify
      `DIGNA_USER`, `DIGNA_PASS`, `DIGNA_BASE_URL` (testing/desarrollo), y confirmar
      `DIGNA_COD_PRODUCTOR`. Hoy apunta a testing (`equiswebtest.digna.seg.ar`).

- [x] **Filtro de versiones por año** en el cotizador (`coExtraerAnioVersion` +
      `coAnioChange`): al elegir año, oculta versiones cuyo tag "L/XX" es posterior.
      ⚠️ El zip original venía con un BUG (faltaba `function coModeloChange(){`) que rompía
      TODO el cotizador — se corrigió y se conectó el filtro en ambos archivos.

- [x] **Panel Productor** agregado en `index.html`. Acceso via link "Panel" en el footer.
      Login con Firebase email/password. Muestra hasta 40 solicitudes recientes de
      `cotizaciones_web` y 30 denuncias de `siniestros_web` con botón de WhatsApp directo.
      ⚠️ Requiere que las reglas de Firestore permitan leer `cotizaciones_web` y
      `siniestros_web` al productor autenticado (email/password auth).

- [x] **Fix cotizar.html `_productores`**: antes era estático (sanisidroseguros@yahoo.com.ar).
      Ahora carga dinámicamente desde Firebase igual que `index.html`, con `initApp()` y
      `signInAnonymously()`. También se agregó `firebase-auth-compat.js` y se actualizó
      la versión de Firebase SDK a 9.22.2 (consistente con index.html).

- [ ] **Sumar más compañías**: misma receta — línea en `CO_CIAS` + proxy en
      `netlify/functions/` que devuelva `{ opciones:[{plan,cobertura,premio,suma}] }`.

- [x] **Filtro EXACTO de versiones por año (API Provincia)**: al elegir Marca→Año→Modelo,
      las versiones se traen en vivo de Provincia (`listarModelos` por marca+año), agrupadas
      con `coAgrupar`. Cache por `marca|anio` y anti-carrera. Si la API falla, cae a la base
      estática de Paraná con el filtro heurístico "L/XX". El modelo elegido lleva `provcod`
      (código exacto de Provincia) para la cotización. En index.html y cotizar.html.

- [x] **Área de clientes por DNI → función serverless `cliente-dni.js`**. Antes el sitio
      leía TODA la base `sanisidro/datos` desde el navegador (con login anónimo), lo que:
      (a) fallaba con `Missing or insufficient permissions` si las reglas no lo permitían
      → el siniestro "no encontraba el DNI"; y (b) si se abría la regla, exponía TODA la
      base (DNIs, teléfonos, pólizas de todos) públicamente.
      Ahora `sinLogin()` llama a `/.netlify/functions/cliente-dni` mandando SOLO el DNI.
      La función lee Firestore del lado del servidor (REST API + service account, sin
      dependencias npm) y devuelve únicamente ESE cliente + sus pólizas vigentes + las
      compañías de esas pólizas. La base queda privada.
      También se sacó el read de `sanisidro/datos` de `initApp()` en index.html y cotizar.html
      (ya no hace falta; se mantiene `signInAnonymously()` para poder escribir en
      `siniestros_web` / `solicitudes_web` / `cotizaciones_web`). Eso elimina el error de
      permisos de la consola.
      **Falta para que funcione en vivo:** cargar en Netlify las variables de la service
      account de Firebase (ver abajo). Las reglas de Firestore pueden seguir NEGANDO la
      lectura anónima de `sanisidro/datos` — es lo deseado.

## 🔑 Variables de entorno por compañía (Netlify → Environment variables)
- **Provincia**: `PROVINCIA_USER`, `PROVINCIA_PASS`
- **Mercantil**: `MERCANTIL_USER`, `MERCANTIL_PASS`, `MERCANTIL_SUBKEY`, `MERCANTIL_PRODUCTOR`, `MERCANTIL_LOGIN_URL`
- **Digna**: `DIGNA_USER`, `DIGNA_PASS`, `DIGNA_BASE_URL`, `DIGNA_COD_PRODUCTOR`
- **Firebase (área de clientes)**: `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`
  (y opcional `FIREBASE_PROJECT_ID`, ya viene con `base-seguros-f5144` por defecto).
  Se sacan del JSON de una **service account** de Firebase:
  Firebase console → Configuración del proyecto → Cuentas de servicio → Generar nueva clave
  privada. Del JSON: `client_email` → `FIREBASE_CLIENT_EMAIL`; `private_key` → `FIREBASE_PRIVATE_KEY`
  (pegar tal cual, con los `\n`).

## 🔐 Seguridad (a revisar cuando se pueda)

- `provincia-cot.js` tiene `API_KEY` y `CLIENT_SECRET` hardcodeados. Conviene moverlos a
  variables de entorno de Netlify (como ya están `PROVINCIA_USER` / `PROVINCIA_PASS`).

## 📁 Estructura del deploy (lo que va en Netlify)

```
index.html
cotizar.html
netlify.toml
netlify/functions/provincia-cot.js
parana_vehiculos.js   (base de datos, opcional)
```
