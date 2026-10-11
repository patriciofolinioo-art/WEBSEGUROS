# Vehicle‑Matching Problems & How to Handle Them (for the system / Claude)

> Companion to `COTIZADOR-INTEGRATION-GUIDE.md`. This note documents a **class of bugs**
> that only affect insurers whose quote proxy resolves the vehicle by **name against the
> insurer's own catalog** (in our stack: **Provincia** and **Paraná**). Insurers that take
> the **InfoAuto code** directly (Mercantil, Galicia, Digna) are immune to these.
>
> Symptom in all cases: **the quote returns, but for the wrong vehicle or a wrong value** —
> the price looks "off" (usually a wrong/low `suma asegurada`). These are silent: no error,
> just a bad number. Treat any large `suma` disagreement between insurers as a red flag.

---

## 0. Golden rule — always compare the RESOLVED vehicle to the REQUESTED one

Every name‑matching proxy must expose, in its `?debug=1` output, **the vehicle the insurer
actually quoted** (Provincia returns it in `bienesCotizados[].bien`; Mercantil in
`vehiculo.nombre`). The diagnostic is always: *does the resolved brand/model match what the
user asked for?* If a user asks for a **Chery Tiggo 3** and the resolved line says
**Chevrolet Agile**, the matcher is broken — not the insurer.

Build this comparison into QA: for a sample of makes/models, assert that the resolved
vehicle's **brand token** and **model token(s)** appear in the requested string.

---

## 1. Problem A — Brand‑code collisions (two brands → same code)

**Real case.** A Chery Tiggo 3 was being quoted as a **Chevrolet Agile**. Root cause: a
hardcoded brand map had `Chevrolet → "CHE"` **and** `Chery → "CHE"`. Selecting *Chery* sent
Chevrolet's code; the insurer then matched "Tiggo 3 Luxury" inside *Chevrolet's* models and
picked the closest thing (an Agile) — a completely different car with a different value.

**Fix.**
1. **Never hardcode an ambiguous or guessed brand code.** If you're not certain a brand's
   code is unique and correct, **leave it out** of the local map and resolve it **live** from
   the insurer's brand list (`GET …/marcas/...` → match by name). Wrong‑but‑present is worse
   than absent: absent falls back to a correct live lookup; present silently quotes another brand.
2. **Assert there are no duplicate codes** in any hardcoded brand map (a one‑line test: group
   by code, fail if any code maps to >1 brand). We had exactly one collision (`CHE`) and it
   caused this bug.
3. If the live lookup can't find the brand, return "not found" (no quote) — **better than
   quoting the wrong brand.**

---

## 2. Problem B — Model‑designation numbers get dropped ("Tiggo 3", "Mazda 3", "Serie 3")

**Real case.** After fixing the brand, *Chery Tiggo **3** Luxury* matched the **older Tiggo
2.0 Luxury (L/13)**, because the **`3`** in "Tiggo 3" was being discarded as noise. For many
brands the model is **`<word> <number>`** (Tiggo 2/3/5/8, Mazda 3/6, BMW Serie 1/3/5,
Audi A1/A3/A4, Citroën C3/C4, Peugeot 208/308) — dropping that number makes the matcher
unable to tell the trims apart.

**Root cause.** A "noise" filter that strips standalone digits (meant to remove door counts
like `4`, `5`, `PTAS`) also strips the model number when it's a separate token.

**Fix (token policy for name matching).**
- **Keep the first two tokens always** (`model head` + its immediate `designation`); only apply
  the noise filter from the **3rd token onward**. So `TIGGO 3 LUXURY` keeps `TIGGO` and `3`.
- **Weight the model head ×10** and require it to match; use the remaining tokens to pick the
  trim/variant. The designation number (`3`) then separates "Tiggo 3" from "Tiggo"/"Tiggo 5".
- **Short heads combine with the next token.** If the first token is ≤2 chars (`X`, `A`, `C`,
  `DS`), glue the second to it (`X 55 → X55`, `A 3 → A3`) so it matches space‑insensitively.
- **Keep numeric model tokens.** Do **not** strip a number that is the model itself (`208`,
  `320`, `147`, `55`) — stripping it made `X 55` match `X 25` (a cheaper car → wrong value).
- Compare the head **space‑insensitively** (`ECOSPORT` ↔ `ECO SPORT`, `C3` ↔ `C 3`).

**Acceptance tests** (resolved model must contain the designation): `Tiggo 3`→a *Tiggo 3*,
`Peugeot 208`→a *208* (not 207), `BAIC X 55`→an *X55* (not X25), `Mazda 3`→a *3* (not 6).

---

## 3. Problem C — Stale insurer valuations (low `suma asegurada`)

**Real case.** For the (correct) Chery Tiggo, Provincia returned `suma ≈ 4.17M` while
Mercantil/Galicia/Paraná agreed on `≈ 15–16M`. That's **not a matching bug** — it's the
insurer's **own value table being outdated**, which is common for Chinese/imported and
recently‑launched models.

**Why it happens.** Name‑matching insurers value the car from **their own table**. If the
request sends "vehicle value = 0" (letting the insurer value it), you get whatever their
(possibly stale) table says. InfoAuto‑code insurers use the shared, more current InfoAuto value.

**How to handle.**
1. **Recognize it's the insurer's number, not a code bug** — confirm the resolved vehicle is
   correct (Problem A/B) first. If the vehicle is right but the value is far below the others,
   it's a **table‑lag** on the insurer side.
2. **Impact depends on coverage.** For **RC (third‑party only)** the `suma` is irrelevant (it
   doesn't indemnify the insured's car) — safe to show. For **Terceros Completo / Todo Riesgo**
   the `suma` is what gets paid on theft/total loss, so an undervalue is misleading and makes
   that insurer look artificially cheap. Flag or suppress TC/TR for insurers whose `suma` is
   far below the InfoAuto‑based consensus.
3. **Optional override.** If a reliable vehicle value is available (producer‑entered, or the
   `suma` another insurer returned for the same InfoAuto code), **send it explicitly** as the
   vehicle value so the name‑matching insurer rates the correct amount. Only do this when you
   trust the source; otherwise prefer the InfoAuto‑based insurers for that brand.
4. **Sanity band.** Compute the median `suma` across insurers that quoted; if one is, say,
   <60% of the median, mark it "value to verify" rather than presenting it as comparable.

---

## 4. Problem D — Brand‑new models not in the insurer's own catalog

**Real case.** A **Citroën Basalt 2026** quoted on Mercantil/Galicia (InfoAuto has it) but
**not** on Provincia/Paraná (their own catalogs hadn't loaded the model yet). Provincia's
model lookup returned "not found"; Paraná's static vehicle base simply has no Basalt.

**How to handle.**
- **InfoAuto‑code insurers** auto‑work as soon as the InfoAuto catalog you ship has the model.
  Keep that catalog refreshed (InfoAuto publishes monthly).
- **Provincia** resolves its catalog **live**, so it self‑updates when they load the model —
  nothing to do on your side.
- **Paraná** uses a **static** vehicle base → it will not quote new models until you refresh
  that file (from Paraná's export) or wire a live "list vehicles" method if they expose one.
- This is **expected**, not a bug. Fall back gracefully (show the insurers that do quote +
  an offline/WhatsApp path) and never block the whole quote because one insurer lacks the model.

---

## 5. Implementation checklist (what the system should enforce)

- [ ] No hardcoded brand map with duplicate codes; unknown/ambiguous brands resolve **live**.
- [ ] Name matcher: keep first two tokens, weight the model head ×10, keep numeric model
      tokens, combine short heads with the next token, compare head space‑insensitively.
- [ ] `?debug=1` on every proxy returns the **resolved vehicle** and the **suma**; QA asserts
      resolved brand/model ⊆ requested string.
- [ ] Cross‑insurer `suma` sanity check: flag any value far below the median; treat InfoAuto
      insurers as the reference.
- [ ] RC shows regardless of `suma`; TC/TR with a far‑below‑consensus `suma` is flagged/suppressed.
- [ ] New‑model gaps are a graceful "no price here" + fallback, never a hard failure.
- [ ] Catalog freshness: InfoAuto refreshed monthly; Paraná static base refreshed on new export.
