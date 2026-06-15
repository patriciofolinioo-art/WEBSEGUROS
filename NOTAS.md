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

- [ ] **Sumar más compañías** al cotizador: en `CO_CIAS` (index.html y cotizar.html) se
      agrega una línea por compañía nueva, y se crea su proxy en `netlify/functions/`
      (ej. `mercantil-cot.js`) que devuelva `{ opciones:[{plan,cobertura,premio}] }` igual
      que provincia-cot. Después definir cómo aplica descuentos cada una.

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
