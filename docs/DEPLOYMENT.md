# Deploying Roamly

Roamly deploys to Vercel with **no environment variables at all**. Everything below is optional.

That is the whole design: no database, no auth, no paid API, no billing account. Trips live in the
visitor's browser, places come from free OpenStreetMap services, and trip generation falls back to a
deterministic Demo Planner when no AI provider is configured.

---

## Prerequisites

- **Node 20.9+** (Next 16 requires it; `22 LTS` is what this was built and verified on)
- A GitHub account and a Vercel account — both free tiers are sufficient
- Nothing else

```bash
node --version   # v20.9.0 or newer
npm --version
```

---

## 1 · Verify locally before pushing

Run the full gate. Every command must pass before a deploy is worth attempting.

```bash
npm install
npx tsc --noEmit
npm run lint
npm run build
npm test
npm run verify:browser        # drives real Chrome against local fixture servers
```

Then check the production build behaves as production:

> **Kill anything already on port 3000 first.** A `next start` left running from an earlier build will
> keep answering, and the smoke test will report failures that belong to the old code — missing
> metadata, a route that "does not exist". That is the test working, but it is a confusing way to find
> out. `pkill -f "next start"` before you begin.

```bash
pkill -f "next start" 2>/dev/null; sleep 1
npm run build && npm start &
sleep 8
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/            # 200
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/dev/places  # 404
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/dev/routing # 404
PRODUCTION_BASE_URL=http://localhost:3000 npm run test:smoke:production
kill %1
```

The two `404`s matter: the development inspection surfaces must not exist in production.

---

## 2 · Push a verified branch

```bash
git checkout -b release
git add -A
git commit -m "Release: verified build"
git push -u origin release
```

Deploy from a branch first. Promote to production only after the preview smoke test passes.

---

## 3 · Create the Vercel project

1. **vercel.com → Add New → Project**, then import the repository.
2. Framework preset: **Next.js** (detected automatically).
3. Build command, output directory and install command: **leave as detected.** There is no
   `vercel.json`, because Next's own defaults are already correct — every route declares its own
   `maxDuration` in code, which is the only setting this app needs.
4. Root directory: repository root.
5. **Deploy.**

The first deploy needs no environment variables. If it fails for a missing variable, that is a bug —
please open an issue.

---

## 4 · Optional environment variables

Set these in **Project → Settings → Environment Variables**. Every one is optional; see
`.env.example` for the full annotated list.

> ### `ROAMLY_CONTACT_URL` — optional, but set it
>
> It is the one variable that changes behaviour rather than capability. It becomes the contact information in
> the outbound `User-Agent` sent to Nominatim, Overpass and **Wikimedia**.
>
> Wikimedia has required a descriptive `User-Agent` since 2010, answers **HTTP 403** without one, and may
> block a client without notice. So Roamly validates it locally, before opening a socket, and **refuses rather
> than degrades**: it must be a public `https:` URL. An `http:` URL, `localhost`, or a bare email address is
> rejected.
>
> When it is invalid, `POST /api/place-intelligence/enrich` answers **503 `provider_misconfigured`** —
> deliberately not a tidy 200 with an `abandoned` code. Dressing an operator's problem up as a provider
> outcome is how it survives to production. The response names the variable to set and nothing else: no value,
> no host, no header.
>
> Unset is safe — a project default is substituted — but it points at this project rather than at you.
>
> **Wikidata and Commons need no credential of any kind.** There is no key to configure.

> ### Variables that must NOT be set
>
> The Wikimedia endpoint overrides (`ROAMLY_WIKIDATA_ENTITY_BASE_URL`, `ROAMLY_WIKIDATA_API_URL`,
> `ROAMLY_WIKIDATA_SPARQL_URL`, `ROAMLY_COMMONS_API_URL`, `ROAMLY_WIKIPEDIA_API_URL_TEMPLATE`) and every
> browser-harness variable (`ROAMLY_BROWSER_FIXTURE_RUN`, `ROAMLY_WIKIMEDIA_FIXTURE_MODE`,
> `ROAMLY_WIKIMEDIA_FIXTURE_ORIGIN`, `ROAMLY_ENRICHMENT_BUDGET_MS`, `ROAMLY_WIKIMEDIA_CACHE_DISABLED`, and the
> two `NEXT_PUBLIC_ROAMLY_WIKIMEDIA_FIXTURE_*` values) are **test infrastructure**. Leave them unset.
>
> They cannot activate on Vercel — the gate requires `NODE_ENV === "development"` and the absence of every
> deployment marker, and `VERCEL` is one of those markers — but confirming their absence is how you notice a
> copied `.env` before it confuses somebody. `docs/LAUNCH_CHECKLIST.md` §A3 is the checklist.

| Variable | Effect if unset |
| --- | --- |
| `ROAMLY_AI_PROVIDER` | `auto` — Gemini if keyed, else Ollama if configured, else Demo Planner |
| `GEMINI_API_KEY` | Gemini is not offered; the Demo Planner is used |
| `GEMINI_MODEL` | `gemini-2.5-flash` |
| `OLLAMA_BASE_URL` | Ollama is not offered — **leave unset on Vercel**, see below |
| `ROAMLY_NOMINATIM_BASE_URL` | Public Nominatim |
| `ROAMLY_OVERPASS_BASE_URL` | Public Overpass |
| `ROAMLY_VALHALLA_BASE_URL` | Public Valhalla demo server |
| `ROAMLY_CONTACT_URL` | A generic contact URL in the provider `User-Agent` |
| `NEXT_PUBLIC_SITE_URL` | `https://roamly.vercel.app` — set it per deployment |
| `NEXT_PUBLIC_BASEMAP_STYLE_URL` | OpenFreeMap `positron` |

**Ollama on Vercel.** Leave `OLLAMA_BASE_URL` unset. A Vercel function cannot reach `localhost`, and
pointing it at a public Ollama host would expose an unauthenticated model endpoint. Ollama is for local
development.

**Setting `NEXT_PUBLIC_SITE_URL`.** Without it, canonical tags and the social-preview URL fall back to
`https://roamly.vercel.app`. Set it to each deployment's own origin so a preview does not advertise
production's canonical URL.

---

## 5 · Route durations

Every handler declares its own ceiling, and each internal budget sits below it so a timeout is a
controlled response rather than a killed function.

| Route | `maxDuration` | Internal budget |
| --- | --- | --- |
| `POST /api/trips/generate` | 120 s | 90 s (`GENERATION_BUDGET_MS`) |
| `POST /api/trips/refine` | 90 s | 60 s (`REFINEMENT_BUDGET_MS`) |
| `POST /api/trips/route` | 60 s | provider timeouts, bounded concurrency |
| `POST /api/trips/refresh-pool` | 60 s | 45 s (`REFRESH_POOL_BUDGET_MS`) |

All routes run on the **Node runtime**. None may move to Edge: the provider adapters use Node APIs and
`next/og` renders the social image on Node.

The generate route's 120 s exceeds the Hobby plan's 60 s function limit. On Hobby, a long Gemini
generation will be cut off by the platform before the internal budget fires — the traveller sees a
failed request and nothing is saved, which is safe but slower to explain. Either use the Demo Planner,
or deploy on a plan that allows 120 s.

---

## 6 · Verify the deployment

```bash
PRODUCTION_BASE_URL=https://<your-deployment>.vercel.app npm run test:smoke:production
```

Then check by hand:

- [ ] Landing page loads; the form is usable
- [ ] `/dev/places` and `/dev/routing` return **404**
- [ ] OpenStreetMap attribution is visible on the map, uncovered
- [ ] The Demo Planner produces a trip with no key configured
- [ ] Gemini appears **only** if you set a key
- [ ] The map renders; if you disable WebGL, the schematic fallback appears
- [ ] **No Wikimedia request on landing, during generation, or when a saved trip is opened** — filter the
      network panel for `wikidata`, `wikipedia`, `wikimedia` and expect zero. Enrichment is explicit-only, so
      a request here is the design failing silently.
- [ ] The landmark action appears only on trips with eligible landmarks, and completes when pressed
- [ ] The exact licence and creator are visible on an enriched card

**`docs/LAUNCH_CHECKLIST.md` is the full smoke checklist** — attribution, image-failure degradation, cancel
and clear semantics, import/export, old trips, mobile, and the client-bundle check. Work through it for a
release; the list above is the quick pass.
- [ ] Calculating routes draws real geometry
- [ ] A saved trip survives a reload
- [ ] Export downloads a JSON file; importing it back produces a second copy
- [ ] Storage panel shows a trip count and byte figure
- [ ] Mobile: the Plan/Map toggle works; nothing scrolls sideways
- [ ] Offline (DevTools → Network → Offline): the banner appears, the saved trip still reads, and
      provider-backed buttons are disabled with a reason
- [ ] Sharing the URL shows the social preview image

---

## 7 · Inspect the logs

**Vercel → Project → Logs**, or `vercel logs <deployment-url>`.

Server logs are structured single-line records and contain **no travel data** — no destination, no
place names, no itinerary content, no prompts, no model output. What is logged is the operation, the
provider category, a result category, a duration and a request id. See
`docs/ARCHITECTURE.md` → "Operational logging".

There is no analytics SDK and no error-tracking service.

---

## 8 · Rollback

Vercel keeps every deployment immutable, so rollback is instant and needs no rebuild.

**Vercel → Deployments → the last known-good one → ⋯ → Promote to Production.**

Or:

```bash
vercel rollback <previous-deployment-url>
```

Nothing to migrate: there is no database, and saved trips live in each visitor's browser — a rollback
cannot lose anyone's data. A visitor whose trip was written by a newer build and whose schema version
no longer matches will have that record dropped on read, which is why export exists.

---

## 9 · When usage grows

The free public services are appropriate for a portfolio demo and **not** for real traffic. Each is
isolated behind one adapter and swaps with one environment variable, no code change.

| Service | Replace with |
| --- | --- |
| Nominatim | Self-hosted Nominatim, or a commercial geocoder |
| Overpass | Self-hosted Overpass instance |
| Valhalla | Self-hosted Valhalla (runs on a small VM with a country extract) |
| Basemap tiles | MapTiler, Stadia, Protomaps, or self-hosted OpenMapTiles |

Before pointing real traffic at the public endpoints, either self-host or notify the operators. The
fair-use behaviour already in the code — pacing, caching, single retry, identifying `User-Agent`,
bounded queries — is a floor, not a licence.
