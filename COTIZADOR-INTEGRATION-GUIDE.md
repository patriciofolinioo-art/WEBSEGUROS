# Multi-Company Car Insurance Quoting — Integration Guide (for Claude)

> **Purpose.** This document tells an AI assistant (Claude) how to integrate real-time
> car‑insurance quotes from five Argentine insurers into a system, exactly the way it
> was done for the San Isidro Seguros website. It captures the working request/response
> shapes **and the hard‑won gotchas** (the things that are not in any manual and that
> took many iterations to discover). Follow it closely — most insurer APIs fail with
> cryptic errors until the payload is *exactly* right.

Language: everything below is in English on purpose (clearer for the model). The data
and comments in the real code are in Spanish; that's fine.

---

## 1. Architecture overview

- One **serverless function per insurer** (Netlify Functions / AWS Lambda style). Each
  function is a thin proxy: it receives one normalized quote request, talks to the
  insurer API, and returns a **normalized response**. The frontend calls all insurers
  **in parallel** and renders results as each one answers.
- **Never put credentials in the code or the repo.** All secrets live in environment
  variables. (One legacy exception exists in this codebase — a hardcoded Provincia
  `CLIENT_SECRET`/`API_KEY`; treat that as tech debt to move to env, not as a pattern.)
- The vehicle is the hard part. **InfoAuto** (`código InfoAuto`) is the industry‑standard
  vehicle catalog in Argentina. Most insurers accept the InfoAuto code directly; the two
  that don't (Paraná, Provincia) are matched by *name*.

### 1.1 Normalized request (what every function receives)

A single JSON object (called `_coDat` in the frontend). Fields:

```jsonc
{
  "nombre": "Juan Pérez",        // optional, for lead/display
  "dni": "30111222",             // optional
  "nac": "1990-06-15",           // YYYY-MM-DD (date of birth)
  "genero": "M",                 // "M" | "F"
  "marca": "Volkswagen",         // brand (InfoAuto brand name, uppercase-insensitive)
  "modelo": "GOL TREND 1.6 L/17",// full InfoAuto VERSION name (see §2)
  "anio": "2019",                // model year (string or number)
  "cp": "1636",                  // postal code (CABA/Prov. BA etc.)
  "uso": "particular",           // "particular" | "comercial"
  "gnc": "no",                   // "si" | "no"
  "gnc_monto": 0,                // insured value of the GNC kit, if any
  "infoautoCod": "0460925",      // InfoAuto code (7 chars, zero-padded) — see §2
  "infoautoTipo": 1              // InfoAuto vehicle type (t field)
}
```

### 1.2 Normalized response (what every function returns)

```jsonc
{
  "ok": true,
  "opciones": [
    {
      "plan": "C7",                          // insurer plan/coverage code
      "cobertura": "Terceros Completo Full", // human label
      "premio": 143000,                      // MONTHLY price in ARS (see Galicia gotcha §6)
      "suma": 16000000,                      // insured sum (vehicle value)
      "grupo": "flagship"                    // "rc" | "flagship" | "todoriesgo" | "otro"
    }
  ]
}
```

On any failure return HTTP 200 with `{ "error": "<message>", "opciones": [] }` — the
frontend treats a company with no options as "no price" and still shows the others.
**Never let one insurer's failure break the others.** Each function must swallow its own
errors and return the normalized shape.

`grupo` classification (used to group results as RC / Terceros Completo / Todo Riesgo):
- `rc` — Responsabilidad Civil only
- `flagship` — the best "Terceros Completo" per company (shown as the headline mid tier)
- `todoriesgo` — Todo Riesgo (all variants shown)
- `otro` — intermediate tiers (hidden)

Prefer classifying on the **server** (set `grupo`) when the insurer gives a clean code;
otherwise the frontend guesses from text.

---

## 2. The vehicle problem — InfoAuto + year filtering (read this first)

**The #1 source of failures was the vehicle.** A quote fails when the vehicle code does
not correspond to the model year. Example: a 2015 car matched to a 2008 or 2016 "line"
makes the insurer reject the quote.

Rules that work:

1. **InfoAuto is the shared key.** `infoauto.json` is `{ "BRAND": [ { n, c, t } ] }` where
   `n` = version description (e.g. `"GOL TREND 1.6 L/17"`), `c` = InfoAuto code
   (7‑char **zero‑padded string**, e.g. `"0460925"`), `t` = vehicle type id.
2. **Codes are zero‑padded strings.** Some APIs return the code as a number (`460925`).
   Always normalize to the 7‑char zero‑padded string to match `infoauto.json`
   (`String(n).padStart(7,'0')`), *except* where an API wants a numeric — then `Number()`
   it at the edge (Mercantil does `Number(code)`).
3. **Year filtering must happen server‑side.** The local `infoauto.json` has **no year**.
   Mercantil's catalog *does* filter by year. So the version dropdown is populated from a
   dedicated endpoint (`mercantil-vehiculos`) that calls Mercantil `/vehiculos/v1/?q=…&anio=…`
   and returns only versions valid for that year — **but maps each result back to the
   canonical `infoauto.json` entry** so the name is clean and the code is zero‑padded.
   This single step fixed year mismatches across *all* insurers at once.
4. **Line‑year tag `L/XX`.** InfoAuto/insurer names often embed the generation/line year
   as `L/15`, `L/22`, etc. Parse it with `/\bL\/\s*(\d{2})\b/i` → `2000+YY`. Use it to
   reject lines *newer* than the requested year, and to prefer the closest line ≤ year.
5. **Strip the brand prefix before name‑matching.** Depending on the catalog source, a
   version arrives as `"GOL TREND 1.6"` (InfoAuto) **or** `"VOLKSWAGEN GOL TREND 1.6"`
   (Mercantil). Insurers that match by *name* (Paraná, Provincia) take the **first token
   as the model**; if it's `"VOLKSWAGEN"` nothing matches and the quote silently fails.
   Always strip the leading brand (full brand, and the first word of multi‑word brands
   like `ALFA ROMEO`, `MERCEDES BENZ`) before matching.

### 2.1 `mercantil-vehiculos` (version dropdown source)

`GET …?marca=&modelo=&anio=` → `{ ok, versiones:[ { n, c, t } ] }`, year‑filtered,
deduped, names clean (no brand), codes zero‑padded. Build it by:
- login to Mercantil (see §4), `GET /vehiculos/v1/?q=<brand + first 2 words of model>&anio=<YYYY>&tipo=AUTO&limit=50`
- for each result take its InfoAuto code, look it up in `infoauto.json` by numeric key,
  and emit the **canonical** `{ n, c, t }`; fall back to the Mercantil name (brand stripped)
  + zero‑padded code if the code isn't in the local file.
- drop lines whose `L/XX` is newer than `anio`.
- Frontend adds a **3.5 s timeout + in‑memory cache** keyed by `marca|modelo|anio`; on
  timeout it falls back to the plain (static) InfoAuto list filtered by `L/XX`.

---

## 3. Provincia Seguros (REST, OAuth password grant) — name‑matched

- Auth: `POST https://authp.provinciaseguros.com.ar/auth/realms/ps/protocol/openid-connect/token`
  with `grant_type=password, client_id=ps2, client_secret=<env>, username=<env>, password=<env>`
  → `access_token`.
- All catalog/quote calls carry header `Authorization: Bearer <token>` **and** `apikey: <API_KEY>`
  and `?apikey=<API_KEY>` on the URL.
- Vehicle is resolved against **Provincia's own catalog, by year**:
  - brand: local `MARCA_MAP` (name→code, e.g. `Volkswagen→VOL`), else `GET /valores/marcas/4/<producto>`.
  - model: `GET /valores/modelo/4/<producto>/<marcaCod>/<anio>/N` then **token‑match** the
    InfoAuto version name to a catalog description. Matching rules (critical):
    - **Do not drop the model number.** For Peugeot/Fiat/BMW/Alfa/BAIC the model *is* a
      number (208, 147, 320, "X 55"). Keep the first token even if numeric, weight it ×10,
      and disambiguate with the remaining tokens. (Dropping `55` made `X 55` match `X 25`
      → a *different, cheaper* car → wildly different insured sum.)
    - Strip brand prefix first (§2.5).
- Quote: `POST /PS/PS-COTIZACION/2.2/cotizar` with a `bien` object. Key fields:
  `ramoProducto:{ramo:"4",producto:"04100"}`, `40020_marca`, `40021_modelo`, `40012_anio`,
  `40008_uso` (1 particular / 42 comercial), `40220_ValorDelVehiculo` (0 = let Provincia
  value it), `900008_codPostal`, `40088_bonifAdicional`, `modoDeCalculo:"N"`.
- **Commission / discount lever:** field `40088_bonifAdicional` takes a **table code, not a
  percent** (1=none, 2=5%, 3=10%, **4=15%**, 5=20%, 6=25%). Sending the raw percent is
  silently ignored. Lower effective price = raise this code (within what the account allows).
- Response: read insured sum from any of `sumaAsegurada|valorAsegurado|capitalAsegurado|
  valorVehiculo`, premios per plan/promo; push `{plan,cobertura,premio,suma}`.
- Env: `PROVINCIA_USER`, `PROVINCIA_PASS` (client_secret/api_key currently hardcoded — move to env).

---

## 4. Mercantil Andina (REST, OAuth password grant) — InfoAuto code

- Host: `MERCANTIL_HOST` (`https://apidev.mercantilandina.com.ar` test / `https://api.mercantilandina.com.ar` prod).
- Auth: `POST /credenciales/v2` urlencoded `client_id=api-clientes-login, grant_type=password,
  username, password`, header `Ocp-Apim-Subscription-Key: <MERCANTIL_SUBKEY>` → `access_token`.
  Cache the token (~8 min). All calls send `Authorization: Bearer <token>` + the subscription key.
- Vehicle: `GET /vehiculos/v1/?q=<brand + first 2 words of model>&anio=<YYYY>&tipo=AUTO&limit=20`
  → `{ datos:[ { nombre, infoauto, codigo } ] }`. Pick by GNC mention → exact name → best
  token+year score. Return the **`infoauto`** code (that's what the quote wants).
  - Query length: Mercantil rejects long `q` (HTTP 400 ERR0014). Cap `q` at ~40 chars.
  - If the frontend already resolved `infoautoCod`, use it directly (skip the search).
- Quote: `POST /cotizaciones/v2/auto` with `vehiculo:{ infoauto:Number(code), anio, uso(1/2),
  gnc, rastreo:0 }`, `comision`, `bonificacion:0`, `periodo:1`, `cuotas:1`, `pago:{tipo_pago:"D"}`,
  `iva:5`, `desglose:true`, `productor:{id:<MERCANTIL_PRODUCTOR>}`, `localidad:{codigo_postal}`.
- **Commission:** `MERCANTIL_COMISION` must be one of **10/20/25/30** (others → MCA008).
  `bonificacion` **must be 0** for this account. Lower commission = cheaper.
- Response: `resultado[]`; premio = `desglose.total.premio` (or `costo`); skip items with
  `error` or premio ≤ 0. Controlled errors come back HTTP 409 `{errores:[{mensaje_error}]}`.
- Env: `MERCANTIL_USER/PASS/SUBKEY/PRODUCTOR`, optional `MERCANTIL_HOST/CLIENT_ID/COMISION`.

---

## 5. Paraná Seguros (SOAP / GeneXus) — own vehicle base, year‑line matching

- Endpoint: `POST <BASE>/servlet/ar.com.glmsa.seguros.comercial.awscotizarautomotores`
  (`BASE` prod `https://productores.paranaseguros.com.ar/PARANA_COMERCIAL_PROD`).
  Method `WSCotizarAutomotores.Execute`, `SOAPAction: http://tempuri.org/action/AWSCOTIZARAUTOMOTORES.Execute`,
  `Content-Type: text/xml`. Build the envelope by hand; escape XML entities.
- Vehicle uses **Paraná's own codes** from a static table (`parana_vehiculos.js`:
  `{ BRAND: { codMarca, modelos:[ {cod, nombre} ] } }`). There is **no year** in this table,
  and Paraná **validates the vehicle↔year relationship** server‑side. So:
  - **Rank candidates, don't pick one.** Score models by: exact match ≫ model‑head match
    (first token, space‑insensitive so `ECOSPORT`↔`ECO SPORT`, `C3`↔`C 3`) ×10 ≫ trailing
    tokens, **plus a year score from the `L/XX` line tag** (bonus for the closest line ≤ year,
    heavy penalty for a line *newer* than the requested year). Require the head to match.
  - **Try candidates in order** until Paraná accepts the year. The telltale error is
    `"La relación vehículo - año de fabricación no es válida"` → try the next candidate.
    (A 2018 Gol must hit the `GOL … TREND L/17` code, not the old `GOL GL` code.)
  - Strip brand prefix first (§2.5). If the brand/model isn't in the base, return "not found"
    rather than quoting a different car.
- Payload fields mirror Paraná's official example exactly (ends at `PoseeEquipoGNC`; the extra
  WSDL fields are **omitted**). Key: `SistemaOrigen`, `ProductorCodigo`, `CodigoPostal` +
  `SubCodigoPostal` (must be a valid sub‑CP, never 0 — keep a CP→subCP map), `MarcaCodigo`,
  `ModeloCodigo`, `AnioFabricacion`, `PoseeEquipoGNC` (`S`/empty).
- **Discount lever:** `ModificarBonificacion='S'` + `BonificacionPorc=<n>`, but only if the
  productor's *origen* allows it; otherwise it errors and you must retry with bonif 0.
- Response parsing is heuristic (no RESPONSE example in the manual): split by `<Item>`, read
  `<Cobertura>` (code), `<CoberturaDesc>`, `<Premio>` / `<ImporteCuota1>`, `<SumaAsegurada>` /
  general `<ValorAseguradoVehic>`. Classify by first code letter: `A`=rc, `C`/Oro/Platino=flagship,
  `D`=todoriesgo, `B`=otro.
- **Data staleness:** the static base only goes up to line ~2022; brand‑new models/years won't
  quote. Refresh it from Paraná (Excel export) or, better, a "list vehicles" API if they expose one.
- Env: `PARANA_SISTEMA_ORIGEN`, `PARANA_PRODUCTOR`, optional `PARANA_BASE`, `PARANA_PLAN`,
  `PARANA_BONIFICACION`, `PARANA_VIGENCIA_DESDE`.

---

## 6. Galicia Seguros (REST, "Technical Pricing" v3) — the fiddly one

This one needs *everything* exactly right or it returns a single cryptic error. Order of
blockers we hit (each unblocks the next):

1. **API version header.** `Accept: application/json;version=3` on the quote call, or you get
   `Version1.TechnicalPricing doesn't exist`. Do **not** also add `/v3/` to the path.
2. **Token.** `POST <BASE>/…/token`; use the returned `token_type` **verbatim, lowercase**
   (`bearer`, not `Bearer`) in `Authorization`. Header `Store: B2B`.
3. **CodigoProducto (per productor).** `ProductoComercial:{ Comision, IdProductor, CodigoProducto }`.
   `CodigoProducto` is a **positive integer assigned by Galicia to the productor** — it is **not**
   the same as `IdProductor`. Missing it → `El campo 'CodigoProducto' es un entero positivo obligatorio`.
4. **CodigoPostal must resolve to a real province/locality.** Sending fixed `IdProvincia/IdLocalidad=1`
   with any CP → `El campo 'CodigoPostal' debe estar dentro de los CodigosPostales posibles`. Build a
   **CP → {provincia, localidad}** map from Galicia's conversion table (sheet `Localidad`:
   `Cod_Provincia | Cod_Localidad | Descripcion | CodigoPostal`) and use it for both the Tomador
   `Domicilio` and the `ItemAuto.ZonaDeRiesgo`.
5. **`Origen`** (top level, integer). Galicia assigns it; send it. Missing it doesn't always error
   but is required for correct pricing.
6. **Tomador shape (AutoMapper is strict).** Error `Error mapping types … Property: Tomador` means
   the Tomador object doesn't match Galicia's `PersonaFisica` model. It must be, **exactly**:
   - `$type` = `Motor.Areas.SeguroNuevo.Version3.TechnicalPricing.Models.Cotizacion.Input.PersonaFisica, Motor, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null`
   - `Domicilio` is a **single object** `{ CodigoPostal, IdProvincia }` — **not** an array `Domicilios`.
   - `eMail` with that exact casing (not `Email`).
   - `IngresosBrutos` is **mandatory**: `{ CuitIngresosBrutos, IdIngresosBrutos }`. For a
     "Consumidor Final" use `IdIngresosBrutos:0` (NO INSCRIPTO), `CuitIngresosBrutos:0`.
   - Include `IdCondicionFiscal` (4 = Consumidor Final), `Sexo`, `Nombre`, `Apellido`,
     `FechaNacimiento`, `IdEstadoCivil`, `Telefonos:[…]`. **Do not** send `Documentos` here.
   - `IdInfoAuto` as the zero‑padded string; `ItemAuto.ZonaDeRiesgo` keeps `IdLocalidad`.
7. **Premio is ANNUAL.** Technical Pricing returns `ProductosTecnicos[].PremioTotal` as a **yearly**
   premium. The UI shows monthly like the others, so **divide by 12**. (Sanity check: RC yearly
   1,016,444 / 12 ≈ 84,700, which matches the other insurers' monthly RC.)
- **Commission lever:** `GALICIA_COMISION` (default 22 per Galicia). Lower = cheaper.
- Classify by first code letter: `A`=rc, `C`=flagship, `D`=todoriesgo, else otro.
- Env: `GALICIA_USER/PASS/INSTITUCION/PRODUCTOR/PRODUCTO/CODIGO_ORIGEN`, optional
  `GALICIA_BASE` (prod `https://productores.galiciaseguros.com.ar`), `GALICIA_COMISION`.

---

## 7. Digna (REST) — InfoAuto code, fully local vehicle resolution

- Base `DIGNA_BASE_URL` (`…/dcxapi/api/v1`). Auth `POST /Seguridad/authenticate` → `payload.session_token`
  (Bearer, cached). Quote `POST /CotizacionAutos/cotizar`.
- Vehicle resolved **100% locally** from `infoauto.json`: send `{ c: infoautoCod, t: infoautoTipo||1 }`.
  If `infoautoCod` is present (from the dropdown) use it directly.
- Vigencia must start today (not past), lasts 1 year.

---

## 8. Hard‑won lessons (the checklist that saves days)

1. **Credentials only in env vars.** Never in code/repo. Never collect CBU/credit‑card on a web
   form — take payment data out‑of‑band (WhatsApp/phone) and store only a payment *method* choice.
2. **InfoAuto codes are zero‑padded strings.** Normalize everywhere; `Number()` only at the API edge
   that demands it.
3. **Filter versions by year at the source** (Mercantil catalog) and map back to canonical InfoAuto —
   this fixes year‑mismatch failures for every insurer at once.
4. **Strip the brand prefix** before any name‑based vehicle matching (Paraná, Provincia).
5. **Keep numeric model tokens** when matching (`208 ≠ 207`, `X 55 ≠ X 25`); weight the model head.
6. **Paraná: rank + retry candidates** against the `vehículo‑año` error using the `L/XX` line tag.
7. **Galicia: Tomador shape is exact** (Domicilio object, IngresosBrutos required, `eMail`, CodigoProducto,
   Origen, CP→localidad) and **premio ÷ 12**.
8. **Commission is the price lever** per insurer (Provincia `40088` *code* not percent; Mercantil
   10/20/25/30; Paraná `BonificacionPorc` if origen allows; Galicia `Comision`). Lower = cheaper.
9. **One insurer's failure must never break the others.** Each proxy returns `{error,opciones:[]}` on
   failure; the frontend fans out in parallel and renders progressively.
10. **Add a per‑call timeout + client cache** for the live catalog lookups so a cold/slow insurer
    doesn't hang the UI.
11. **Expose a `?debug=1` GET** on each proxy that returns the exact request sent and the raw insurer
    response. This is how every one of the above was diagnosed. Keep it, guard it if needed.
12. **Vehicle data goes stale** (esp. Paraná's static base): brand‑new models won't quote; plan to
    refresh from each insurer's catalog.

---

## 9. What to ask the insurer for (so integration doesn't stall)

- **Provincia:** PS2 user/pass; confirm product `04100`, ramo `4`; allowed `bonifAdicional` code.
- **Mercantil:** user/pass, `Ocp-Apim-Subscription-Key`, productor id, allowed commission values, prod host.
- **Paraná:** `SistemaOrigen`, productor code; whether the origen allows modifying bonificación; a
  vehicle‑list method or an up‑to‑date vehicle Excel; CP→subCP table.
- **Galicia:** user/pass, `IdInstitucion`, `IdProductor`, **`CodigoProducto`**, `Origen`; confirm PRE vs
  PROD base; the conversion tables workbook (Provincia/Localidad/CondicionFiscal/IngBrutos/etc.).
- **Digna:** base URL (test vs prod), credentials.
