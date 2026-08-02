# Roamly — Architecture

AI travel itinerary builder. Claude plans and selects; a verified places provider supplies every real
business. Split-screen workspace: chronological itinerary left, interactive map right.

**Status:** Phases 1–5A shipped. The full front end runs on a deterministic mock plan with a real
MapLibre/OpenStreetMap map, real place discovery, and real walking/driving/cycling routing that the
traveller can apply to a saved trip. Every external service is free and keyless; none is required to
run the app.

---

## 1. Platform baseline (verified against this repo)

| Item | Value | Source |
| --- | --- | --- |
| Next.js | `16.2.11`, App Router, Turbopack by default | `package.json` |
| React | `19.2.4` | `package.json` |
| Tailwind | v4 via `@tailwindcss/postcss`, CSS-first `@theme` | `postcss.config.mjs`, `app/globals.css` |
| TypeScript | strict, `noEmit`, path alias `@/*` → `./*` (repo root, **no `src/`**) | `tsconfig.json` |
| ESLint | flat config (`eslint.config.mjs`), `eslint` script — `next lint` is removed in 16 | `eslint.config.mjs` |
| Node | local `v24.15.0` — Next 16 requires ≥ 20.9 | `node -v` |

### Next.js 16 constraints that shape the design

Read from `node_modules/next/dist/docs/`, not from memory. The ones that bind us:

- **Async request APIs.** `params`, `searchParams`, `cookies()`, `headers()` are Promises. Synchronous
  access was removed (not deprecated) in 16. Run `npx next typegen` to get the global
  `PageProps<'/route'>`, `LayoutProps<'/route'>`, `RouteContext<'/route'>` helpers.
- **Route Handlers are uncached by default.** Our generation endpoint is `POST`, which is never
  cached regardless. No `dynamic`/`revalidate` config needed.
- **`cacheComponents` stays OFF.** It enables PPR and makes uncached data outside `<Suspense>` a
  build error. Our workspace is a client-driven, localStorage-hydrated shell with no server data
  fetching — PPR buys nothing and costs strictness. Decision recorded here so it isn't relitigated.
- **`middleware.ts` → `proxy.ts`** (Node runtime only). We need neither — no auth in the MVP.
- **`revalidateTag(tag)` now requires a second `cacheLife` argument**; `cacheLife`/`cacheTag` are
  stable (no `unstable_` prefix). We use none of these.
- **`serverRuntimeConfig`/`publicRuntimeConfig` removed.** Env vars only.
- `typedRoutes: true` is stable and worth enabling.

---

## 2. Directory layout

Root-level, matching the existing `@/*` → `./*` alias. Adding `src/` would silently break it.

```
app/
  layout.tsx                 fonts, theme, metadata
  page.tsx                   landing + trip request form
  trip/[tripId]/page.tsx     split-screen workspace (async params)
  dev/places/page.tsx        provider inspection — 404s in production
  dev/routing/page.tsx       routing inspection — 404s in production
  api/
    places/geocode/route.ts  POST — destination candidates
    places/discover/route.ts POST — verified places by category
    routes/route/route.ts    POST — one routed leg
    routes/matrix/route.ts   POST — pairwise durations and distances
    routes/day/route.ts      POST — every leg of one day, partial success
    trips/route/route.ts     POST — a whole trip, enriched and returned
    trips/generate/route.ts  POST — the full generation pipeline (SSE or JSON)
    trips/refine/route.ts    POST — one bounded change to a saved trip
    trips/refresh-pool/route.ts
                             POST — re-run the place search; preview only, never a write
    ai/status/route.ts       GET  — whether an AI planner can be offered
components/
  ui/                        shadcn primitives (generated, not hand-written)
  form/                      field, choice-group, trip-builder-form
  marketing/                 hero, saved-trips
  shell/                     site-chrome
  trip/                      trip-workspace, trip-header, day-selector, itinerary-panel,
                             itinerary-item-card, travel-segment-row, budget-panel,
                             flight-estimate-card, accommodation-card, backup-options,
                             practical-notes, trip-loader, generation-provenance,
                             refine-panel, routing-controls, schedule-accuracy,
                             opening-hours-badge, place-pool-panel, placement-dialog
  map/                       map-panel, trip-map (MapLibre), numbered-marker,
                             use-map-camera, map-fallback, map-error-boundary
  dev/                       dev-places-explorer, dev-routing-explorer (development only)
  states/                    workspace-skeleton, trip-not-found
lib/
  schemas/                   enums, place, pool, routing-state, trip-request, trip-plan
  plan/                      builder, expected-legs, derive-totals, summary,
                             validate-derived, policy, pool, cost-bands,
                             schedule-report, schedule-repair — pure, client-safe
  opening-hours/             types, parser, normalize, timezone, evaluate — a bounded
                             `opening_hours` subset; pure, client-safe, no clock
  costs/                     types, profiles, destination-profile, allocate, estimate,
                             validate — curated multipliers, no money, no exchange rate
  routing/                   types, schemas, modes, mode-policy, derive, leg-id, validate,
                             cache-key, format, segment — provider-independent, client-safe
  providers/cache.ts         the shared bounded LRU/TTL cache and key builder
  providers/log.ts           structured logging behind a field allowlist (server-only)
  providers/osm/             config, identity, categories, schemas, normalize,
                             rate-limit, cache, http, errors, geocode, discover
  providers/routing/         config, errors, client, concurrency, cache, service, day, trip
    valhalla/                schemas, geometry, normalize, route, matrix
  api/                       places-contract, routing-contract, trip-routing-contract,
                             route-helpers
  map/                       types (the adapter contract), basemap, derive, derive-routes,
                             bounds, sequence, routes
  trip/                      visible-items, project (fallback projection)
  store/                     trip-store (Zustand + persist), trip-record (revision envelope),
                             routing-job-store, refinement-job-store, workspace-store,
                             use-hydration, capacity (quota pre-flight), storage-usage,
                             portable-trip (export/import)
  hooks/                     use-media-query, use-trip-routing, use-trip-generation,
                             use-trip-refinement, use-structural-edits, use-trip-storage,
                             use-online-status
  mock/                      lisbon-trip — the deterministic sample plan
  format.ts                  money, dates, distance, duration
  ai/                        types, errors, schemas, json-schema, prohibited,
                             validate-strategy, validate-assembly, prompts/ —
                             the model boundary; provider-free and client-safe
  providers/ai/              config, create-provider, http, parse
    gemini/                  schemas, generate
    ollama/                  schemas, generate
    deterministic/           generate — the keyless planner
  generate/                  types, pace-policy, discovery, candidates,
                             assemble-plan, generate-trip-plan — the pipeline
  refinement/                commands, schemas, candidates, schedule, validate,
                             invalidate-routes, replace-item, replace-backup,
                             adjust-day, summary, eligibility, prompts,
                             refine-trip — safe edits to a saved trip;
                             resolve-hours, reestimate — the deterministic Phase 6B
                             repairs, applied in the browser with no endpoint
  structural-edits/          position, schedule, promote-backup, move-item, commit,
                             pool-age, pool-diff, reconcile-pool, validate — Phase 6C
                             structural editing and the pool-refresh lifecycle; pure
docs/
test/browser/                cdp, fixtures, run — browser verification
test/browser/screenshots.mjs production screenshots, from a production build
test/smoke/production.mjs    28 deployment checks against a base URL
```

---

## 3. Data flow

```
TripRequestForm (RHF + Zod, client)
        │  POST /api/generate
        ▼
┌─ app/api/generate/route.ts ──────────────────────────────────┐
│ 1. TripRequestSchema.parse(body)          Zod boundary       │
│ 2. Claude call #1 → DestinationStrategy   structured output  │
│ 3. Nominatim geocode + Overpass discover  verified pool      │
│ 4. Claude call #2 → DraftItinerary        pool placeIds only │
│ 5. Routing provider (Phase 4)             legs + distances   │
│ 6. validate(itinerary) → Issue[]                             │
│ 7. if issues: ONE repair pass (Claude, same candidate pool)  │
│ 8. TripPlanSchema.parse(result)           exit boundary      │
└──────────────────────────────────────────────────────────────┘
        │  TripPlan
        ▼
Zustand store ──► localStorage (versioned)
        │
        ├──► itinerary column (left)
        └──► lib/map/derive.ts ──► VisibleMapPlace[] ──► MapLibre map (right)
```

Server-only modules (`lib/providers/*`, `lib/generate/discovery.ts` and
`lib/generate/generate-trip-plan.ts`) must never be imported from a `"use client"` file.
`lib/ai/` is deliberately *not* server-only: it holds the contracts, the prompts and the
mechanical validation, with no provider access and no environment read, which is what lets the
no-invention gate be unit-tested against hand-written payloads with no provider present. Enforced three ways: the
`server-only` package (a build error), an ESLint `no-restricted-imports` rule with an
explanatory message, and the API routes being the only browser-reachable path.

---

## 4. The no-invention boundary

The core product rule, enforced mechanically rather than by prompt alone.

### What "verified place" means in the free MVP

A place is **verified** when all of the following hold:

- it was returned by an OpenStreetMap-backed provider
- it carries an OSM element type **and** element id
- it has coordinates
- it has a non-empty name
- its OSM tags match an allowlisted category (`lib/schemas/place.ts`)
- it was normalised by our own server, never by a model or the browser
- its canonical `placeId` belongs to the exact candidate pool the itinerary was built from

### What it explicitly does **not** mean

Not highly rated. Not currently open. Not bookable. Not price-verified. Not
editorially recommended. Not even guaranteed to still be trading. OpenStreetMap is a
map, not a reviews site — it records that a thing exists at a location, and that is
the entire claim we make.

This is a genuine reduction from the earlier Google-based plan, which leaned on
ratings, review counts, price levels and opening hours. Those are gone, and nothing
synthesises replacements: **ratings, review counts, price levels, opening status,
addresses, websites, phone numbers and cuisines are never inferred, defaulted or
invented.** A field the provider did not supply is absent, and the UI says "unknown".

### The pool mechanism

1. A destination string is geocoded to candidates (`lib/providers/osm/geocode.ts`).
   The domain layer never silently picks the first — "Lisbon, Portugal" and "Lisbon,
   Ohio" both come back, and choosing is the caller's job.
2. Discovery searches allowlisted categories around the chosen centre
   (`lib/providers/osm/discover.ts`) and normalises the results to `TripPlace`.
3. `buildVerifiedPlacePool` (`lib/schemas/pool.ts`) validates every record and is the
   only way to construct a pool.
4. A planner may reference stops **only** by a `placeId` from that pool. Three independent
   mechanisms enforce it, in this order: the assembly schema has nowhere to put a place;
   `lib/ai/prohibited.ts` scans the raw payload for provider-shaped keys before Zod can strip
   them; and `assertItineraryUsesPool` runs on the finished plan, backups included.
5. The pool is **retained with the trip** (see §5, "Generation context"), so verification later —
   during routing, or on a reload months afterwards — is against the original search rather than
   against the plan's own contents.

### Hard failures, with no silent repair

Pool validation throws — it never drops a bad record and returns a shorter list,
because that would hide the exact failure it exists to catch:

| Failure | Meaning |
| --- | --- |
| `duplicate_place_id` | the same canonical id twice |
| `placeid_source_mismatch` | `placeId` ≠ `source.canonicalId` |
| `osm_identity_mismatch` | `osmType`/`osmId` do not reconstruct `placeId` |
| `malformed_source_identity` | an OSM place missing its element identity |
| `mock_claims_osm_source` | sample data carrying OSM element metadata |
| `missing_name` / `missing_coordinates` | unmappable or undescribable |
| `unsupported_category` | outside the allowlist |
| `place_outside_pool` | an itinerary referencing a place never searched for |
| `attached_place_mismatch` | an attached copy whose name, coordinates, category or provider was altered |

That last one matters as much as the rest: a `placeId` can be in the pool while the
attached record has been edited, which would put a real identity on a place that is
no longer the same place.

### Provider facts versus planning estimates

Two separate data domains, deliberately not mixed. An OSM tag says what a place *is*;
it says nothing about what a visit *costs*. `CostEstimate` (`lib/schemas/place.ts`)
carries an amount together with its `basis` (`user-provided`, `category-estimate`,
`free-entry-tag`, `provider-tag`, and since Phase 6B `destination-band` and
`derived-budget-allocation`) and a `confidence`, so a number can never be shown
without saying where it came from. A price is never inferred from a restaurant
category. The sample itinerary's figures are unchanged and remain sample figures.

### Opening hours (Phase 6B)

`opening_hours` is still **stored verbatim and never rewritten** — the field is the
provider's fact. What changed in Phase 6B is that `lib/opening-hours` now *interprets* it
at read time, for a deliberately small subset of the grammar, and states plainly when it
cannot.

```
schedule  := rule (';' rule)*
rule      := '24/7' | 'off' | dayspec 'off' | dayspec? timespec
dayspec   := dayrange (',' dayrange)*
dayrange  := DAY ('-' DAY)?
timespec  := interval (',' interval)*
interval  := HH:MM '-' HH:MM
```

Anything outside it fails as `unsupported_syntax` **before** parsing begins, checked as a
substring list: public and school holidays, sunrise/sunset, `easter`, week numbers, month
names, quoted comments, the `||` fallback separator, open-ended `09:00+`, and a literal
`unknown`. That refusal is the whole design. `Mo-Fr 09:00-17:00; PH off` is readable as
weekday hours, and reading it that way is right six days a week and wrong on the day it
matters — so it is not read at all.

The parser is bounded before a regex sees the input (512 characters, 24 rules, 8 intervals
per rule), every pattern is anchored and free of nested quantifiers, `25:00` is rejected,
`24:00` means end of day, and a zero-length interval like `09:00-09:00` is rejected rather
than read as "closed" — `off` already says closed, and a data-entry slip is not a factual
claim. Nothing consults the system locale or the clock.

#### The seven states, and the two claims

`OpeningEvaluation` is a seven-arm union: `confirmed_open`, `confirmed_closed`, and five
kinds of not-knowing (`unknown_no_data`, `unknown_unparsed`, `unknown_timezone`,
`unknown_exception`, `not_applicable`). The order of checks in
`evaluateScheduledVisit` is the safety property, not a style choice:

1. no source string → `unknown_no_data`
2. no or unrecognised timezone → `unknown_timezone`
3. unparsable → `unknown_unparsed`
4. an exception clause present → `unknown_exception`
5. a wall clock that does not exist or happens twice → `unknown_exception`
6. only then may a parsed rule decide, and only then can `confirmed_closed` be returned

So "absence of evidence is never evidence of closure" is true by construction rather than
by review. `confirmed_open` additionally requires the **whole** visit inside one interval:
a 16:30–18:00 visit to a museum shutting at 17:00 is a conflict, because reporting it as
open would be the least useful answer available.

#### Timezone without a paid API

Evaluating hours needs an IANA zone, Nominatim does not supply one, and the alternatives
were a paid API, a network call per evaluation, or megabytes of polygons. `lib/opening-hours/timezone.ts`
is a curated table instead: a single-timezone country resolves from its country code, a
multi-timezone country resolves **only** on a city match, and anything else returns `null`.
"Portugal" is not an answer, because Lisbon and Funchal are an hour apart. DST comes from
the platform's own IANA database via `Intl.DateTimeFormat` with `timeZoneName: "longOffset"`,
and `resolveWallClock` *verifies* its answer by rendering the corrected instant back and
comparing wall clocks — naive offset arithmetic is wrong precisely at the transitions this
exists to catch. The device timezone is never read; a traveller in Sydney planning Lisbon
gets Lisbon's answer.

The resolved zone is stored on `TripGenerationContext.destinationTimezone` rather than
re-derived, for the same reason coverage counts are derived: the curated table will change,
and a plan whose verdicts shifted underneath a traveller without the plan changing would be
exactly the drift the derived-field rule prevents.

#### Report, not gate

`lib/plan/schedule-report.ts` aggregates per-plan and is **derived on every read, never
persisted**. A *conflict* is the one closure claim; everything else is a *warning*, and a
plan with conflicts is still valid and saveable — the hours may be years out of date, the
parser covers a subset, and refusing to save a trip over an OSM tag helps nobody. The
schedule validator in `lib/refinement/schedule.ts` therefore stays structural and does not
consult hours.

Unknown hours are deliberately **not** generation warnings. Most OSM places have no tag, so
one warning per unchecked stop would make nearly every generation "partial" and bury the
conflicts that matter. They live in the derived report, stated per stop.

#### Repair

At generation, `repairScheduleConflicts` runs **once**, after canonical attachment, and its
entire repertoire is moving a stop's start and end time within its own day, keeping its
duration and its place. It cannot swap a place, promote a backup, cross days, or trim a
visit to fit. A move is applied only if the moved stop verifies as `confirmed_open` *and*
the day is still structurally sound; otherwise the conflict is retained as an explicit
warning. Unresolved conflicts are re-evaluated after the pass, so no repaired stop is also
reported as broken.

The traveller's own repairs (`lib/refinement/resolve-hours.ts`) are `adjust-time`,
`replace-place` and `mark-unavailable`. All three are pure arithmetic over the plan and the
trip's saved pool, so the browser applies them under the same revision guard and undo
snapshot as a refinement that crossed a network — there is no endpoint, because there is
nothing on the other side of one. `adjust-time` uses the *same* slot-finder the automatic
pass uses, and the button is not drawn at all when no slot exists.

### Destination-aware cost estimates (Phase 6B)

A profile in `lib/costs/profiles.ts` holds **no money**. It holds `weights` (how a budget
divides between categories at this destination) and `relativeCost` (how expensive each kind
of place is relative to the others *there*). Both are dimensionless, every number is
hand-entered with a `sourceNote`, and each profile is versioned.

That is the design decision that removes exchange rates from the system entirely. A profile
holding "a museum in Lisbon costs €12" would need converting for a traveller budgeting in
AED, and a rate is a live financial fact with a timestamp we have no feed for — inventing
one would be the exact fabrication this architecture exists to prevent, wrong in a way
nobody could see. There is no conversion function anywhere.

Estimates are therefore a two-stage rule:

1. **allocate** — the category budget for the day, divided by the stops the *pace* plans
   for, scaled by the destination's relative multiplier for that class
2. **clamp** — pulled into the absolute band for that class in the traveller's own
   currency (`lib/plan/cost-bands.ts`, hand-written per currency, never derived from one
   another)

Stage one makes the figure proportionate to what the traveller has and where they are;
stage two makes it plausible. A £20,000 budget cannot produce a £400 coffee and a £300 one
cannot produce a £2 dinner. A model may propose an amount and it competes with the
allocation — `Math.min` — so a model can talk an estimate *down* but never up.

`allocateBudget` allocates five categories to the cent and gives the buffer the remainder,
so `flights + accommodation + food + activities + localTransport + buffer = budget` holds
**exactly** rather than within a cent; the budget panel shows all six and a traveller can
add them up. `lib/costs/validate.ts` asserts that identity, and asserts the curated table
for the mistakes hand-entered data actually makes: weights that do not sum to one, a band
whose `low` exceeds its `high`, a destination key claimed by two profiles (which would make
table *order* decide the answer).

Lookup is city → country/region → global and **always** resolves. The global fallback
reproduces the pre-profile baseline exactly, so adding this feature did not change the
estimate for a destination it knows nothing about. What changes with a vaguer match is the
recorded confidence: `city` is high, `country`/`region` medium, `global` low, and the basis
says `derived-budget-allocation` rather than `destination-band` so a figure cannot imply
local knowledge the profile does not have.

`TripGenerationContext.costProfile` records the id, version, match and confidence. Trips
generated before Phase 6B have none and are **not** backfilled — their figures came from
different arithmetic, and labelling them with a profile they never saw would be inventing
provenance.

---

## 5. External contracts

Verified against live responses on 2026-07-26, not recalled. Anything not listed here
must be confirmed against a recorded response before code depends on it.

**No API key, no account, no billing** for anything in this section.

### Nominatim — destination geocoding

```
GET https://nominatim.openstreetmap.org/search
  ?q=<destination>&format=jsonv2&limit=5&addressdetails=1[&countrycodes=xx]
User-Agent: RoamlyWeekendProject/0.1 (portfolio travel planner; <contact URL>)
Accept: application/json
```

Fields consumed: `osm_type`, `osm_id`, `lat`, `lon` (**strings**, coerced), `name`,
`display_name`, `boundingbox`, `address.country_code`.

Two traps worth naming, both covered by tests:

- **`boundingbox` is `[south, north, west, east]`** — not the west/south/east/north
  ordering most APIs use. Mixing them up yields a box that validates and sits in the
  wrong place.
- **`Number("")` is `0`**, so an empty coordinate string would validate as latitude 0,
  longitude 0 — a real point in the Gulf of Guinea. Empty strings are rejected
  explicitly.

### Overpass — category-based place discovery

```
POST https://overpass-api.de/api/interpreter
Content-Type: application/x-www-form-urlencoded
Body: data=[out:json][timeout:25];
      ( nwr["tourism"="museum"](around:2000,38.7223000,-9.1393000); )->.c0;
      .c0 out center 15;
```

`nwr` matches nodes, ways and relations. `out center` gives ways and relations a single
representative coordinate, so every result is mappable; nodes carry top-level
`lat`/`lon` while ways and relations carry `center: {lat, lon}` — both shapes are
accepted, and an element with neither is dropped rather than defaulted.

**Overpass reports overload with HTTP 200 and an HTML body**, verified live while
building this. A client that only checks the status code reads that as success, fails
to parse, and reports a permanent error for a transient one. The body is therefore
sniffed and such responses are classified retryable.

### Query construction is injection-proof by construction

`lib/providers/osm/overpass-query.ts` assembles queries from exactly three things:
tag keys and values **looked up from the allowlist**, numbers that have been
range-checked and re-emitted through `toFixed`, and literal syntax written in that
file. A caller supplies a category *name*; if it is not in the allowlist the request
throws before any string building. There is no path for a caller-supplied `;`, `]`,
`)` or `->` to reach the query, and the tests attempt it directly.

Bounds are enforced, not suggested: radius capped at 30 km (no country-scale queries),
at most 8 categories per request, per-category result caps, and a query timeout
ceiling written into the query itself.

### Server-only access

`lib/providers/osm/*` imports `server-only`, so importing it from a client component
is a **build error**, not a runtime surprise. An ESLint rule additionally blocks
`@/lib/providers/**` from `components/**` with an explanatory message. Browser code
reaches providers only through `POST /api/places/geocode` and
`POST /api/places/discover`, which return normalised data and never a raw provider
payload, endpoint or hostname.

### Rate limiting

`lib/providers/osm/rate-limit.ts` is a **promise chain**, not a clock check. Two
concurrent callers checking "has a second passed?" would both see yes and both fire;
chaining makes them queue by construction. One shared limiter per provider per
process guarantees ≥1.1 s between Nominatim requests.

This is **per process**. Several serverless instances each hold their own chain, so
the real ceiling is (instances × 1/sec). Adequate for a portfolio demo; anything with
real traffic needs a shared limiter or a self-hosted instance.

There is no search-as-you-type anywhere, and no provider call fires on render, on
mount or on field change. The dev surface requires an explicit submit and holds a
synchronous in-flight guard so a fast double-click cannot spend two slots.

### Caching

A provider-independent `Cache` interface with a bounded LRU+TTL in-memory
implementation, namespaced per provider, with deterministic keys (sorted object keys,
arrays order-normalised, floats rounded to 6 dp so noise cannot fragment entries).

| What | TTL | Why |
| --- | --- | --- |
| Destination geocoding | 24 h | place names and coordinates change over years |
| Place discovery | 6 h | edits happen, but not by the minute |
| Successful-but-empty result | 10 min | a real answer worth not re-asking, but the most likely to change |
| Provider failure | never cached | a failure is not data |

**Serverless caveat:** this is per-process memory. Each instance has its own copy,
instances restart freely, and a cold start begins empty. The cache reduces repeat load
and protects the public services from our own loops — it is not a durable store and
must never be relied on for correctness.

### Public endpoint constraints, and the migration path

Both services are free, volunteer-run infrastructure. They are appropriate for local
development and a low-traffic portfolio demo, and **not** for production traffic. We do
not work around their limits: no bulk downloading, no offline caching of results
beyond the TTLs above, no prefetching, no stripping of identifying headers, no
parallel Nominatim requests.

Migration when this stops being a weekend project, in increasing order of effort:

1. **Self-host Nominatim and Overpass** — both are open source; a country extract runs
   comfortably on a small VM and removes every shared-service constraint.
2. **A commercial OSM-compatible geocoder** (Geoapify, LocationIQ, Photon-as-a-service)
   — a key and a bill, but the same data model, so only `config.ts` changes.
3. **A different provider entirely** — the adapter boundary means `TripPlace` and the
   pool contract stay put; a new `lib/providers/<name>/` implements the same two
   functions.

### Attribution

OpenStreetMap data is ODbL-licensed, which requires attribution. Credit is carried on
every normalised record (`source.attribution`), returned in every API response, shown
on the dev surface, rendered by MapLibre on the map, and stated in the README. It must
not be removed, hidden or shortened into illegibility. This is a plain reading of the
licence requirement and not legal advice; anyone shipping this commercially should read
the ODbL themselves.

### Wikidata and Wikimedia Commons — landmark enrichment

The fourth external contract, and the only one a traveller has to *ask* for. Full detail in
`docs/PLACE_INTELLIGENCE.md`; the architectural shape is:

- **`lib/place-intelligence/`** — the provider-independent contract. A fact vocabulary, a provenance record,
  a trust ranking, and two policy modules. **No client, no key, no fetch, no adapter anywhere in it**, which
  is what lets a licence rule be unit-tested without a network.
- **`lib/providers/place-intelligence/`** — the execution. `server-only`, one outbound HTTP path, five
  permitted requests expressed as a closed union so no caller can supply a host, a path or a query fragment.
- **`app/api/place-intelligence/enrich`** — a provider boundary that persists nothing, mutates nothing and
  returns no trip. It carries no `tripId`, because the server could neither verify nor use one.
- **The browser folds the outcomes in** and performs one guarded save, under the revision it read before
  starting — the shape `refresh-pool` established.

The dependency points one way: the contract knows nothing about Wikimedia, and the adapter is the only thing
that turns a provider's shape into Roamly's vocabulary.

**Nothing runs implicitly.** No request on landing, during generation, on trip open, or on render. Enrichment
is serial by Wikimedia's etiquette, so a full trip takes seconds — which is precisely why it cannot sit on a
page load.

**The sidecar never becomes the place.** It is stored beside the plan, keyed by canonical place id, and
OpenStreetMap remains the authority for identity and category. Enrichment has no code path that could produce
a `TripPlace`.

### Valhalla — routing

```
POST https://valhalla1.openstreetmap.de/route
Content-Type: application/json
Accept: application/json
X-Client-Id: roamly-weekend-project
User-Agent: RoamlyWeekendProject/0.1 (portfolio travel planner; <contact URL>)

{ "locations": [{lat, lon, type: "break"}, {lat, lon, type: "break"}],
  "costing": "pedestrian" | "auto" | "bicycle",
  "units": "kilometers",
  "directions_type": "none" }
```

Verified against live responses on 2026-07-26, not recalled.

Fields consumed: `trip.status`, `trip.units`, and per leg `summary.time` (**seconds**,
fractional), `summary.length` (**kilometres**, because we always request them) and
`shape`. Nothing else is parsed.

Four things about this API are worth naming, all covered by tests:

- **`directions_type: "none"` suppresses the maneuver list.** An 880 m walk otherwise
  returns ~14 KB of turn-by-turn phrasing variants. This phase builds no turn-by-turn
  UI, so requesting them would be bandwidth spent on a donated server for data we would
  immediately discard — roughly an 80% reduction.
- **The shape is polyline precision 6**, not the 5 that Google Directions and most
  polyline libraries default to. Decoding at 5 does not throw; it produces finite
  coordinates ten times too large, which puts a Lisbon walk in the Arctic Ocean. The
  precision is an explicit parameter and a fixture test pins it.
- **"No route" arrives as HTTP 400**, with `error_code` 154 (distance limit), 170
  (unconnected regions), 171 or 442. So does a genuinely malformed request. Only the
  body distinguishes a correct answer from our bug, and the two are handled completely
  differently: one is cached and never retried, the other is neither.
- **A well-formed body can still carry a failure.** `trip.status` is non-zero inside an
  HTTP 200 in some conditions, so the status code alone is not evidence of a route.

```
POST https://valhalla1.openstreetmap.de/sources_to_targets
{ "sources": [...], "targets": [...], "costing": "auto", "units": "kilometers" }
→ { "sources_to_targets": [[{from_index, to_index, time, distance}, ...], ...] }
```

Unreachable cells arrive as `time: null, distance: null` and stay null. Coercing them to
zero would say the two points are on top of each other, which is the most expensive
available misreading of a travel matrix.

#### The routing boundary

Two layers, mirroring the places stack:

```
lib/routing/            provider-independent, CLIENT-SAFE (no server-only)
  types.ts              RouteRequest, RouteResult, RoutingMatrix, ModePolicy, DayLeg
  schemas.ts            Zod mirrors, tied to types.ts by compile-time assertions
  modes.ts              walk|drive|bicycle ↔ WALK|DRIVE|BICYCLE
  mode-policy.ts        which mode to *ask for* — sits above the provider
  derive.ts             itinerary → legs (pure)
  validate.ts, cache-key.ts, format.ts, segment.ts

lib/providers/routing/  SERVER-ONLY
  config.ts             the only module naming an endpoint
  errors.ts, client.ts, concurrency.ts, cache.ts, service.ts, day.ts
  valhalla/             schemas, geometry, normalize, route, matrix — the only files
                        that know what a Valhalla payload looks like
```

Nothing above `lib/providers/routing/valhalla/` imports a Valhalla type. The map
renderer receives `MapRouteLine` — a leg id, a mode string and a coordinate array — and
`components/map/trip-map.tsx` remains the only file importing a map library.

#### Supported modes, and the absence of transit

| Ours | Valhalla costing |
| --- | --- |
| `walk` | `pedestrian` |
| `drive` | `auto` |
| `bicycle` | `bicycle` |

**Transit is not supported and is not substituted.** No transit feed is loaded on the
demo server, and returning a walking or driving route under a transit label would
misdescribe what the traveller is being told to do. A transit request is refused as
`unsupported_mode` before a request exists. The mapping table above is total over
`RoutingMode` and has no transit entry, so there is no expressible way to make the
substitution by accident.

The routing layer **never changes the requested mode**. Given `walk` it returns a
walking route or an `unavailable`; it will not decide 40 km is too far and hand back a
drive. Mode *selection* is a product decision and lives above the provider in
`lib/routing/mode-policy.ts`, whose thresholds (walk ≤ 1.8 km, drive > 8 km, the middle
band left to the caller) are configurable planning defaults rather than facts about the
world. Bicycle is never auto-selected — it depends on infrastructure, hills, luggage and
whether the traveller owns a bike.

#### Routed, estimated, unavailable

`TravelSegment` is a discriminated union on `status`. The old flat shape could not
distinguish "the routing engine says 12 minutes" from "somebody guessed 12 minutes" from
"we could not find out", so the UI had no way to be honest even if it wanted to be.

| `status` | The claim | Carries | Never carries |
| --- | --- | --- | --- |
| `routed` | a provider computed this path | `provider`, `mode`, `distanceMeters`, `durationSeconds`, `durationMinutes`, `geometry` (≥2 points), `fetchedAt`, `attribution` | — |
| `estimated` | a plausible figure, with its basis | `basis`, `confidence`, `disclaimer`, `estimatedDurationMinutes` | geometry |
| `unavailable` | we do not know, and here is why | `requestedMode`, `reason`, `userMessage` | any number, any geometry |

Distance and duration on a routed segment are `.positive()`, not `.nonnegative()` — zero
is how a naive implementation says "failed", and the `unavailable` arm replaces that.
Only `routed` accepts a mode; it uses `RoutedTravelMode`, which excludes `TRANSIT`.
`estimated` accepts the full vocabulary, which is why the sample plan's eight transit
legs remain valid.

**`TRIP_PLAN_SCHEMA_VERSION` is 3.** A stored v2 segment has no `status` to discriminate
on, so plans saved under an older version are discarded on read by the Phase 1
mechanism. The sample trip is one click to regenerate.

The sample plan is unchanged in content: its `segment()` factory now emits
`status: "estimated"`, `provider: "mock"`, `basis: "Sample itinerary data — written by
hand, not measured"` and a disclaimer the UI renders. Mock geometry does not exist and
mock data cannot claim to be Valhalla-routed — the `routed` arm requires provider
geometry and a `fetchedAt`.

#### Sequence line versus real route geometry

Two GeoJSON sources and two layers, always both:

| Layer | Source | Style | Means |
| --- | --- | --- | --- |
| `roamly-sequence-line` | `lib/map/sequence.ts` | dashed, muted, 2 px | the order stops are visited |
| `roamly-route-line` (+ casing) | `lib/map/routes.ts` | solid, mode-coloured, 3.5 px | the path actually travelled |

The sequence line **stays** when routed geometry arrives. "The order I visit things" and
"the path I walk between them" are different facts, and a day with one unroutable leg
would otherwise look like a gap in the itinerary rather than a gap in our knowledge of
the roads.

**An unavailable leg produces no feature.** Not a straight line, not a dotted
"approximate" line, nothing. `MapRouteLine` has no arm that could express one, so the
renderer cannot get this wrong. The itinerary panel is where the traveller is told there
is a gap.

Camera fitting includes route vertices as well as markers: a routed path bulges outside
the box its endpoints describe — a one-way system, a river crossing, a road round a hill
— so fitting to markers alone clips it. Markers are DOM overlays and route lines are
canvas layers, so a line can never intercept a marker click.

#### Cache, concurrency and retries

The cache implementation moved to `lib/providers/cache.ts` — it was already
provider-independent, and routing needed it. `lib/providers/osm/cache.ts` now holds only
that provider's instances.

| What | TTL | Why |
| --- | --- | --- |
| Successful route | 24 h | a road does not move |
| Successful matrix | 24 h | same |
| `no_route` | 15 min | a real answer, but the one most likely to be wrong — an unmapped path, a mis-snapped endpoint |
| Any other failure | never cached | a failure is not data; caching one would pin an outage into the app |

Keys round coordinates to **5 dp** (~1.1 m), harder than the shared helper's 6 dp,
because the provider snaps endpoints to the road network anyway. Finer and float noise
fragments the cache; coarser and two doorways across a block share a key, which returns
the *wrong* route rather than a redundant one. Mode is part of the key: collapsing the
walking and driving routes between the same points is the most damaging cache bug
available here. Matrix keys preserve source and target *order*, because a matrix is read
positionally.

Batching is bounded at **3 concurrent requests** with a **250 ms minimum gap between
request starts**, both configurable. The concurrency cap alone would let a five-day
itinerary fire fifteen requests in three tight bursts; the interval spreads them.
Identical origin/destination/mode requests inside a batch are issued once and the result
shared — a hotel departed from and returned to is not two calls. Output order matches
input order, so a result cannot be attached to the wrong leg.

**Partial failure is preserved, never discarded.** `routeSegments` returns one result per
input, each independently `routed` or `unavailable`. One bad leg out of seven leaves six
real routes on the map.

At most **one retry**, for 429, transient 5xx, an HTML body under HTTP 200, an empty
body, or a network failure. Short backoff with jitter — without jitter a batch that fails
together retries in lockstep, turning one bad moment into a thundering herd. `Retry-After`
is honoured and capped. Never retried: a caller abort, a malformed request, or a genuine
`no_route`, because re-asking a volunteer-run service the same unanswerable question is
the definition of abuse.

Each day is an independent routing unit. Nothing joins the last stop of Tuesday to the
first of Wednesday.

**Serverless caveat**, as with the places cache: this is per-process memory. Instances do
not share it and cold starts begin empty. It exists to spare a donated server our repeat
questions, not to be a store.

#### Fair use, and the migration path

`valhalla1.openstreetmap.de` is FOSSGIS's public **demo** instance — unversioned,
unguaranteed, and liable to be slow, rate-limited or gone. Everything downstream degrades
to an explicit "route unavailable" rather than to a wrong answer.

Every request carries `X-Client-Id: roamly-weekend-project` (configurable via
`ROAMLY_ROUTING_CLIENT_ID`) plus a descriptive `User-Agent` with a contact URL, so the
operator can see who is generating traffic and reach or block us specifically. Nothing
personal is sent. **A production deployment should notify the demo server's operator or
move off the shared instance** before generating meaningful traffic.

Migration, in increasing order of effort: self-host Valhalla (open source; a country
extract runs comfortably on a small VM), use a commercial Valhalla-compatible host, or
swap the adapter for another engine. The first two are an edit to
`VALHALLA_BASE_URL` in `lib/providers/routing/config.ts` and nothing else; the third
means a new `lib/providers/<name>/` implementing the same three functions, with
`lib/routing/` unchanged.

#### No live traffic

Valhalla computes over OpenStreetMap geometry using a costing profile. **This deployment
has no traffic feed and no transit feed.** The UI may say "12 min walk", "3.2 km drive",
"Route unavailable", "Estimated travel time" (estimates only) and "Routed using
OpenStreetMap road data". It may never say "live traffic", "fastest right now",
"real-time conditions", "transit route" or "guaranteed accessible". The wording is
centralised in `lib/routing/format.ts` and asserted in tests rather than left to
reviewers to remember.

### AI planners — free-first, provider-independent

**No model provider is required to run this project.** Generation has three modes and the
default needs no configuration at all.

`lib/ai/` is the boundary. The pipeline never talks to a provider; it talks to a
`StructuredGenerator` — `{id, model, generate(request)}` — and gets back one of three arms:

| arm | meaning |
| --- | --- |
| `success` | a value, plus the provider and model labels |
| `refused` | the model declined. Not worth retrying |
| `unavailable` | with a reason from a closed set: `not_configured`, `rate_limited`, `timeout`, `provider_unavailable`, `invalid_response`, `empty_response`, `aborted`, `unknown` |

**No provider response object crosses that boundary** — not a Gemini `candidate`, not an Ollama
message, not an HTTP status. Those live and die inside `lib/providers/ai/*`.

#### The three adapters

**Gemini** (`lib/providers/ai/gemini/`) — REST over `fetch`, no SDK, matching every other
provider in this codebase. `responseMimeType: "application/json"`, `temperature: 0`, key in the
`x-goog-api-key` header rather than the URL. The JSON Schema is embedded in the prompt rather
than sent as `responseJsonSchema`: the accepted dialect is a moving subset across model versions
and a rejected schema is a hard 400 that takes the feature down for everyone, whereas a
prompt-embedded contract degrades into a repairable drift. `outputSchema` is the authority
either way.

Three response shapes are all legal HTTP 200 and all handled explicitly: a normal answer; a
prompt-level block with `promptFeedback.blockReason` and **no `candidates` key at all**; and a
candidate with a `finishReason` and no content. Checking `promptFeedback` before indexing into
`candidates` is the single most likely production crash in a pipeline like this, and it is
asserted in the tests.

**Ollama** (`lib/providers/ai/ollama/`) — `POST /api/chat`, `stream: false`, `num_ctx: 32768`.
Here the schema **is** sent, as `format`, because Ollama compiles it to a sampling grammar — the
difference between an 8B model producing valid JSON and producing something close to it.
`lib/ai/json-schema.ts` inlines `$ref`s and rewrites `oneOf` to `anyOf` for exactly this
consumer. A grammar polices shape, not truth: a schema-valid fabricated `placeId` is still
caught by `validate-assembly.ts`.

A 200 carrying `{"error": "model 'x' not found, try pulling it first"}` is the common real-world
failure and is a first-class field, not a parse error.

**Deterministic** (`lib/providers/ai/deterministic/`) — the free path, and not a stub. It
implements the same interface, its output goes through the same validators, and its places come
from the same real Overpass search. It selects **real places**; its **prose is generic and says
so**, because writing "Alfama's medieval streets still run narrow" from a lookup table would be
inventing local knowledge — the same offence as inventing a restaurant, in a harder form to
catch. No clock, no randomness: the same request produces byte-identical output.

Its plans carry `source: "mock"`, so the template banner appears for them. Labelling template
output `"generated"` because it used the same pipeline would be the substitution this phase
exists to prevent.

#### Provider selection

`lib/providers/ai/config.ts` is the only module that reads AI environment variables.
`ROAMLY_AI_PROVIDER` is `auto` by default and resolves: Gemini if `GEMINI_API_KEY` → Ollama if
`OLLAMA_BASE_URL` → deterministic.

**An explicit demand that cannot be met returns `not_configured` and does not fall back.** That
is the difference between free-by-default and quietly dishonest: a traveller who chose "Generate
with AI" and received a template itinerary labelled as AI output has been misled about how their
plan was made. The fallback chain exists only inside `auto`.

Selection makes **no network request**. Nothing probes Ollama — a probe would add a speculative
call to a path chosen for being offline, and would let a browser discover whether someone's local
server is running. `GET /api/ai/status` therefore answers instantly, with booleans and one
display label: no key, no host, no model id.

#### The two-call pipeline, and what each call may produce

| | strategy call | assembly call |
| --- | --- | --- |
| **may produce** | destination and practical prose, base *area* name, search radius, day themes, pace, meal-slot requirements, allowlisted categories, budget **shares** | day structure, `placeId` per slot, order, times, descriptions, cost amounts, backups, non-place blocks |
| **may never produce** | any place, id, coordinate, address, rating, price-as-fact, route figure | anything a provider supplied — names, coordinates, addresses, ratings, opening claims, route durations, geometry |

Budget allocation is **shares summing to 1**, not amounts. A model asked for currency amounts
produces arithmetic, and arithmetic is the one thing it must not be trusted for — every total is
recomputed by `lib/plan/derive-totals.ts`. Shares are a real planning judgement, are
currency-free, and reconcile against 1 by a check the model cannot fudge.

#### Mechanical enforcement: the scan Zod cannot do

`z.object().parse()` **strips** unknown keys. A model returning
`{"placeId": "osm:node:1", "latitude": 38.7, "rating": 4.6}` parses cleanly and the fabrication
silently disappears — the invention does not reach the plan, but nobody learns it was made.

So `lib/ai/prohibited.ts` scans the **raw** payload before it is parsed, by key, in three
families: identity, provider facts, routing facts. A hit is a **hard failure**, never a strip and
never a repair — a model that asserted a coordinate will assert a different one if asked again.
`placeId` is the single allowance, and only for assembly.

That is why `StructuredGenerator.generate` returns `unknown` rather than the schema's type: if the
adapter parsed, the evidence would be gone before the validator saw it.

#### The candidate-pool prompt boundary

`lib/generate/candidates.ts` builds what the model sees. Every field is copied from the canonical
record or omitted; nothing is computed, scored or defaulted. There is deliberately **no**
relevance score, quality signal, popularity figure or distance — any score we could compute from
OSM tags would be our opinion dressed as data, and the model would reason about it as a fact.
`openingHours` is carried verbatim and labelled uninterpreted. Order is the pool's own, so the
same pool always produces the same prompt.

Bounded: ≤120 candidates, capped per category, and the cap is applied *before* the pool is built
so the pool is exactly what the model saw and exactly what validation checks against.

#### Discovery: bounded where it can be audited

`lib/generate/discovery.ts` turns a strategy into one `VerifiedPlacePool`. The caps are enforced
here rather than trusted to the model: ≤3 Overpass requests, ≤8 categories each, a radius clamped
here and again by the query builder, ≤150 pool places. Requests go out concurrently and the
process-wide limiter still paces them at one per second — issuing them together lets the limiter
own the pacing instead of duplicating it.

`Promise.allSettled`, not `all`: one batch failing must not lose the other two. A category that
returns nothing produces a warning and an empty bucket — never a substituted category, never a
widened retry, never a fabricated place. The assembly call is told which categories came back
empty so it can mark those slots unavailable rather than guessing why its options are thin.

#### Canonical attachment

`lib/generate/assemble-plan.ts` looks a `placeId` up in the pool and attaches **the pool's
record, unchanged**. The model's `description` becomes `rationale`, which is editorial and meant
to be its own; the name, coordinates, category, address and source identity come from the record
Overpass returned, and no code path writes any of them. A lookup miss throws rather than
skipping the item — validation already proved membership, so a miss is a pairing bug that would
otherwise appear as a silently shorter itinerary.

`assertItineraryUsesPool` then runs on the **finished plan**, including backups. It is not a
repeat of `validate-assembly`: that checked what the model *said*, this checks what was *built*,
and it catches an attachment bug no output validation could see.

#### Money: allocate, do not certify

`lib/plan/cost-bands.ts` holds typical costs by kind of place, per currency. A model may propose
an amount; it is **clamped into the band** for its category and party size, and every clamp is
recorded as a warning rather than applied silently.

Each currency has its own hand-written table and **none is derived from another by a rate**. That
is a deliberate refusal: a rate is a live financial fact with a timestamp and we have no feed for
one, so inventing today's EUR/AED rate would be a fabrication that nobody could see. Independent
tables are also simply more accurate — a coffee in Dubai and a coffee in Lisbon do not differ by
an exchange rate. The consequence, stated plainly: these are figures for a typical destination in
a typical season, and every one is labelled an estimate.

Every generated item carries a `CostEstimate` with `basis: "category-estimate"`, a confidence and
a required disclaimer. `basis` and `currency` are claims about where a number came from and are
ours to make, so a model claiming `provider-tag` or another currency is rejected rather than
corrected.

#### Bounded repair

One strategy repair, one assembly repair, no recursion, and no transport-level retry underneath —
a ceiling of four model calls per generation.

The repair prompt is the original instruction plus an addendum, so the contract cannot drift into
two descriptions. Permissions are a closed list: reselect from the **same** candidate list, drop
an optional stop, reschedule, reduce a cost, or use the `unavailable` arm. The candidate list is
re-sent unchanged — no new search happens during a repair.

Identity violations are **unrepairable** and fail the whole generation: `place_outside_pool`,
`backup_outside_pool`, `prohibited_field`, `pool_violation`, `attached_place_mismatch`.

#### Refusal, empty output and every other failure

A refusal, an empty candidate list, truncation at the token limit, malformed JSON, an HTML body,
a 429, a timeout and a caller abort each map to a distinct arm with a plain-language message.
Leniency in `lib/providers/ai/parse.ts` is limited to exactly two accommodations — unwrapping a
markdown fence, and trimming prose around a single balanced object. There is **no repair**: no
quote-fixing, no trailing-comma stripping, no brace-balancing. Truncated output fails, because a
half-parsed itinerary is indistinguishable from a complete one downstream.

**A failed real generation is never silently replaced with demo output.** The traveller is told
what happened and chooses.

#### Generation context, persistence and lifecycle

The exact pool travels with the trip, in the **stored envelope** rather than on the `TripPlan`:

```ts
StoredTripRecord = { revision, createdAt, updatedAt, plan, generation }
TripGenerationContext = { schemaVersion, provider, model, generatedAt, destination,
                          placePool, discoverySummary, warnings, routingPolicy }
```

Why not on the plan: which model produced a trip, and how many Overpass queries it took, are
facts about a *run*. On the plan they would pollute every fixture, make two identical itineraries
compare unequal, and reach the routing endpoint, which has no business seeing them. In the
envelope they are written in the same `set` call as the plan, so no generated trip can exist
without its pool, and one `revision` covers the pair.

Why the pool is retained rather than re-derived: `derivePlanPlacePool` builds a pool from the
places a plan already uses — the plan checking itself, which would happily validate a fabricated
place. The retained pool is the **actual search result set**, including candidates the itinerary
did not choose, which is what makes the no-invention claim evidence-backed. It is now the normal
path; `derivePlanPlacePool` is a clearly-labelled legacy fallback for the sample trip and for
anything saved before generation existed.

`TripRecordSchema.generation` is `.nullable().default(null)`, so a pre-5B record parses unchanged
and `STORE_VERSION` stays at 2. The pool is re-validated on read, so a corrupt one drops the
record rather than rendering it.

A routing write passes `generation` through untouched; a regeneration replaces it, under the same
optimistic-concurrency guard, incrementing once. `TRIP_PLAN_SCHEMA_VERSION` stays at **3**: the
Phase 5B changes are widenings (`source` gains `"generated"`, `ItemKind` gains
`transport`/`logistics`, `costEstimate` is optional) plus `accommodation` becoming nullable, and
every stored plan still parses.

#### Streaming, and what is deliberately not streamed

`POST /api/trips/generate` serves `text/event-stream` when asked and plain JSON otherwise — the
same pipeline either way, which keeps `curl` and the test suite on the browser's code path.

Progress events are stage names, emitted when that work actually begins, so the progress a
traveller watches is a report rather than a timed animation. **No part of the plan is streamed.**
The itinerary is buffered, validated in full, and delivered once as a `result` event. Streaming
partial itinerary JSON would mean a renderable half-plan existed, and a half-plan that looks final
is the failure this codebase spends its effort preventing. Cancelling aborts every model call and
every Overpass request through one signal.

#### Serverless duration budget

One strategy call, bounded discovery, one assembly call, at most one repair per stage, then
validation and building. `maxDuration = 120` on the route, against an internal 90 s budget
(`GENERATION_BUDGET_MS`) threaded through everything as a single `AbortSignal`. The internal
budget is the real limit: it stops all work together and returns a controlled timeout rather than
letting the platform kill the function.

**Deployment limitation, stated plainly.** Vercel's Hobby tier caps a function well below 120 s.
A slow local model or a loaded Overpass can exceed it, and the traveller then sees a network
failure rather than our timeout message — nothing is saved either way. The mitigations are the
deterministic planner, which makes no model call, and Gemini Flash, which is fast. A platform with
a longer ceiling removes the issue.

#### Pace and routing policy

`lib/generate/pace-policy.ts` derives the walking threshold from `TripRequest.pace` — 1.2 km
relaxed, 1.8 km balanced (the shared default, so a balanced trip routes identically to an
ungenerated one), 2.5 km packed. The model shapes the *day*; it does not move the ruler the day is
measured with. The policy is recorded in the generation context and applied when routing runs
later, so a trip generated as relaxed is still routed as relaxed a week afterwards.

### Refinement — safe edits to a saved trip (Phase 6A)

Generation produces a trip. Refinement changes one part of it without weakening a single
invariant that produced it: no invented places, every place from the exact saved
`VerifiedPlacePool`, canonical provider facts, `placeId`-only model output, route
measurements never model-edited, and one atomic guarded save.

#### The command model

A closed Zod union in `lib/refinement/commands.ts`:

| command | what it changes |
| --- | --- |
| `regenerate-trip` | the whole itinerary, from the same pool; optional `preserve` |
| `replace-item` | one place-backed stop |
| `replace-backup` | one fallback option |
| `adjust-day` | one day — `cheaper`, `more-relaxed` or `more-packed` |
| `retry-routes` | routing only — `unavailable-only`, `all`, or explicit `legIds` |

**No free text.** A prompt-shaped field would be an instruction channel: it could ask for a
place that was never discovered, a different destination, a currency conversion or a route
duration, and the schema would be no defence. Constrained actions also make the result
checkable against the action's *own promise* — see below.

There is nowhere in the union to put a coordinate, a duration, a geometry, a place name as
identity, or a mutation instruction. Tests assert those keys are stripped rather than accepted.

#### Which actions need a planner

`regenerate-trip`, `replace-item`, `replace-backup` and `adjust-day` do.
`retry-routes` — and every validation, re-keying, attachment, total and save — does not.

`resolveRefinementProvider` has one rule, and `lib/refinement/eligibility.ts` is its
client-safe restatement so the panel, the per-stop action and the per-backup action cannot
disagree:

- a trip generated by **Gemini or Ollama** needs a real model. With none configured the AI
  actions are *disabled with the reason shown*, and route retry keeps working. The demo
  planner is **not** substituted — that would put template output inside a plan labelled as
  model-generated.
- a trip built by the **demo planner** may be refined by the demo planner. That is the same
  planner doing the same job, and refusing would make the keyless path a dead end: plan for
  free, then be unable to change it.

`lib/providers/ai/deterministic/refine.ts` implements that path — nearest eligible candidate,
and `unavailable` with a reason when the day offers no such move. It will not shave an
estimate to satisfy a "cheaper" button, because lowering a figure to make a number go down is
how an estimate becomes a fiction.

#### The provider boundary is unchanged

One new operation, `refinement`, on the existing `StructuredGenerator`. No second AI-client
architecture. Output schemas are deliberately tiny — `ReplaceItemResult` is a `placeId`, a
description, a cost and an optional window — because asking for a whole `TripPlan` back to
change one line would mean revalidating five days and would give the model an opening to
alter four days nobody asked about.

**One model call per refinement, and no repair.** Generation allows a repair because an
itinerary has many ways to be slightly wrong; a refinement asks for one place out of a
supplied list, and a model that answers *that* wrongly is not going to be talked round.

#### Candidate subset derivation

`lib/refinement/candidates.ts` is the single authority. It filters by facts only — pool
membership, category, already-in-use, bounded distance from the stop being replaced, an
explicit preference — and **invents no score of any kind**. Ordering is *distance from the
anchor, then name, then `placeId`*: distance is a real, checkable property and a nearer
replacement genuinely preserves the day's shape, which is a claim about geometry rather than
about the place.

Two details that matter:

- an **empty** category list means "nothing is eligible", not "no filter". `filterForReplacement`
  produces one when a preference rules out every category, and collapsing that into "no
  filter" would offer every kind of place instead of admitting the request cannot be met.
- for a **day adjustment**, a place that is currently only a *backup* is schedulable
  (`includeBackups: false`). A backup is not a stop, and promoting one is often the obvious way
  to make a day cheaper or fuller.

`cheaper` is deliberately *not* a filter: cost bands are per category and a replacement
preserves the category, so every candidate shares one band. It is passed as a preference about
the allowance and then verified.

#### Verifying the action's own promise

The distinctive part of this phase. A model can return a perfectly valid day that costs more
than the one it replaced, so `validateAdjustmentHonoured` checks the claim against the
*previous* day:

- `cheaper` — the day total did not go up
- `more-relaxed` — the stop count did not go up
- `more-packed` — the count did not fall, and did not exceed the pace cap
- every meal the day covered, it still covers

That last one is **relative on purpose**. An earlier version asked the *new* day which meals
it required, which is vacuous: a day that dropped its breakfast no longer claims to have one.
The baseline has to be the day being replaced.

A refinement that did not do what the button said is a failure, not a result.

#### Route invalidation, in one rule

The brief lists five situations — replace, remove, add, reorder, regenerate — each with its
own legs to invalidate. They collapse into one rule, because a leg id **is** its adjacency:

```
day:{n}:from:{itemId}:to:{itemId}:mode:{mode}
```

So `rekeyDaySegments` derives the new expected-leg set and keeps exactly the segments whose id
is in it. A replaced stop gets a **new item id** — deliberately, since reusing it would let the
previous place's routes survive re-keying and put real geometry on a journey nobody makes. A
mode change also changes the id, so a stop that moves 3 km cannot keep its walking result.

Nothing compares array positions: a plan that gains an unavailable slot shifts every later
index, and a position-keyed implementation would reattach every result to the wrong leg. This
is exactly what `lib/routing/leg-id.ts` was built for.

Invalidation is then **measured, not reported**: `invalidatedLegIdsBetween` diffs the segment
ids of the two plans. An accumulated count was wrong twice — an applier clears a replaced
stop's own segment before re-keying can see it, and regeneration builds a fresh plan that never
held the old segments — and both produced an empty list beside a plan whose routes had visibly
gone.

`totalTravelMinutes` and the coverage summary are recomputed afterwards, and dropped entirely
when no segment survives.

#### Pool-stable regeneration

Regeneration reuses the generation pipeline with `existingPool` supplied, which skips discovery
altogether: **no Overpass request, no geocoding, and provably the same universe of allowed
places.** The strategy call is additionally told which categories the pool actually contains,
so it does not plan for a category that would come back empty by construction.

`preserve` constraints are passed to the assembly call *and* verified afterwards by
`validatePreserved` — a constraint that is only requested is a preference.

A **pool refresh** — genuinely re-searching — is a materially different operation, because it
changes what places exist. It is deliberately not offered here.

#### Atomic persistence and one-level undo

`applyRefinement` writes the plan, the generation context and the undo snapshot in one `set`,
under the expected revision. A stale expectation writes nothing.

`StoredTripRecord.previousSnapshot` holds one level: the plan and context immediately before
the last refinement. A history sounds strictly better and is not — it grows without bound in
`localStorage` (a plan plus its pool is ~90 KB), needs pruning rules nobody gets right, and
invites a version-browser that is a different product.

Undo restores it **forwards**: the revision increments. Decrementing would make two different
states share a revision number, which is precisely what the guard exists to distinguish.

**Routing is not undoable, and that is a decision rather than an omission.** A route
calculation adds provider facts and takes nothing away, so undoing it would discard real
measurements for nothing — and it would consume the single slot the traveller's last
*refinement* is entitled to. Recalculating is idempotent anyway.

#### Refinement provenance

`TripGenerationContext.latestRefinement` records the provider, model, action and timestamp of
the most recent **AI** refinement. Optional, so every pre-6A record parses unchanged and the
context's `schemaVersion` stays at 1. Absent for a deterministic refinement — there is no model
to attribute — and absent for routing, which adds facts rather than planner choices. No prompt
and no raw response is ever stored.

#### Targeted route retry

`routeTripPlan` gained `retryLegIds`, and `POST /api/trips/route` accepts it. Same expected-leg
derivation, same service, same immutable builder — a parallel implementation would be a second
answer to "which legs exist", and the whole enrichment contract rests on there being one.

Ids are deduplicated and **intersected with the plan's currently expected set**, so an id from
a stale render cannot become a provider request. Legs not named keep the segments they already
have, which is what makes it a retry rather than a reroute. `unavailable-only` excludes retained
estimates: an estimate is not a failure, and including it would make "retry the failures"
quietly mean "route the whole trip".

#### Failure and rollback

`POST /api/trips/refine` persists nothing, `maxDuration = 90` against a 60 s internal budget,
and the `refused`/`unavailable`/`failed` arms carry **no plan**. So rollback is structural:
there is nothing to undo because nothing was written. Identity violations —
`place_outside_pool`, `prohibited_field` — fail outright rather than being repaired.

### Structural itinerary editing (Phase 6C)

`lib/structural-edits/` is pure and client-safe: it takes a plan plus its generation context and
returns a new pair. The browser applies these edits itself under the same revision guard a
networked refinement uses, because there is nothing on the other side of an endpoint for them.

#### The command model, and why a position rather than an index

`promote-backup` and `move-item` share one `TargetPositionSchema`: `before`/`after` naming a
neighbouring item, or `end`. An index is a fact about an array, and an array that gained or lost an
entry between the render and the click makes the number mean something else — the classic way a
"move to third" lands somewhere nobody asked for. Naming the neighbour makes the request a fact
about the *itinerary*, and an id that has gone is a clean refusal instead of a silent
misplacement.

Neither command can express a coordinate, a place name as identity, a duration, a distance, a
geometry or free text, and the schema strips anything it does not declare — asserted in tests.

#### One commit path

`commitStructuralEdit` is the only place an edit becomes a plan. It re-validates every touched
day's schedule against **the day as it was** (so meal coverage cannot be checked vacuously),
re-derives the day totals and the two item-derived budget categories, re-keys every leg in the
plan, re-parses the plan, and re-checks pool membership. `invalidatedLegIds` is **measured** by
comparing before and after — Phase 6A learned that an applier which clears a segment before
re-keying can see it reports nothing beside a plan whose routes have visibly gone. `addedLegIds`
is measured against the *expected* leg set rather than the stored segments, so a trip that has
never been routed does not report all eleven of its legs as newly created.

One deliberate cost: the final `TripPlanSchema.safeParse` rebuilds the plan, so unrelated items
come back deep-equal rather than `===`. The parse is kept because a structural edit is the change
most likely to produce a shape the schema would reject.

#### Backup promotion

Permitted only when the backup exists on the named day, its place is in the **active** pool, the
target day and position exist, and the resulting schedule is valid. A retained place is refused
with its own error code: promoting is a *new selection*.

A **new** item id is minted (`<backupId>-p<n>`) rather than reusing the backup's — the legs around
the insertion point measured journeys between a different pair of places, and a surviving id would
attach real geometry to a journey nobody makes. The **promoted backup is removed** and recorded in
`summary.removedBackupIds`; undo restores it, because the snapshot holds the whole plan.

#### Cross-day movement

The item id is **stable** — a move is the same stop in a different place, and a new id would
invalidate the legs either side of where it *lands* as well as the ones it leaves. Dates and trip
length never change. `transport` and `logistics` items are locked: they are anchored to the trip's
edges by the dates, and an arrival transfer on day three would describe a journey that does not
happen. A move that would empty the source day is refused, because `ItineraryDaySchema` requires
at least one item. Costs travel with the stop; both days' totals are recomputed.

#### Deterministic time placement

`resolveInsertionTimes` uses the traveller's explicit times when given — validated against the
window the neighbours at the *chosen position* leave, not merely against the day, because
`validateSchedule` sorts by time and a day would otherwise silently reorder itself away from what
was asked for. Otherwise it places the stop as early as the window allows on a five-minute grid,
honouring `minTransitionMinutes` between two real visits, the day's bounds, and either the moved
item's own duration or a documented per-`ItemKind` default for a promotion.

"As early as possible" is chosen because it is predictable without knowing the algorithm. When
nothing fits, the edit **fails** with `no_slot_available` and the interface offers exact time
fields — no model is asked to invent a slot, and no stop is inserted at an impossible time.

### The place pool's lifecycle (Phase 6C)

#### Age is a fact about a cache

`describePoolAge` reports `fresh` (under 7 days), `aging` (under 30), `stale`, or `unknown`, from
an instant passed **in** — a component reading the clock during render is the classic hydration
mismatch. Every string says "may be outdated" and never "is outdated": OSM data for a monument may
not change in a decade, and a café can shut the week after a refresh. The thresholds exist so a
traveller can decide whether a search is worth it, and for nothing else. Asserted in tests: the
label never contains "closed", "invalid" or "no longer".

#### Refresh is a preview, then a commit

`POST /api/trips/refresh-pool` (`maxDuration = 60`, 45 s internal budget) re-runs the search
through the *same* `discoverPlaces` adapter, batching, ordering and pool-id construction as
generation — sharing the derivation is what makes the diff mean something rather than reporting
differences that came from the code. It does not geocode: the trip's stored OSM identity is used,
because re-geocoding "Lisbon" could resolve to a different Lisbon and silently move the trip. It
calls no model and no routing service, and persists nothing.

It returns a pool, a diff, and a reconciliation preview **per policy** — both from one search, so
changing one's mind at the confirmation step costs no second Overpass request. A failed batch is
reported as `partial`: "Overpass did not answer for museums" and "there are no museums here" look
identical in a pool and mean opposite things, and without the flag a timeout would present as
every museum having vanished. An empty result is a hard failure rather than an empty pool.

The flow is confirm → search → see the diff → choose a policy → confirm. Nothing is written until
the last step, and the revision is **re-read** at that point rather than taken from the echoed
token, because the search took seconds and another tab may have moved the record.

#### The diff

Identity is the canonical id and nothing else. Names are never matched: "Café Buenos Aires" and
"Cafe Buenos Aires" are string-different and place-identical, while two "Manteigaria" branches are
string-identical and place-different, and name matching gets both wrong in opposite directions.
Facts are compared separately from identity, so a mapper's corrected name appears in
`changedCanonicalRecords` rather than as one place gone and another arrived. Coordinates get an
explicit 25 m tolerance — OSM geometry drifts by metres as it is refined — and every other field
is exact. Every list is sorted, so the same two pools always produce a byte-identical diff.

#### Reconciliation, and the retained legacy place

A refreshed search can lose a place the itinerary is built on, and that says almost nothing about
the place: a mapper retagged it, the radius moved, one batch timed out. So neither policy picks a
replacement.

  - **`keep-valid-and-flag-missing`** — the itinerary is untouched and the missing place moves into
    `TripGenerationContext.retainedPlaces`: out of the pool, explicitly recorded with a date and a
    reason, excluded from every candidate list, and flagged in the interface.
  - **`replace-missing-with-unavailable`** — the stop becomes an open slot with the reason
    attached, exactly as generation does for a slot it could not fill; its routes are invalidated,
    its marker disappears, and the totals fall.

A place still in the pool has its attached record **refreshed**, which is the point of the
operation and is also required — `assertItineraryUsesPool` demands the attached copy be faithful.
A backup whose place has gone is removed under either policy, because a retained place cannot be
promoted and an unavailable backup is an offer to swap in nothing.

#### The widened pool invariant, stated exactly

> Every *newly selected* place must belong to the active pool. An existing itinerary reference may
> resolve to a retained place only when that place is recorded in `retainedPlaces` and is still
> used by the plan.

`assertItineraryUsesPool` gained an optional retained list; generation, refinement and routing all
still pass none, so every path that existed before is exactly as strict as it was.
`validateRetainedPlaces` pays for the loosening: a placeId in both the pool and the retained
collection is a hard failure (otherwise "did the latest search find this?" has two answers), a
retained entry nothing references is a hard failure (otherwise the collection accumulates into a
second pool), and the collection is capped at 48. Candidate derivation reads the pool, so retained
places are excluded mechanically rather than by a filter someone has to remember.

#### Undo

Unchanged: `applyRefinement` captures the plan *and* the context as the one-level snapshot in the
same write, so undo restores plan, active pool, retained places, backups, routes, schedule state
and estimates together, and increments the revision forward.

### Browser storage: quota, export and import (Phase 7)

#### The pre-flight, and why it is not a rollback

Zustand's `persist` middleware writes to `localStorage` **after** the state update. A quota failure
therefore arrives when the store already holds the new trip: the traveller sees their change applied and
it disappears on the next reload — a failure that looks like success, which is the worst shape available.

`lib/store/capacity.ts` probes instead. It serialises the candidate state, writes it to a scratch key,
removes the key in a `finally`, and reports whether the real write would have thrown. Every guarded save
— generation, refinement, structural edits, pool refresh, import — calls it before `set()`.

The alternatives were worse. Catching and rolling back means the state briefly held a value that was never
persisted, and any render in between shows it. Replacing the storage adapter to write synchronously inside
the reducer means reimplementing the persist envelope, which then drifts from what the middleware writes
on ordinary updates.

It is not a quota calculation. It never asks how much room there is — no browser reliably answers that —
only whether *this value* fits, which is a question with a real answer.

#### Two numbers that are never divided

`measureTripStorage` reports exactly what the app stores, by serialising the records.
`navigator.storage.estimate()` reports the whole origin, is documented as an estimate browsers may fuzz,
and is absent in some private modes. They are shown side by side and never as a percentage: dividing an
exact figure by a fuzzed one is wrong in two directions at once. When the browser declines, the interface
says the quota is unknown rather than assuming 5 MB.

Measured figures, from `lib/store/storage-resilience.test.ts`: **14 KB** per trip, **28 KB** with an undo
snapshot, **330 KB** for twelve, **79 KB** with a ~130-place pool. A dozen routed trips with full pools
lands near 1.9 MB against a conservative 5 MB origin budget.

#### Import treats the file as hostile

Export is a copy of what `localStorage` already holds — which is what makes it safe, since no prompt, key
or raw provider payload is in a stored record to begin with.

Import is the one path where a traveller hands over a whole `TripPlan` rather than a `placeId`, so it runs
every gate a generated plan runs: the record schema, then `validatePlanMembership`, then a re-parse at the
store boundary. Version checks are **equality**, not "at least" — a file from a newer build may describe a
shape this build cannot render. The size ceiling is `file.size` (real bytes, no read) with the string
length as a backstop.

A copy gets a new id, a fresh revision line and **no** inherited undo snapshot: an inherited one would let
undo walk a copy back to a state the copy never had. Provenance is preserved — an imported Gemini trip
still says Gemini, because that is what happened. A replacement runs under the ordinary revision guard,
with the plan it replaces captured as the snapshot in the same write.

### Offline behaviour (Phase 7)

`navigator.onLine` is asymmetric: `true` means an interface is up, not that Overpass is answering, while
`false` is reliable — no browser reports offline while a request would have worked. So `false` drives one
thing, **not starting requests that cannot succeed**, and `true` means only "worth trying". Provider
failures while nominally online are still handled by the paths that already existed.

There is no service worker, so a hard reload with no network loads nothing, and the copy never claims
otherwise. What works offline is everything already in memory and in `localStorage`: reading trips,
opening-hours checks, cost recalculation, structural edits, export and import.

### Operational logging (Phase 7)

One JSON object per line, via `console.log`, because that is the interface a serverless platform already
collects. No log-shipping SDK and no analytics.

`lib/providers/log.ts` filters through a **field allowlist** rather than a denylist. That direction is the
point: a future caller who passes `{ destination }` in a hurry gets a log line without it, instead of a
leak. Nothing about the trip is logged — not the destination, a place name, an itinerary, a typed note, a
prompt, a model's output or a provider's raw response. A destination plus dates is enough to know when
someone's house is empty. Place ids are omitted too: a full set of them *is* an itinerary, and "just the
ids" is how a log becomes one by accident.

Failures log the error's **class name**, never its message — a provider's message can name a host.

### Map rendering — MapLibre GL JS + OpenStreetMap

**No Google Maps, no API key, no cloud project, no billing account.** The map is
[MapLibre GL JS](https://maplibre.org) (BSD-3) driven through `react-map-gl`'s MapLibre entry point,
rendering OpenStreetMap-derived vector tiles. The whole app runs and deploys without a payment card.

#### The adapter boundary

`lib/map/types.ts` is the contract. The workspace passes plain data across it and imports no map
library type anywhere:

```
TripPlan ──► lib/map/derive.ts ──► VisibleMapPlace[] ──► components/map/map-panel.tsx
                                                              │
                                        ┌─────────────────────┴─────────────────────┐
                                        ▼                                           ▼
                          components/map/trip-map.tsx                   components/map/map-fallback.tsx
                          (the ONLY MapLibre import)                    (schematic, no WebGL needed)
```

`VisibleMapPlace` carries `itemId`, `placeId`, `sequenceNumber`, `name`, `latitude`, `longitude`,
`kind` (`"stop" | "accommodation"`) and `dayNumber`. Map instances, viewport state and style objects
never travel the other way — they are absent from the Zustand store, the trip schemas, the itinerary
components, and anything persisted to localStorage. Replacing MapLibre means rewriting `trip-map.tsx`
and nothing above it.

`itemId` is the handle for *selection* and matches the itinerary card. `placeId` remains canonical
place identity. Markers are keyed by `itemId`, never by array index — a day change refilters and
reorders the list.

#### Basemap source, isolated

`lib/map/basemap.ts` is the only file naming a tile or style host. Currently OpenFreeMap's `positron`
style — key-free, billing-free, OpenStreetMap-derived. Swapping to a paid hosted provider, or to a
self-hosted OpenMapTiles/Planetiler deployment, is an edit to `BASEMAP_STYLE_URL` alone.

**OpenFreeMap is donation-funded and suitable for a low-traffic portfolio demo, not production.**
Before this carries real users, move to a dedicated provider or self-host. We must not work around
those limits: no bulk tile downloads, no offline tile caching, no prefetching beyond the viewport, no
stripping of identifying headers.

#### Attribution is mandatory

OpenStreetMap credit must stay visible and legible. The style's TileJSON carries it, and MapLibre's
`AttributionControl` renders it with `compact={false}` so it is never hidden behind a toggle. The
fallback renderer has no TileJSON, so it prints `OSM_ATTRIBUTION_TEXT` itself. The basemap is warmed
with a CSS filter on `.maplibregl-canvas` only — attribution and markers are DOM siblings of the
canvas, so neither is tinted.

#### Camera ownership

`components/map/use-map-camera.ts` is the only code that moves the map. Three concerns, three
effects, deliberately separate because they fire on different triggers:

| Trigger | Behaviour |
| --- | --- |
| Day change | Refit bounds of visible places, padded, capped at `MAX_FIT_ZOOM`. Keyed on day + place identities, **not** on selection. |
| Selection | Pan only when the marker is outside a 12%-inset viewport. Zoom is never touched. |
| Becoming visible | `map.resize()`, then refit only if never fitted at real dimensions, or if the container's geometry changed by >10% since the last fit (rotation, breakpoint crossing). |

Zero places leaves the camera alone; one place — or several at identical coordinates — centres rather
than fits, because every map library resolves a zero-span box by zooming to maximum.

#### Sequence line, not a route

`lib/map/sequence.ts` emits one GeoJSON `LineString` per day, drawn by a single MapLibre line layer
(not one overlay per segment). It joins consecutive stops with straight lines and represents **visit
order only**. It does not follow roads, rails or footpaths, it is not produced by a routing engine,
and no distance or duration may be derived from it. Real travel figures live on `TravelSegment`,
sourced separately. Accommodation is excluded, and no line ever bridges the last stop of one day to
the first of the next.

Routed paths arrived in Phase 4 as a *second*, visually distinct layer (`lib/map/routes.ts`). They do
not replace this one, because "the order I visit things" and "the path I walk between them" are
different facts — see *Sequence line versus real route geometry* in §5.

#### Failure strategy

The itinerary must stay usable whatever the map does, so every failure lands on `MapFallback` — the
Phase 1 schematic, still interactive and still showing the day's shape — rather than an error box.

| Condition | Result |
| --- | --- |
| Chunk still loading | `MapSkeleton`, matching the panel's footprint |
| WebGL unavailable | Fallback + plain-language message |
| Style or tile failure (`onError`) | Fallback + plain-language message |
| Throw during render | `MapErrorBoundary` → fallback; workspace unaffected |

Messages never expose provider names, stack traces or the word WebGL. Diagnostics are logged in
development only.

#### What the map excludes

An itinerary item gets a marker only when `isMappableItem()` holds: `status === "confirmed"` **and**
`place !== null`. An unfilled slot (see §4) or a placeless item — a free afternoon — still appears as
a card, so the gap is visible, but has no marker. Numbering comes from the itinerary, so the map's
numbers can have gaps: card 3 unavailable means no marker 3, which is correct. Renumbering would make
a card and its marker disagree.

---

---

## 5A. Plan enrichment — the immutable builder

Phase 4 could route a list of coordinates. Phase 5A is what connects that to a *saved
trip*: given a plan and its pool, derive the legs, route them, and produce a **new** plan
whose totals, coverage and geometry all agree with the segments attached to it.

Deterministic throughout. No model makes any decision in this layer.

### Canonical versus derived

The rule is that a caller-supplied derived value is never trusted — it is recomputed and,
if the recomputation disagrees, the enrichment fails rather than shipping a plan that
contradicts itself.

| Canonical (copied through) | Derived (always recomputed) |
| --- | --- |
| itinerary order, item ids, `placeId` references | `item.travelToNext` |
| dates, times, `kind`, `status`, `rationale` | `day.totalTravelMinutes`, `day.dayTotal` |
| item `estimatedCost` | `budget.byDay`, `budget.total`, `remaining`, `perTraveler` |
| the five budget **category** amounts | `plan.routing.summary` |
| destination, flights, accommodation, notes | route geometry on the map |

The budget categories (`flights`, `accommodation`, `food`, `activities`, `transport`)
stay canonical on purpose. The schema has no per-item cost category, so there is nothing
to derive them from; "recomputing" them would mean inventing an attribution rule, which
is the quiet fabrication this codebase exists to avoid. `total`/`remaining`/`perTraveler`
*are* derived, because they are pure arithmetic over the categories.

### Stable leg identity

`lib/routing/leg-id.ts` is the one constructor and the one parser:

```
day:{dayNumber}:from:{originItemId}:to:{destinationItemId}:mode:{mode}
```

Every component is load-bearing. **Day**, because the same two places visited on Tuesday
and Thursday are two journeys. **Item ids**, not place ids, because a market visited
twice in one day is two stops. **Mode**, because the walking and driving routes between
the same points are different paths.

Not array position: a day's eligible stops are derived by *filtering*, so leg 2 of the
derived list is not item 2 of the day, and a plan that gains an unavailable item would
silently reattach every result to the wrong leg. Not coordinates either: two stops can
share them. Coordinates are checked as a *fact about* a leg — see the tolerance below.

An item id containing a colon is rejected at construction rather than producing an
ambiguous id nobody can parse. The accommodation's synthetic endpoints
(`@accommodation-origin`, `@accommodation-return`) are hyphenated for the same reason and
prefixed with `@`, which neither `nanoid` nor the mock's id scheme can produce.

### Expected-leg derivation, and why there is only one

`lib/plan/expected-legs.ts` is **the single authority** on which legs a plan expects under
a policy. Routing orchestration asks it what to request, the builder asks it which results
are legitimate, the coverage summary asks it for the denominator, and the tests assert
against it. Every count in this phase — "14 of 18 legs calculated" — is only meaningful
because those four cannot disagree.

It is a thin composition over `deriveDayLegs`, so the skip rules live in one place:
unavailable items and placeless blocks are skipped and the gap is bridged, order is never
changed, no leg crosses a day boundary, and transit has no `RoutingMode` so it cannot
become a routed request. Two consecutive stops less than **10 m** apart are *collapsed* —
that is one location listed twice, not a journey, and routing it would return either a
zero-distance result (which the routed arm forbids) or a nonsense loop.

### The replacement policy

| policy | attempts a leg whose segment is… | replaces |
| --- | --- | --- |
| `preserve-routed` (**default**) | estimated, unavailable, or absent | those three |
| `replace-estimates` | estimated or absent only | those two |
| `refresh-all` | every leg | everything, routed included |

The default never overwrites a fact we already have and never re-requests one, while
still retrying a leg that previously failed. `replace-estimates` additionally declines to
retry known failures. `refresh-all` is the only way to overwrite a routed segment.

Two things never happen under any policy: an old estimate's duration is never combined
with new geometry — a segment is replaced whole or left whole — and a mock estimate is
never presented as a routed fact. Editorial `note` text survives replacement, because it
describes the journey rather than measuring it.

### Coverage, and why the counts reconcile exactly

```
expected  = routed + estimated + unavailable + pending
attempted = routed + unavailable
trip[k]   = Σ days[k]   for every count k
```

`attempted` excludes retained estimates and pending legs: a leg whose estimate was kept
was not asked about under this policy, and a pending leg was never asked about at all.
Folding either in would inflate the denominator of any success rate. `unavailable` is
never folded into `routed`; they are different claims, and that identity has its own
explicit assertion rather than relying on the others to catch it indirectly.

The summary is **built from the finished plan**, not accumulated during the work — a
counter incremented alongside a loop can drift from the loop, whereas a statement about
the plan can be recomputed and re-checked at any time, including on read.

### Travel totals, and never under-counting

`totalTravelMinutes` is retained and now means exactly: **routed durations plus retained
estimates**. An unavailable leg contributes zero minutes; so does a pending one.

That number alone is a lie by omission — twenty minutes across two routed legs and twenty
minutes across two routed legs plus three failures are very different days. So it is never
rendered alone: `deriveDayTravelSummary` produces the routed/estimated split and the
unavailable and pending counts alongside it, and the day header prints "· 1 route
unavailable" next to the total whenever there is one.

`DayTravelSummary` is derived at runtime rather than persisted, because every field is a
pure function of the day's segments and a stored copy could only ever disagree.

### What is persisted, and what is not

`TripPlan.routing` is the **only** new persisted field:

```ts
{ policy: AppliedRoutingPolicy, lastRoutedAt: string, summary: RoutingEnrichmentSummary }
```

It carries the two things that cannot be recovered from the segments: which policy ran
(a different mode policy expects a different number of legs, so "14 of 18" is unreadable
without it) and when. Everything else is derived.

Deliberately **not** persisted: request state, loading flags, retry counters, provider
errors, cache status, map viewport, provider request ids. A saved trip is a record of a
trip, not of a browsing session. Transient job state lives in `lib/store/routing-job-store.ts`,
which has no `persist` middleware at all.

**`TRIP_PLAN_SCHEMA_VERSION` stays at 3.** `routing` is `.nullable().default(null)`, so a
plan saved before this phase parses unchanged and honestly reports "not attempted".
Bumping would discard every saved trip to add an optional field — a cost with no
compatibility benefit.

### Validation invariants

`lib/plan/validate-derived.ts` runs on the builder's **output**, not its input — a builder
that checks only what it was given proves nothing about what it produced. It rejects:

- counts that do not reconcile, at day or trip level
- `totalTravelMinutes` that disagrees with the segments
- `dayTotal` that disagrees with the item costs
- routed geometry with fewer than two points, or a zero measurement
- a result whose leg id, endpoints, mode or coordinates do not match its expected leg

Two invariants are absent because they are **unrepresentable**: `provider` is a literal
`"valhalla"` on the routed arm and `"mock"` on the estimated one, so "a routed segment
claiming mock" cannot be constructed and TypeScript narrows a check for it to `never`.
They are asserted in the contract tests, which is the only place they can be attempted.

Nothing is repaired. A violation returns the `failed` arm with **no plan at all**, because
a plan assembled from mismatched parts is worse than one that was never enriched.

#### The coordinate tolerance, and its limit

**50 m.** The routed result echoes the coordinates we asked for rather than the provider's
snapped ones, so in practice the difference is zero; the tolerance exists in case a future
provider echoes snapped points, and to catch a doctored result. It comfortably absorbs a
road snap and catches a result attached to a wholly different stop, which is the realistic
failure. It **cannot** catch a swap between two stops less than 50 m apart — which is why
leg identity is the primary guard and this is defence in depth.

### Atomic local persistence, and the revision model

Routing a trip takes seconds and many provider calls. In that window the same trip can
change underneath us — a second tab, a restored session, a double press from two places.
Writing unconditionally at the end would silently discard whatever happened in between.

So the write is guarded, in exactly the way a database would guard it:

1. read the record and **capture its revision** (before the await, not after)
2. run the whole enrichment in memory and validate it
3. save under that revision — the store refuses if it moved

```ts
type StoredTripRecord = { revision: number; createdAt: string; updatedAt: string; plan: TripPlan }
```

`revision` starts at 1 and increments once per accepted write. A conflict is returned as
data, not thrown, because "this trip changed in another tab" is information the UI renders
rather than an exception it catches. There is no intermediate state in which a half-routed
plan is saved: step 3 is a single replacement.

The counter lives on the envelope, not inside `TripPlan`. A revision is a property of the
saved record, not of the trip — putting it in the domain would make two plans with
identical itineraries compare unequal and leak the counter into every fixture and API
payload.

`STORE_VERSION` moves 1 → 2 for the envelope, with a **lossless** migration: a v1 entry is
a bare plan, so it is re-validated and wrapped at revision 1 rather than discarded.

### The API: a pure server transformation

`POST /api/trips/route` takes a plan, a pool, a policy and the expected revision, and
returns an enriched plan. **It persists nothing** — the trip lives in the caller's browser,
so the server has nothing to write to and no business writing anywhere else.

Two designs were possible. **(A)** send the plan and transform it server-side. **(B)** let
the browser call the narrow per-day endpoints and run the pure enrichment modules itself.
This is **A**: the plan is ~45 KB and the pool ~11 KB, a comfortable POST, and in exchange
the whole orchestration runs where the provider limiter and cache already live. Under B
the browser would drive the concurrency ceiling — precisely the thing that must not be
client-controllable when it is protecting someone else's donated server.

`expectedRevision` is echoed back untouched. The server does not check it; it has no
storage to check against. It is a token, not an authorisation.

Partial success is a **200** with `status: "partial"` and a complete plan. Only a contract
violation yields `failed`, and only a malformed request or a broken provider yields 4xx/5xx.

### Serverless routing budget

A five-day trip is ~19 legs. At three concurrent requests and a 250 ms gap between starts,
a fully uncached run is roughly 8–15 s, slower when the shared demo server is loaded. So:

| Bound | Value |
| --- | --- |
| `maxDuration` on the route | 60 s |
| Days per trip | 7 |
| Place-backed stops | 24 |
| Derived legs | 23 |
| Provider concurrency | 3 (unchanged) |
| Provider retries | 1 (unchanged, and **not** multiplied by an orchestration retry) |

Over-cap requests throw before any provider call rather than being truncated — routing
four of a traveller's five days and saying nothing would be the worst reading of
"bounded". Cached legs cost nothing, so re-running after a partial failure is cheap. There
is no job queue and no polling; the operation is not claimed to be instant.

### Routed geometry in the production workspace

`lib/map/derive-routes.ts` is the routing counterpart of `deriveVisibleMapPlaces`. Only a
**routed** segment produces a `MapRouteLine`; an estimate has no geometry and an
unavailable leg has nothing to draw, so neither contributes a feature. Day filtering is a
pure partition because every line carries its day, and identity is the segment's own leg
id — never an array index, which changes on every refilter.

Geometry survives a reload for free: it lives on the validated plan in localStorage, so
the derivation runs against restored data with nothing extra to rehydrate.

The dashed sequence line stays, always. It is what still shows the day's shape across a
leg we could not route.

### Where routing state is *not*

| Concern | Lives in | Persisted? |
| --- | --- | --- |
| Travel segments | `TripPlan.days[].items[].travelToNext` | yes |
| Applied policy + coverage | `TripPlan.routing` | yes |
| Day travel split, map lines | derived at runtime from segments | no |
| Running / error / conflict | `lib/store/routing-job-store.ts` | **no** |
| Provider errors, cache state | nowhere in the client | no |

## 6. Domain model

`lib/domain/types.ts` is the single vocabulary; every layer speaks it.

```ts
PlaceCategory      // controlled vocabulary; the Overpass allowlist
PlaceSource        // provider + canonical identity + attribution
TripPlace          // a verified, mappable place (see §4)
VerifiedPlacePool  // the candidate set an itinerary must draw from
CostEstimate       // an amount plus its basis and confidence
TripRequest        // validated form input
DestinationStrategy// Claude #1: overview, neighborhood, budget split, day themes, searches
PlaceCandidate     // Google-sourced, carries placeId + coords + rating + address
ItineraryStop      // candidate + day + order + timing + estimatedCost + rationale
RoutingMode        // walk | drive | bicycle — what we can actually route
RouteRequest       // origin + destination + mode, provider-independent
RouteResult        // RoutedSegment | UnavailableRouteSegment — failure is a value
RoutingMatrix      // pairwise costs, nulls preserved; never a source of geometry
ModePolicy         // which mode to ask for, as configurable planning defaults
TravelSegment      // routed | estimated | unavailable, discriminated on `status`
DayPlan            // date, theme, stops, legs, backups, dayTotal
BudgetSummary      // flights (estimate + searchUrl), stay, food, activities, transport
TripPlan           // request + strategy + days + budget + notes + generatedAt + schemaVersion
Issue              // { code, severity, dayIndex?, stopId?, message }
```

`lib/schemas/*` holds the Zod mirrors. Types are derived with `z.infer` — one
definition, no drift. `TripPlan` carries `schemaVersion` (currently **2**) so stored
plans are discarded rather than mis-rendered when the shape changes.

---

## 7. Validation and repair

`validate(plan)` returns `Issue[]`; it never throws.

| Code | Severity | Rule |
| --- | --- | --- |
| `unknown_place` | error | `placeId` not in the candidate pool |
| `budget_exceeded` | error | trip total > requested budget |
| `day_budget_skew` | warning | one day > 40% of activity budget |
| `missing_meal` | error | a full day without lunch and dinner |
| `schedule_conflict` | error | overlapping stop time windows |
| `excessive_travel` | warning | day travel > 120 min, or a single leg > 45 min |
| `closed_on_visit` | — | **Deferred.** OSM `opening_hours` is retained verbatim but not parsed, so we cannot honestly evaluate this. Needs a real parser first — see §4, *Opening hours* |
| `pace_mismatch` | warning | stop count contradicts requested pace |

**Exactly one repair pass.** It receives the plan, the `Issue[]`, and the *same* candidate pool — it
may reorder, retime, swap, or drop stops, never introduce a new place. If errors survive, the plan
ships with issues attached and the UI surfaces them. A second pass is out of scope by constraint,
and the code should make that a hard stop rather than a loop bound.

---

## 8. State and persistence

Zustand (`lib/store/trip-store.ts`), one store:

```
plan, status ('idle'|'generating'|'ready'|'error'), issues,
selectedDay: number | 'all', selectedStopId: string | null, hoveredStopId: string | null
```

Selection is a single source of truth read by both panes — that is the whole
card↔marker↔day-filter mechanism. Card click sets `selectedStopId`; the map effect pans and raises
that marker. Marker click sets the same field; the list scrolls it into view. Day selection filters
both markers and the polyline. No cross-pane refs, no imperative bridge.

Three stores, split by lifetime:

| Store | Holds | Persisted? |
| --- | --- | --- |
| `trip-store` | saved trips, as `StoredTripRecord` envelopes | yes |
| `workspace-store` | selection, day filter, mobile pane | no |
| `routing-job-store` | running / success / partial / error / conflict, per trip | **no** |

Persistence: `localStorage`, key `roamly:trips:v1`, store version **2**,
`{ records: Record<id, StoredTripRecord>, lastRequest }`. Each record is
`{ revision, createdAt, updatedAt, plan }` — see §5A for why the revision exists and how
the guarded write uses it. Written on a debounce, read through Zod on hydration; a
version mismatch or parse failure discards that entry rather than crashing the workspace,
and a v1 entry (a bare plan) is wrapped at revision 1 rather than dropped. Hydration
happens in an effect after mount, never during render, so server and client HTML agree.

The routing job store is separate and unpersisted on purpose: a traveller who closes the
tab mid-request must not reopen it to a spinner with no request behind it, and a stored
plan must not carry an error string from three weeks ago.

---

## 9. Visual system

Defined once in `app/globals.css` under Tailwind v4 `@theme`, consumed as utilities. No hard-coded
hex outside that block.

| Token | Role |
| --- | --- |
| `--color-cream` | warm cream page background |
| `--color-forest` | deep forest green — primary |
| `--color-terracotta` | muted terracotta — accent, map markers |
| `--color-ink` | body text |
| `--font-display` | editorial serif (headings, day numerals) |
| `--font-sans` | clean sans (body, UI) |

Fonts via `next/font/google`, replacing the Geist pair from the template. Framer Motion is
restrained: card enter/exit, day transitions, marker focus. Every animation respects
`prefers-reduced-motion`. Framer Motion is client-only — motion components live in leaf files marked
`"use client"`, so the workspace shell can stay a Server Component.

---

## 10. Environment

**Nothing in the app requires an environment variable to run.** No API key, no cloud
project, no billing account. A fresh clone renders the map, runs place discovery and
routes real journeys with zero configuration.

| Variable | Exposure | Purpose | Required? |
| --- | --- | --- | --- |
| `ROAMLY_CONTACT_URL` | server | Contact URL embedded in the outbound `User-Agent` for both the OSM services and the routing server, so they can reach whoever is generating traffic | No — defaults to a neutral placeholder. **Set it before pointing real traffic at the public services** |
| `ROAMLY_ROUTING_CLIENT_ID` | server | The `X-Client-Id` sent to the Valhalla demo server, so its operator can identify this project's traffic | No — defaults to `roamly-weekend-project`. Change it if you fork, so you are not attributed to us |
| `ROAMLY_VALHALLA_BASE_URL` | server | Point routing at a self-hosted or commercial Valhalla instead of the public demo | No — defaults to the FOSSGIS demo server |
| `ROAMLY_NOMINATIM_BASE_URL` / `ROAMLY_OVERPASS_BASE_URL` | server | Point geocoding and discovery at a self-hosted instance, or at a local fixture during browser verification | No |
| `ROAMLY_AI_PROVIDER` | server | `auto` (default), `gemini`, `ollama` or `deterministic` | No |
| `GEMINI_API_KEY` | server | Enables the Gemini planner. Free tier, rate-limited | No |
| `GEMINI_MODEL` | server | Defaults to `gemini-2.5-flash` | No |
| `GEMINI_BASE_URL` | server | Override the Gemini host. Fixture servers during verification only | No |
| `OLLAMA_BASE_URL` | server | Enables a local Ollama planner. Setting it is what makes Ollama eligible — nothing is probed | No |
| `OLLAMA_MODEL` | server | Defaults to `qwen3:8b` | No |

Phase 6A added no environment variable: refinement reuses the same provider configuration as
generation.

`ANTHROPIC_API_KEY` is **not** used. Phase 5B is provider-independent by design: Claude Code is the
development agent, and the application's runtime planner is Gemini, Ollama, or a keyless template.

Google Places and the Google Routes API are **no longer part of the plan** — the free,
keyless OSM and Valhalla stack replaced them in Phases 2–4. The browser map key, map ID
and `GOOGLE_MAPS_SERVER_KEY` rows that used to be here are gone.

`.env.example` is committed with names and empty values; the real `.env.local` is not.
