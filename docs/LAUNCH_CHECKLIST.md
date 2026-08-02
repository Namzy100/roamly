# Launch checklist — Checkpoint 5B

The exact sequence to deploy and smoke-test Roamly with landmark enrichment. Work top to bottom; every box is
something a person confirms by looking, not something a test asserts.

`docs/DEPLOYMENT.md` covers *how* to deploy. This covers *what to check* around it.

> **Nothing here deploys anything automatically.** Deployment is a manual step, taken deliberately.

---

## A · Before deploying

### A1 · Configuration

- [ ] **`ROAMLY_CONTACT_URL` is set** in the production environment.
- [ ] It is a **public HTTPS URL** that resolves — a project page, a repository, or a contact page.
      Not `http:`, not `localhost`, not an email address. `userAgentProblem` refuses each of those, and the
      enrichment route then answers **503** rather than degrading quietly.
- [ ] It is a place someone can actually reach you. Wikimedia, Nominatim and Overpass all use it to identify
      the traffic, and all three may block a client without notice.
- [ ] `NEXT_PUBLIC_SITE_URL` is set to the canonical origin.

### A2 · Credentials

- [ ] **Wikimedia requires no credential.** Confirm none was invented: there is no API key, token, client id
      or secret for Wikidata or Commons anywhere in the environment.

### A3 · Variables that must be ABSENT

None of these may be set in production. Each is test infrastructure; see `docs/PLACE_INTELLIGENCE.md` §9.

- [ ] `ROAMLY_BROWSER_FIXTURE_RUN` — **absent**
- [ ] `ROAMLY_WIKIMEDIA_FIXTURE_MODE` — **absent**
- [ ] `ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN` — **absent**
- [ ] `ROAMLY_ENRICHMENT_BUDGET_MS` — **absent**
- [ ] `ROAMLY_WIKIMEDIA_CACHE_DISABLED` — **absent**
- [ ] `NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_MODE` — **absent**
- [ ] `NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN` — **absent**

Endpoint overrides must also be absent, so the official hosts are used:

- [ ] `ROAMLY_WIKIDATA_ENTITY_BASE_URL` — absent
- [ ] `ROAMLY_WIKIDATA_API_URL` — absent
- [ ] `ROAMLY_WIKIDATA_SPARQL_URL` — absent
- [ ] `ROAMLY_COMMONS_API_URL` — absent
- [ ] `ROAMLY_WIKIPEDIA_API_URL_TEMPLATE` — absent

> **Why the absence still matters even though it cannot activate.** The fixture gate already refuses in a
> served application: it requires `NODE_ENV === "development"`, and `next build`/`next start` both report
> `production`; it refuses if any deployment marker (`VERCEL`, `VERCEL_ENV`, …) is present; and the browser
> half additionally requires the page's own hostname to be loopback. Confirming absence is defence in depth
> and, more practically, a way to notice a copied `.env` before it confuses someone.

### A4 · Gates, from committed code

- [ ] `npm run typecheck` — clean
- [ ] `npm run lint` — clean
- [ ] `npm test` — all pass
- [ ] `npm run verify:browser` — all pass
- [ ] `npm run build` — succeeds

---

## B · Deploy

- [ ] Deploy manually. Do not enable an automatic production deploy for this release.
- [ ] Record the deployment URL and the commit SHA.

---

## C · Smoke test the deployment

Run in a real browser, with the **network panel open** and the **console open**, on the deployed URL.

### C1 · The application loads

- [ ] Landing page renders.
- [ ] **No request to any Wikimedia host on landing.** Filter the network panel for `wikidata`, `wikipedia`,
      `wikimedia` — expect zero.
- [ ] Demo generation produces a trip.
- [ ] **No request to any Wikimedia host during generation.**
- [ ] Saved trip opens from the workspace.
- [ ] **No enrichment request when a saved trip is opened.** This is the one most worth confirming by eye:
      enrichment is explicit-only, and an automatic request here would be the whole design failing silently.

### C2 · The landmark action

- [ ] The landmark control appears **only** on trips with eligible landmarks. A trip of restaurants and
      cafés must offer nothing to enrich.
- [ ] Pressing it runs and completes.
- [ ] Progress reports honestly — "n of m", and the call count where a continuation happened.
- [ ] Context persists after a **full page reload**.

### C3 · Attribution and licence

- [ ] The exact **licence identifier** is visible (for example `CC BY-SA 4.0`), not a generic "Creative
      Commons".
- [ ] The **creator** is named.
- [ ] The source disclosure opens, and its links go to Commons / Wikidata.
- [ ] Links carry `rel="noopener noreferrer"` (inspect one).
- [ ] **OpenStreetMap attribution is still visible on the map.** Landmark enrichment must not have displaced
      it.

### C4 · Degradation

- [ ] Block `upload.wikimedia.org` in the network panel and reload a trip with a photograph.
      The **image disappears, the paragraph and facts remain**, and the Commons-specific attribution goes with
      the image — the source line stops naming Wikimedia Commons.
- [ ] Wikidata attribution for the still-rendered facts **remains**.
- [ ] No console error, no unhandled rejection, no React exception.

### C5 · The controls

- [ ] **Refresh** re-runs and updates the context.
- [ ] **Cancel** mid-run: the panel settles as cancelled, says nothing was saved, and the **existing context
      is unchanged**. The revision and undo history do not move.
- [ ] **Clear** removes the landmark context and **only** that — the itinerary, times, costs and routes are
      untouched.

### C6 · Portability

- [ ] **Export** a trip with landmark context; the file downloads.
- [ ] **Import** it back; it opens with its context intact.
- [ ] A trip **saved before this release** still opens without error.
- [ ] An export produced **before this release** still imports.

### C7 · Presentation

- [ ] No console errors.
- [ ] No hydration warnings.
- [ ] No horizontal overflow at 320 px, 768 px and 1280 px.
- [ ] Mobile smoke test on a real device or device emulation: the landmark card, the image, and the
      `<details>` disclosure are all reachable by touch.

### C8 · The provider adapter is not in the browser

- [ ] With the production build present, confirm zero matches in client chunks:

```
grep -rl "query.wikidata.org\|Special:EntityData\|wbgetentities\|wikibase:around" .next/static/
```

Expect **no output**. As a control, the same search over `.next/server/` should match — otherwise the search
itself is wrong rather than the result being good.

---

## D · After launch

- [ ] Watch logs for `place-intelligence.enrich` with `result: refused` and
      `errorCode: wikimedia_misconfigured` — that is the contact-URL fault, and it is the one that looks like
      a product bug from the outside.
- [ ] Watch for `wikimedia_forbidden`. A 403 means the `User-Agent` was unacceptable **or the client has been
      blocked**. Stop enrichment traffic and fix the contact URL before retrying; repeated requests are how a
      soft block becomes a hard one.
- [ ] Watch for `wikimedia_rate_limited`.
- [ ] Feature freeze holds: visual polish only until the small launch is done.
