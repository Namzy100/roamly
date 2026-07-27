# Roamly — Phased Build Plan

Ordered so each phase leaves the app runnable. Mock data lands before any paid API, so the whole
front end can be built and reviewed at zero external cost.

`[ ]` not started · `[~]` in progress · `[x]` done

---

## Phase 0 — Foundation

Strip the template, install deps, define tokens. No product logic.

- [x] `npx next typegen` to generate `PageProps` / `LayoutProps` / `RouteContext` helpers
- [x] `next.config.ts`: add `typedRoutes: true`. **Do not** add `cacheComponents` (see ARCHITECTURE §1)
- [x] Install runtime deps (Phase 0 list below)
- [x] `npx shadcn@latest init` — cream/forest theme, Tailwind v4, root alias (no `src/`)
- [x] Add shadcn primitives — **narrowed** to `button card input label textarea badge separator skeleton`
      (see Deviations D2)
- [x] Replace Geist fonts in `app/layout.tsx` with the serif/sans pair; update `metadata`
- [x] Rewrite `app/globals.css`: Tailwind v4 `@theme` with the six design tokens; delete the
      template's `prefers-color-scheme` block and the `font-family: Arial` on `body`
- [x] Delete `app/page.tsx` template content and `public/{next,vercel,file,globe,window}.svg`
- [ ] `.env.example` with the five variable names, empty values — **deferred to Phase 5**: no service
      is wired yet, and an example file listing unused keys invites someone to populate them
- [ ] ESLint `no-restricted-imports`: block `@/lib/{claude,google,pipeline}/*` from client components
      — **deferred to Phase 5**: those directories do not exist yet, so the rule has nothing to guard
- [x] `npm run lint` and `npm run build` both clean
- [x] Pin `turbopack.root` so an unrelated lockfile higher up the filesystem cannot move the
      inferred workspace root (added during Phase 1)

**Done when:** an empty cream page renders in the project's typography with no template artifacts.

---

## Phase 1 — Typed foundation and mock experience ✅ SHIPPED

Delivered 2026-07-25. Collapses the originally-planned Phases 1–3 into one vertical slice, plus a
map *placeholder* standing in for Phase 4. No external service is contacted.

### Domain model
- [x] `lib/schemas/enums.ts` — closed vocabularies (currency, vibe, pace, accommodation, dietary,
      interest, travel mode, item kind, meal type, Google `PRICE_LEVEL_*`) each paired with an
      ordered `*_OPTIONS` list carrying display labels
- [x] `lib/schemas/trip-request.ts` — `TripRequestSchema` with every product rule expressed as a
      refinement: end ≥ start, span 1–7 days, budget > 0, 1–12 travellers, departure ≠ destination,
      1–4 vibes, 1–8 interests, "no restrictions" not combinable
- [x] `lib/schemas/trip-plan.ts` — `TripPlace`, `TravelSegment`, `ItineraryItem`, `ItineraryDay`,
      `BackupOption`, `DestinationSummary`, `FlightEstimate`, `AccommodationRecommendation`,
      `BudgetSummary`, `TripPlan`
- [x] Every type via `z.infer` — no hand-written interface duplicates anywhere
- [x] `TripPlan.schemaVersion` literal `1`; `isEstimate: z.literal(true)` on flights and stay, so the
      type system cannot express a "confirmed" price
- [x] `lib/format.ts` — locale-pinned (`en-GB`) money, duration, distance and date formatting

### Deterministic mock
- [x] `lib/mock/lisbon-trip.ts` — Dubai → Lisbon, 5 days, balanced, culture + food: 23 stops across
      30 real places with real coordinates, 19 travel segments, 10 backup options, full budget
      breakdown, accommodation, 6 practical notes
- [x] Every value a literal — no randomness, no clock reads, byte-identical on server and client
- [x] Budget totals **summed from the itinerary** at module load, so the budget panel can never
      disagree with the day cards
- [x] Validated through `TripPlanSchema.parse()` at module load — a malformed fixture fails the build

### Landing page
- [x] `components/marketing/hero.tsx` — editorial hero, warm radial wash, three proof points
- [x] `components/form/trip-builder-form.tsx` — RHF + `zodResolver`, all 11 fields
- [x] `components/form/choice-group.tsx` — chips and radio cards built on **real checkboxes and
      radios**, visually hidden but focusable, so keyboard and screen-reader behaviour is native
- [x] `components/form/field.tsx` — `Field` / `FieldSet` / `FieldError`, wiring `aria-describedby`,
      `aria-invalid` and a polite live region once rather than per call site
- [x] "Use the sample trip" button fills the form from the mock request
- [x] `components/marketing/saved-trips.tsx` — previously saved trips, skeleton until hydrated

### Submission
- [x] `lib/store/trip-store.ts` — Zustand + `persist`, key `roamly:trips:v1`, `nanoid(10)` trip ids
- [x] Each stored trip revalidated **individually** through `TripPlanSchema` on rehydrate; a single
      stale entry is dropped rather than taking the rest down
- [x] `skipHydration: true` + `lib/store/use-hydration.ts` reading hydration state through
      `useSyncExternalStore` — no `setState` in an effect, no server/client divergence
- [x] Navigates to `/trip/[tripId]`

### Workspace
- [x] `app/trip/[tripId]/page.tsx` — `await params` (async in Next 16), typed via generated `PageProps`
- [x] `components/trip/trip-workspace.tsx` — desktop split screen, tablet single column, mobile
      Plan/Map segmented toggle; sticky header, sticky day bar, sticky map
- [x] `trip-header.tsx`, `day-selector.tsx` (tablist, arrow-key navigation), `itinerary-panel.tsx`,
      `itinerary-item-card.tsx`, `travel-segment-row.tsx`, `budget-panel.tsx`,
      `flight-estimate-card.tsx`, `accommodation-card.tsx`, `backup-options.tsx`,
      `practical-notes.tsx`
- [x] `lib/trip/visible-items.ts` — the single derivation of what is on screen, so a card's number
      and its pin's number are identical **by construction** rather than by parallel calculation
- [x] `components/trip/map-placeholder.tsx` + `lib/trip/project.ts` — pins positioned from real
      coordinates, longitude scaled by cos(latitude); dashed route polyline in itinerary order
- [x] Card click → pin highlights · pin click → card highlights **and scrolls into view** · day
      select → filters both panes. Selection lives in `lib/store/workspace-store.ts`; neither pane
      holds a reference to the other
- [x] `selectionSource` distinguishes list/map/day origin so only map-originated selection scrolls
- [x] Framer Motion: day-change transition, card stagger, pin spring — all gated on
      `useReducedMotion`, with a CSS `prefers-reduced-motion` backstop
- [x] `components/states/workspace-skeleton.tsx`, `components/states/trip-not-found.tsx`,
      `app/trip/[tripId]/loading.tsx`, `app/not-found.tsx`
- [x] Verified no horizontal overflow at 1440 / 834 / 390 / 375 px

### Validation
- [x] `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` clean, zero warnings
- [x] Driven in real Chrome over CDP: **12/12** behavioural checks, **8/8** layout checks, zero
      console errors, zero hydration warnings

---

## Phase 1 deviations from the original plan

**D1 — Phases 1–3 delivered together, Phase 4 replaced by a placeholder.** The brief asked for one
vertical slice ending in a map placeholder. The Phase 4 checklist below is therefore still open; the
*interaction contract* it specifies (card↔pin↔day, no cross-pane refs) is already built and verified
against the placeholder, so Phase 4 is a swap of the rendering layer, not a rework.

**D2 — shadcn primitives narrowed to eight.** `button card input label textarea badge separator
skeleton` only. `select`, `calendar`, `popover`, `slider`, `sheet`, `toggle-group`, `tooltip` and
`sonner` were not added: a native `<select>` for currency, native `<input type="date">` for dates,
and native checkbox/radio groups for chips give better mobile and assistive-tech behaviour than
custom widgets, and they avoid pulling in overlay primitives nothing yet needs.

**D3 — `react-day-picker` not installed.** It was in the original dependency list but absent from the
brief's list, which is the correct call for this phase — two native date inputs need no library and
validate through the same Zod refinements. Revisit if a visual range picker becomes a requirement.

**D4 — file layout differs from the plan.** `lib/schemas/` rather than `lib/domain/`, matching the
brief. `lib/format.ts` rather than `lib/utils/{money,dates,distance}.ts`, because `shadcn init`
creates `lib/utils.ts` for `cn()` and a sibling `lib/utils/` directory alongside a `lib/utils.ts`
file is a resolution trap. Persistence lives inside `trip-store.ts` via zustand's `persist`
middleware instead of a separate `lib/store/persistence.ts`.

**D5 — four extra dependencies, all required by shadcn.** `@base-ui/react` (button, input, badge and
separator are built on it), `class-variance-authority` (variant definitions), `shadcn` and
`tw-animate-css` (both imported by the generated `app/globals.css`; `shadcn/tailwind.css` supplies
the `data-*` custom variants the primitives use). Verified as load-bearing, not incidental.

**D6 — `overrides: { valibot: "^1.0.0" }` added to `package.json`.** `@hookform/resolvers` declares
~28 optional peer validators; npm tried to resolve that whole graph and deadlocked between
`@typeschema/valibot` (wants valibot ^0.39) and the resolver itself (wants ^1). The override settles
it. Neither valibot nor typeschema is installed — confirmed absent from `node_modules`.

**D7 — no "error with retry" state.** Nothing in this phase can fail: there are no network calls and
the plan is a local literal. The three states that *can* occur are built — loading, not-found, and
empty. An error boundary belongs with Phase 7, when the pipeline can actually reject.

**D8 — `.env.example` and the server-only ESLint rule deferred to Phase 5.** Both guard directories
and keys that do not exist yet.

**D9 — one visual honesty addition.** The workspace carries a "Sample itinerary" banner. The plan
describes real businesses with plausible-looking ratings, and without the banner a visitor could
reasonably read it as generated for them. Mock Place IDs are prefixed `mock_` rather than shaped like
Google ids for the same reason.

**Known limitation.** In the "All days" view the 23 pins cluster heavily, because Sintra sits ~25 km
from the Lisbon stops and the projection preserves that true spread. Per-day views — the primary
state — read cleanly. A real map solves this with zoom.

---

## Phase 2 — Free & open-source map ✅ SHIPPED

Delivered 2026-07-26. Replaces the Phase 1 placeholder with a real, pannable, zoomable map. This
supersedes the originally-planned "Phase 4 — Google Maps", which is cancelled: **no Google Maps, no
API key, no cloud project, no billing account.**

### Dependencies
- [x] `maplibre-gl` pinned to **`5.24.0`** (exact, not caret — see Known limitations)
- [x] `react-map-gl@8.1.1`, used via its `react-map-gl/maplibre` entry point
- [x] `vitest@4.1.10` (dev) — the first test runner in the project
- [x] **Not** installed: `@vis.gl/react-google-maps`, any Google package, any Mapbox package, Leaflet

### Provider-independent boundary
- [x] `lib/map/types.ts` — `VisibleMapPlace`, `TripMapProps`, `MapBounds`, `CameraTarget`,
      `SequenceLine`. No map-library type appears in it
- [x] The workspace imports only `lib/map/derive` and `components/map/map-panel`; `trip-map.tsx` is
      the single file in the app that imports MapLibre
- [x] Map instances, viewport state and style objects stay out of the Zustand store, the trip
      schemas, the itinerary components and localStorage
- [x] `VisibleMapPlace` extends the brief's shape with `dayNumber` — required to separate each day's
      sequence in the All Days view, which is otherwise impossible

### Derivations (pure, unit-tested)
- [x] `lib/map/derive.ts` — plan + day filter → `VisibleMapPlace[]`; excludes unavailable and
      placeless items; appends the accommodation under a namespaced `accommodation:` id
- [x] `lib/map/bounds.ts` — bounds, degenerate-box detection, camera target, inset viewport test
- [x] `lib/map/sequence.ts` — per-day GeoJSON `LineString`s, accommodation excluded, no cross-day joins
- [x] Numbering comes from `getVisibleItems`, so markers can have gaps rather than renumbering

### Schema additions
- [x] `ItineraryItem.status: "confirmed" | "unavailable"`, defaulted — an unfilled slot stays visible
      in the itinerary but gets no marker
- [x] `ItineraryItem.place` is now nullable — downtime with no single location
- [x] `isMappableItem()` type guard. Both changes are backward compatible, so stored plans keep
      parsing and `TRIP_PLAN_SCHEMA_VERSION` stays at 1
- [x] `itinerary-item-card.tsx` gained a placeless branch and a "Not on the map" badge

### Rendering
- [x] `components/map/trip-map.tsx` — MapLibre map, `maplibre-gl.css` imported exactly once here
      (not in the root layout, so it ships with this chunk rather than every page)
- [x] `numbered-marker.tsx` — custom HTML markers; normal / selected / hovered / focused /
      accommodation states; ~44×44 px hit area around a 32 px dot
- [x] Selection is signalled three ways, not by colour alone: ring, size change, and a check badge.
      The number stays visible so it is always clear *which* stop is selected
- [x] `aria-label` per marker: `"Stop 3: Ti-Natércia"`, or `"Where you're staying: …"`
- [x] Markers keyed by `itemId`, never by array index
- [x] Single `Source` + `Layer` for the sequence line, not one overlay per segment
- [x] `data-roamly-marker` / `data-item-id` attributes so markers are addressable in both renderers

### Camera
- [x] `use-map-camera.ts` owns every camera move. Day change refits; selection pans only when the
      marker is outside a 12%-inset viewport and never changes zoom; becoming visible resizes and
      refits only when never fitted at real dimensions or the geometry changed >10%
- [x] Zero-marker and one-marker days handled explicitly (centre, not fit)

### Basemap and attribution
- [x] `lib/map/basemap.ts` isolates the style URL, attribution strings and zoom caps
- [x] OpenFreeMap `positron` — key-free, OSM-derived vector tiles
- [x] OpenStreetMap attribution visible and permanent (`compact={false}`); the fallback prints its own
- [x] Basemap warmed toward the cream palette by a CSS filter on `.maplibregl-canvas` only, so
      attribution and markers — DOM siblings of the canvas — are untinted

### Loading and fallback
- [x] `map-panel.tsx` chooses the renderer; `dynamic(ssr: false)` keeps `maplibre-gl` out of the
      server bundle and its `loading` state is the skeleton
- [x] `map-fallback.tsx` — the Phase 1 schematic, kept and demoted to fallback, speaking the same props
- [x] `map-error-boundary.tsx` contains a render throw inside the panel
- [x] Covers: chunk loading, WebGL unavailable, style/tile failure, render throw. Messages are plain
      language with no provider names or stack traces; diagnostics logged in development only

### Validation
- [x] `npm test` — **40 unit tests, 3 files, all passing**
- [x] `npx tsc --noEmit` clean · `npm run lint` clean · `npm run build` clean
- [x] Browser (real Chrome over CDP): Phase 2 map suite **20/20**, Phase 1 behavioural **12/12**,
      Phase 1 sticky/responsive **8/8** — 40 browser checks, zero introduced console errors, zero
      hydration warnings
- [x] Screenshots: desktop day, desktop All Days, selected marker, mobile map, fallback

---

## Phase 2 deviations and notes

**M1 — Phase 4 (Google Maps) is cancelled, not deferred.** The cost constraint makes it wrong for this
project. `@vis.gl/react-google-maps`, the browser map key and the map ID are gone from the plan and
from `docs/ARCHITECTURE.md`.

**M2 — `maplibre-gl` is pinned exactly to `5.24.0`.** `maplibre-gl@6.0.0` installs cleanly and
type-checks, then fails at runtime: `react-map-gl@8.1.1` reads MapLibre's internal `transform` object,
whose shape changed in v6. The symptom is `TypeError: Cannot read properties of undefined (reading
'center')` from `transformToViewState`, and the camera silently stops working — `fitBounds` never
takes effect, so All Days does not include Sintra. A caret range would let v6 back in, so the pin is
exact. Revisit when react-map-gl ships v6 support.

**M3 — `VisibleMapPlace` carries `dayNumber`.** The brief's shape had no day identity, which makes
"visually separate each day's sequence" in All Days unimplementable. Added as `number | null` (null for
the accommodation).

**M4 — two schema fields added.** `status` and a nullable `place`. Without them the required tests for
"unavailable item exclusion" and "non-place item exclusion" would have been vacuous — the Phase 1 mock
is entirely confirmed and fully placed. Both are backward compatible.

**M5 — the sample plan is unchanged.** No unavailable or placeless items were added to the Lisbon mock;
those cases are covered by fixtures in `lib/map/test-fixtures.ts`. The demo stays clean, and the
exclusion logic is still tested.

**M6 — `.env.example` remains deferred.** The map needs no variable at all, and the only remaining
candidates belong to Phases 5–6, which are unresolved (see the open question in ARCHITECTURE §10).

**M7 — the day-context chip was added to the real map**, matching the fallback, so the map states which
day it is showing rather than relying on the itinerary heading alone.

---

## Known limitations

**Public tiles are for demo traffic only.** OpenFreeMap is donation-funded and explicitly not a
production CDN. Before real users: move to a paid hosted provider (MapTiler, Stadia, Protomaps) or
self-host OpenMapTiles/Planetiler. It is a one-line change in `lib/map/basemap.ts`. We must not work
around the limits — no bulk downloads, no offline tile caching, no aggressive prefetching, no header
stripping.

**Six third-party console warnings.** MapLibre logs `Expected value to be of type number, but found
null instead.` a handful of times per session. Traced to MapLibre's **tile worker** evaluating the
OpenFreeMap style's own expressions against tile features with null properties — the count is
invariant when our sequence layer goes from 1 feature to 5, which rules out our code. Not suppressed:
monkey-patching `console` to hide third-party warnings would cost more than it buys.

**All Days is dense.** 23 markers across Lisbon and Sintra (~25 km apart) overlap heavily at the fit
zoom. Zoom and pan now make it workable, which the placeholder could not. Marker clustering is the
real fix if this becomes a priority.

**No routed paths.** The sequence line is visit order only. Routed geometry needs a routing provider
and is unresolved along with the places provider.

---

## Phase 3 — Free OSM place discovery ✅ SHIPPED

Delivered 2026-07-26. Resolves the provider decision that blocked this phase: **the
free, keyless OpenStreetMap stack, not Google.** Nominatim for geocoding, Overpass for
category discovery, no API key, no cloud project, no billing account.

### The product decision, recorded
- [x] "Verified place" redefined for the free MVP — provider-returned, OSM element
      identity, coordinates, non-empty name, allowlisted category, server-normalised,
      and present in the exact pool the itinerary drew from (ARCHITECTURE §4)
- [x] Explicitly **not** claimed: highly rated, currently open, bookable,
      price-verified, editorially recommended, still trading
- [x] Ratings, review counts, price levels, opening status, addresses, websites, phone
      numbers and cuisines are never inferred or invented. Missing stays missing

### Schema
- [x] `lib/schemas/place.ts` — `PlaceCategory` (22-value controlled vocabulary),
      `PlaceSource`, `TripPlace`, `CostEstimate`, `isOsmSourced`, `placeCategoryLabel`
- [x] `TripPlace.source` is now **required**; `address`, `rating`, `userRatingCount`,
      `priceLevel`, `editorialSummary` became genuinely optional; `googleMapsUri`
      replaced by a generic `website`; added `phone`, `cuisine`, `openingHours`,
      `wheelchair`, `outdoorSeating`, `takeaway`
- [x] `TRIP_PLAN_SCHEMA_VERSION` → **2**. Stored v1 plans are discarded on read by the
      Phase 1 mechanism; the sample trip is one click to regenerate
- [x] `lib/schemas/pool.ts` — `VerifiedPlacePool`, `buildVerifiedPlacePool`,
      `assertPlaceIsVerifiable`, `assertItineraryUsesPool`, `validatePool`, and a
      ten-code `PoolValidationError`. Every check throws; nothing is silently repaired

### Provider adapter (`lib/providers/osm/`)
- [x] `config.ts` — the only module naming an endpoint; User-Agent, TTLs, all caps
- [x] `identity.ts` — canonical `osm:{type}:{id}`, the single authority for building and
      parsing. Element type is part of identity because OSM id spaces are per-type
- [x] `categories.ts` — the allowlist and its one reviewed OSM tag mapping
- [x] `schemas.ts` — Zod for raw Nominatim and Overpass payloads; both node and
      way/relation `center` coordinate shapes
- [x] `normalize.ts`, `geocode.ts`, `discover.ts`, `overpass-query.ts`
- [x] `rate-limit.ts` — a promise chain, so concurrent callers serialise rather than race
- [x] `cache.ts` — provider-independent interface + bounded LRU/TTL implementation
- [x] `http.ts` — one outbound path: pacing, `AbortController` timeout, classification,
      exactly one retry, `Retry-After` honoured and capped
- [x] `errors.ts` — eight typed kinds, internal detail vs. `userMessage` separated
- [x] `server-only` on every entry point, plus an ESLint rule blocking
      `@/lib/providers/**` from `components/**`

### API + dev surface
- [x] `POST /api/places/geocode`, `POST /api/places/discover` — Zod in and out, 4 KB body
      ceiling checked against real bytes, user-safe errors, no raw payload, no side effects
- [x] `/dev/places` — geocode → choose match → allowlisted categories → bounded radius →
      discovery, showing canonical ids, present **and** absent metadata, pool status,
      cache state, discard counts, attribution, and results on the MapLibre adapter
- [x] `notFound()` in production, verified against a real production build

### Tests — 179 unit tests, 10 files
- [x] Raw validation: valid/malformed Nominatim, missing identity, unsupported OSM type,
      Overpass node, way/relation `center`, missing tags, missing name
- [x] Identity: node/way/relation ids, round trip, collision prevention, invalid values
- [x] Query safety: allowlist, max radius, max categories, deterministic output, and
      eight injection attempts proving caller syntax cannot enter Overpass QL
- [x] Normalisation: category mapping, optional retention, missing stays missing,
      dedupe, deterministic order, attribution
- [x] Pool: source identity, `placeId` mismatch, duplicates, coordinate mutation,
      mock/OSM distinction, itinerary outside pool
- [x] Cache and limiter: hit avoids request, expiry, empty-result TTL, bounded eviction,
      ≥1 s spacing, concurrent serialisation, abort handling, one-retry ceiling
- [x] No unit test contacts a public endpoint — fixtures and mocked `fetch` only

### Live and browser verification
- [x] `npm run test:integration:osm` — opt-in, 3 requests, one fixed destination.
      **Passed live**: 19 real Lisbon museums and viewpoints, all canonical ids, pool
      valid, cache hit on repeat. Skips (exit 0) when the public service is busy
- [x] 16/16 browser checks on the dev surface, with `/api/places/*` served from CDP
      fixtures so repeat runs do not touch the public services — one deliberate live
      call proves genuine server-side caching
- [x] Phase 1 (12/12), Phase 1 layout (8/8) and Phase 2 map (20/20) all still pass

---

## Phase 3 deviations and notes

**P1 — `VerifiedPlacePool` did not previously exist.** The brief described it as an
existing contract to convert into. It was only ever *described* in ARCHITECTURE §4 and
scheduled for the old Phase 7; no pool, no validation and no "no-invention" code existed.
It is new in this phase.

**P2 — `TripPlace.coordinates` stays `{lat, lng}`.** The brief listed flat
`latitude`/`longitude`. Kept nested: it carries identical information, `DestinationSummary.center`
already uses `LatLng`, and flattening would churn the map layer for no functional gain.
`VisibleMapPlace` and `GeocodedDestination` do use the flat form, because that is what
their consumers want.

**P3 — added `categoryLabel`.** The controlled `category` is what the allowlist, the map
and pool validation use; `categoryLabel` preserves the sample data's more informative
wording ("Coffee roastery" rather than "cafe"). Without it the demo would read worse
purely as a side effect of introducing the vocabulary.

**P4 — the sample plan keeps its ratings and price levels.** They are `provider: "mock"`
records with `attribution: "Sample data — not sourced from any provider"` and **no** OSM
element identity — pool validation rejects a mock record that claims any. Nothing
labels them as OpenStreetMap-sourced, and no OSM-sourced record ever carries them.

**P5 — schema version bumped to 2, so saved demo trips are dropped.** `source` is
required and could not be back-filled honestly. The discard path was built and tested in
Phase 1 for exactly this.

**P6 — the integration check is a vitest suite, not a standalone CLI.** A plain
`node` script cannot load the provider modules: they import `server-only`, which resolves
to a throwing module outside a server bundle. Reusing vitest gives alias resolution and
the `server-only` stub for free, with a separate config so `npm test` cannot pick it up.

**P7 — one extra dependency: `server-only`.** A three-line package, and the only way to
turn "client component imports the provider layer" into a *build* error rather than a
runtime surprise.

**P8 — `.env.example` still not added.** Nothing is required to run the app. The single
optional variable (`ROAMLY_CONTACT_URL`) is documented in ARCHITECTURE §10 and the README;
a file full of unused keys would invite someone to populate them.

**P9 — two real bugs were caught by the tests being written.** `Number("")` is `0`, so an
empty Nominatim coordinate would have validated as latitude 0, longitude 0 — the classic
"null island". And a fast double-click on the dev surface could fire two requests before
React re-rendered, spending two rate-limiter slots; a synchronous in-flight ref now
collapses them.

---

## Phase 3 known limitations

**OSM has no ratings, review counts or price levels.** This is a real capability loss
against the earlier Google plan, and it changes what the product can promise. "Verified"
now means "this place exists here", not "this place is good". Ranking candidates by
quality is not possible from OSM alone.

**`opening_hours` is unparsed.** Retained verbatim; availability is "unknown". A correct
parser for that syntax is a project in itself, and the `closed_on_visit` validation rule
is deferred until one exists.

**Public services are demo-grade.** Volunteer-run and appropriate for local development
and a portfolio demo only. Overpass in particular sheds load by returning HTTP 200 with
an HTML error body — handled as transient, but it means discovery can legitimately fail.
Self-hosting is the migration path (ARCHITECTURE §5).

**Rate limiting is per process.** Several serverless instances each hold their own
limiter, so the true ceiling is (instances × 1/sec). A shared limiter or a self-hosted
Nominatim is required before real traffic.

**Caching is per process and non-durable.** Instances do not share it and cold starts
begin empty.

**Coverage varies by region and category.** Museums and viewpoints in a European capital
are well tagged; a `music_venue` in a smaller city may return nothing. Empty categories
are reported rather than hidden, but the plan generator will need to handle sparse pools.

---

## Phase 4 — Free, keyless routing ✅ SHIPPED

Delivered 2026-07-26. Real walking, driving and cycling routes between verified places,
rendered as geometry distinct from the itinerary sequence line. No API key, no billing
account, no database, no authentication.

### The product decision, recorded
- [x] **Valhalla**, via the public FOSSGIS demo server at `valhalla1.openstreetmap.de`.
      Free, keyless, and explicitly demo infrastructure — treated as non-guaranteed and
      replaceable throughout
- [x] Supported modes: `walk` → `pedestrian`, `drive` → `auto`, `bicycle` → `bicycle`
- [x] **Transit is unsupported and never substituted.** No transit feed is loaded, and a
      walking or driving route under a transit label would misdescribe the journey. A
      transit request is refused as `unsupported_mode` before a request exists
- [x] An unsupported mode or a routing failure yields an explicit unavailable state —
      never an invented distance, duration or geometry

### Schema
- [x] `TravelSegment` became a **discriminated union** on `status`: `routed` (provider
      metadata, positive measurements, ≥2-point geometry, `fetchedAt`, attribution),
      `estimated` (basis, confidence, required disclaimer, no geometry) and
      `unavailable` (requested mode, reason, user message, no numbers at all)
- [x] Routed segments use `RoutedTravelMode`, which excludes `TRANSIT`; estimates keep
      the full vocabulary, which is why the sample plan's eight transit legs stay valid
- [x] `LineStringGeometry` added to `lib/schemas/place.ts` as a shared geographic
      primitive, so the routing domain and the trip plan cannot disagree about
      coordinate order
- [x] `TRIP_PLAN_SCHEMA_VERSION` → **3**. A stored v2 segment has no `status` to
      discriminate on; the Phase 1 discard path handles it
- [x] The sample plan is unchanged in content — one factory now emits
      `status: "estimated"`, `provider: "mock"` and a rendered disclaimer

### Routing domain (`lib/routing/`, client-safe)
- [x] `types.ts` — `RouteRequest`, `RouteResult`, `RoutingMatrix`, `ModePolicy`, `DayLeg`
- [x] `schemas.ts` — Zod mirrors, tied to the types by compile-time mutual-assignability
      assertions, so the two cannot drift
- [x] `modes.ts` — the one place the two mode vocabularies are translated. `toTravelMode`
      is total; `toRoutingMode` returns `null` for transit rather than a substitute
- [x] `mode-policy.ts` — walk ≤ 1.8 km, drive > 8 km, middle band left to the caller by
      default; bicycle only when explicitly requested; documented as configurable
      planning defaults rather than truths
- [x] `derive.ts` — itinerary → legs. Skips unavailable and placeless items, joins across
      the gap, preserves order, never mutates, never invents a coordinate
- [x] `validate.ts`, `cache-key.ts`, `format.ts`, `segment.ts`

### Valhalla adapter (`lib/providers/routing/`, server-only)
- [x] `config.ts` — the only module naming a routing endpoint; client id, User-Agent,
      TTLs, concurrency, matrix caps, retry policy
- [x] `errors.ts` — nine typed reasons, internal detail vs. `userMessage` separated;
      `no_route` is a cacheable answer, not a retryable failure
- [x] `client.ts` — one outbound path: pacing, `AbortController` timeout, classification,
      exactly one retry, `Retry-After` honoured and capped
- [x] `concurrency.ts` — bounded to 3, order-preserving, deduplicating
- [x] `valhalla/geometry.ts` — one authoritative polyline decoder at **precision 6**, no
      new dependency, fixture-pinned
- [x] `valhalla/schemas.ts`, `normalize.ts`, `route.ts`, `matrix.ts`
- [x] `service.ts` — cache, and a `RouteResult` return rather than a throw, so one bad
      leg cannot take down fourteen good ones
- [x] `day.ts` — `routeItineraryDay` and `routeDayPlaces`
- [x] `server-only` on every entry point; the existing ESLint rule already blocks
      `@/lib/providers/**` from `components/**`

### Cache, concurrency and restraint
- [x] The bounded LRU/TTL cache promoted to `lib/providers/cache.ts` — it was already
      provider-independent, and routing needed it without importing from `osm/`
- [x] 24 h for routes and matrices, 15 min for `no_route`, failures never cached
- [x] Keys round coordinates to 5 dp (~1.1 m) and separate by mode; matrix keys preserve
      source and target order because a matrix is read positionally
- [x] 3 concurrent requests, 250 ms minimum gap between starts, duplicates collapsed
- [x] One retry maximum, jittered, no storm across a batch
- [x] `X-Client-Id: roamly-weekend-project` on every request, configurable

### API + map + dev surface
- [x] `POST /api/routes/route`, `/api/routes/matrix`, `/api/routes/day` — Zod in and out,
      8 KB body ceiling, 24-stop cap, user-safe errors, no raw payload, no side effects
- [x] A well-formed request that cannot be routed returns **200** with an `unavailable`
      result; 4xx is reserved for requests that were actually wrong
- [x] `lib/map/routes.ts` + a second MapLibre source and layer — solid, mode-coloured,
      with a pale casing. The dashed sequence line stays
- [x] Camera fitting includes route vertices, so a path that loops outside its endpoints
      is not clipped
- [x] `/dev/routing` — geocode → discover → pick stops → choose a mode → route, showing
      both lines with a legend, per-leg provenance, shape-point counts and failure
      reasons. `notFound()` in production, verified against a real production build

### Tests — 390 unit tests, 21 files (up from 179)
- [x] Contracts: routed / estimated / unavailable, zero distance, zero duration,
      malformed geometry, out-of-range coordinates, unsupported mode, the pre-Phase-4
      shape rejected, geometry unable to ride on an estimate
- [x] Provider mapping: walk→pedestrian, drive→auto, bicycle→bicycle, no transit entry
- [x] Geometry: known encoded fixture, lon/lat ordering, malformed string, truncated
      varint, out-of-alphabet character, over-long value, <2 points, and a
      **precision-regression** case proving a precision-5 decode is rejected
- [x] Normalisation: valid route, multi-leg summing, seam collapse, provider-level error
      in a 200, missing trip, missing legs, malformed summary, malformed shape, null
      shape, wrong units, HTML body under 200, empty body
- [x] Cache: hit prevents a request, mode separation, coordinate rounding both ways,
      expiry, `no_route` short caching, failures never cached, bounded LRU eviction
- [x] Concurrency: ceiling enforced, order preserved, in-flight dedupe, abort
      propagation, one-retry ceiling, partial failure retained
- [x] Matrix: square, rectangular, null cells preserved, dimension mismatch, element cap,
      no zero coercion, order-sensitive keys
- [x] Derivation: skips unavailable and placeless, preserves order, one-place day yields
      nothing, never crosses days, accommodation by policy, no source mutation
- [x] Mode policy: every threshold boundary, explicit bicycle, no transit auto-selection,
      provider never changes the requested mode
- [x] Wording: no "live traffic", "fastest right now", "real-time" or "transit" anywhere
      in the user-facing strings
- [x] No unit test contacts a public endpoint — fixtures and mocked `fetch` only

### Live and browser verification
- [x] `npm run test:integration:routing` — opt-in, 4 requests, fixed Lisbon coordinates.
      **Passed live** on 2026-07-26: pedestrian 557 m / 489 s / 55 shape points,
      automobile 2 120 m / 359 s, a 2×2 matrix, and a cache hit on repeat. Skips (exit 0)
      when the demo server is busy
- [x] **39/39 browser checks** in real Chrome over CDP, covering Phase 1, Phase 2 map,
      Phase 3 discovery and the new routing surface. `/api/*` served from CDP fixtures so
      repeat runs never touch the public services
- [x] Verified in the browser: pedestrian, automobile and cycling routes render; transit
      is absent and explained; routed geometry has more vertices than the two-point
      sequence line; duration and distance match the normalised result; three rapid
      clicks fire one request; partial failure keeps its successes; an unavailable leg
      shows no numbers and draws no line; a 502 and an HTML-200 both produce a controlled
      message with no internals leaked; markers stay interactive; attribution stays
      visible; the map resizes at 390 px with no horizontal overflow
- [x] `/dev/routing` and `/dev/places` both return 404 against a real production build
- [x] No hydration warnings and no introduced console errors

---

## Phase 4 deviations and notes

**R1 — Valhalla, not OSRM.** The Phase 3 plan named OSRM's demo server as the likely
choice. Valhalla was picked instead: it exposes distinct pedestrian, automobile **and**
bicycle costing profiles from one endpoint, where OSRM's demo runs a single profile per
host. It also returns a time-distance matrix from the same service.

**R2 — the cache moved.** `createMemoryCache` and `cacheKey` were under
`lib/providers/osm/` while their own docstring called them provider-independent. Routing
needed them, and importing an OSM module from the routing adapter would have been a lie
about the dependency. They are now `lib/providers/cache.ts`; `osm/cache.ts` keeps that
provider's instances and its narrowed namespace type.

**R3 — no polyline dependency.** The decoder is forty lines. The risks here are precision
and coordinate ordering, and a dependency helps with neither — it would mean auditing
someone else's precision default and output order anyway. A fixture test does help, and
there is one.

**R4 — `deriveLegsFromPlaces` alongside `deriveDayLegs`.** `POST /api/routes/day` and the
dev surface hold discovery results, not a full itinerary. Wrapping each place in a
synthetic `ItineraryItem` purely to satisfy a signature would have invented times, costs
and rationales that nothing reads. Both adapters share one core, so the rules cannot
diverge.

**R5 — the enrichment result is kept separate from `TripPlan`.** The brief allowed either.
`routeItineraryDay` returns a standalone `RoutedDayResult`; attaching it to a new plan
version would need a plan builder, a schema-migration path and a persistence story, none
of which belong in a routing pipeline. Phase 5 owns plan construction.

**R6 — a 250 ms inter-request gap on top of the concurrency cap.** The brief specified a
maximum of 3 concurrent requests. That alone would let a five-day itinerary fire fifteen
requests at a donated server in three tight bursts, so a minimum gap between starts was
added. Both are configurable, and a self-hosted instance can be told to go faster.

**R7 — the mode-policy middle band declines to choose.** Between 1.8 km and 8 km, the
default policy returns `null` rather than guessing. Falling back to a default there is
exactly the silent substitution the phase exists to prevent, and 4 km is a band where
"walk it" and "get a car" are both defensible.

**R8 — schemas assert mutual assignability, not type identity.** `lib/routing/types.ts`
is the definition and `schemas.ts` restates it at runtime. The stricter identity check
fails on `RoutedDayLeg`, which is an intersection where its schema counterpart is flat —
the same type to every caller. Assignability still catches an added, removed, renamed or
re-typed field in either direction.

**R9 — a real bug the tests caught.** The `no_route` classification originally keyed off
the HTTP status. Valhalla returns **400** both for "there is no path between these two
points" and for "your request is malformed", and only `error_code` separates them —
which meant a perfectly valid unroutable pair would have been reported as a client error
and, worse, would not have been cached. Verified live against the real service before
the code was written.

---

## Phase 4 known limitations

**The routing server is demo infrastructure.** `valhalla1.openstreetmap.de` is FOSSGIS's
public demo instance: unversioned, unguaranteed, and liable to be slow, rate-limited or
gone. A production deployment must notify the operator or self-host. Everything
downstream degrades to an explicit "route unavailable" rather than a wrong answer, which
is the mitigation, not a fix.

**No transit, at all.** No GTFS feed is loaded, so transit is refused rather than
approximated. Real transit routing needs a GTFS-backed engine (OpenTripPlanner, or
Valhalla with transit tiles built), which is a self-hosting decision.

**No live traffic.** Durations come from a costing profile over OpenStreetMap geometry.
A driving figure is not a rush-hour figure, and the UI is forbidden from implying it is.

**Routing is not wired into the itinerary yet.** The sample plan's legs remain labelled
estimates, and `/dev/routing` is where real geometry is exercised. Attaching routed
segments to a plan version belongs to the orchestration phase.

**Caching and pacing are per process.** Several serverless instances each hold their own
cache and their own limiter, so the true ceiling is (instances × the configured rate).

**The matrix adapter has no product consumer.** It exists so the next phase does not have
to add a provider integration under deadline, and its element cap (64) is deliberately
far below anything Valhalla would refuse.

**Accommodation bracketing is off by default.** A day that begins mid-morning at a café
did not start with a walk from the hotel, and asserting it did would be an invented leg.
Callers opt in.

---

## Phase 5A — Deterministic itinerary orchestration ✅ SHIPPED

Delivered 2026-07-27. Connects the verified place pool and the routing layer to the real
`TripPlan` lifecycle: a traveller presses one button and the saved trip gains real
geometry, recomputed totals and an honest coverage report. No model is involved.

### Immutable plan builder (`lib/plan/`)
- [x] `enrichTripPlanWithRouting` — plan + pool + routed days → a **new** plan. Never
      mutates the input plan, the pool, the days or the items
- [x] Returns `complete` / `partial` / `failed`. A provider failure is `partial` with a
      valid plan; a contract violation is `failed` with **no plan at all**
- [x] `expected-legs.ts` — the single authority on which legs a plan expects. Used by
      orchestration, the builder, coverage counting and the tests, so no two answers exist
- [x] `derive-totals.ts` — the one derivation of `totalTravelMinutes`, `dayTotal`,
      `byDay`, `total`, `remaining`, `perTraveler`. A caller-supplied derived value is
      recomputed, never trusted
- [x] `summary.ts` — coverage built **from the finished plan**, not accumulated during it
- [x] `validate-derived.ts` — runs on the builder's *output*: reconciliation identities,
      totals versus segments, geometry and measurement sanity, coordinate tolerance
- [x] `policy.ts` — trip-level defaults, with driving enabled in the 1.8–8 km band so an
      eligible leg is never silently dropped and reported as pending
- [x] `pool.ts` — `derivePlanPlacePool`, honestly documented as self-derived provenance
      for a plan that never had a discovery pool

### Stable leg identity
- [x] `lib/routing/leg-id.ts` — `day:{n}:from:{itemId}:to:{itemId}:mode:{mode}`, one
      constructor and one parser
- [x] Day, both item ids and mode are all part of identity; array position and coordinates
      are not, and the reasons are recorded in the module
- [x] A colon in an item id is rejected at construction; the accommodation's endpoints are
      `@`-prefixed so they cannot collide with a real id
- [x] `DayLeg` gained `dayNumber`, and `deriveDayLegs` now requires it

### Schema and persistence
- [x] `TripPlan.routing` — the only new persisted field, carrying the applied policy, the
      timestamp and the validated summary. Everything else is derived at runtime
- [x] **`TRIP_PLAN_SCHEMA_VERSION` stays at 3.** `routing` is nullable with a default, so
      stored plans parse unchanged. Bumping would discard saved trips for no benefit
- [x] `lib/store/trip-record.ts` — `{ revision, createdAt, updatedAt, plan }` with
      `checkRevision`, `createTripRecord`, `nextRevision`
- [x] `STORE_VERSION` 1 → 2, with a **lossless** migration that wraps existing plans at
      revision 1 rather than dropping them
- [x] `saveEnrichedPlan` is a guarded, single, atomic replacement; a stale write returns a
      conflict and changes nothing
- [x] `routing-job-store` holds running / error / conflict state and is **not** persisted

### API and orchestration
- [x] `lib/providers/routing/trip.ts` — `routeTripPlan`, composition only. Calls the
      normalized routing service, never Valhalla directly, and adds no retry of its own
- [x] `POST /api/trips/route` — Option A, a pure server transformation. Zod in and out,
      512 KB body ceiling, `maxDuration = 60`, no persistence, no raw provider output
- [x] Caps enforced before any provider call: 7 days, 24 stops, 23 legs. Over-cap throws
      rather than truncating
- [x] Partial success is a 200 with a full plan and a per-leg status

### Workspace
- [x] `RoutingControls` — "Calculate real routes" / "Calculating routes…" / "Recalculate
      routes", with cancel, a synchronous double-click guard and a live region
- [x] Coverage row: "Routing coverage: 14 of 18 legs calculated", with unavailable and
      pending counts and distance/duration explicitly "across routed legs"
- [x] `deriveMapRouteLines` — routed segments only, day-filtered, stable identity. The
      dashed sequence line stays
- [x] Day header prints "· 1 route unavailable" beside the travel total, so a zero is
      never read as "no travel"
- [x] Budget panel unchanged by routing, with the transport figure labelled an estimate —
      route availability and transport cost are separate concerns
- [x] Nothing fires on mount, on render or on plan change

### Tests — 509 unit tests, 28 files (up from 390 / 21)
- [x] Leg identity: determinism, day separation, mode separation, direction, accommodation
      identity, round trip, colon rejection, invalid day
- [x] Expected legs: order, unavailable skipped, placeless skipped, no cross-day leg,
      single-stop day, duplicate-place collapse, accommodation policy, no transit, unique ids
- [x] Builder: no source or pool mutation, estimate → routed, estimate → unavailable,
      routed preserved by default, `refresh-all` overwrite, `replace-estimates` leaving a
      known failure, note retention, unknown day, unknown leg, duplicate result, origin /
      destination / coordinate / mode mismatch, pool violation, no plan on failure
- [x] Totals: routed / estimated split, unavailable contributing zero, pending counts,
      `dayTotal` and budget recomputation, categories left canonical, transport independent
- [x] Summary: complete / partial / not-attempted / unavailable, every reconciliation
      identity, day-to-trip aggregation
- [x] Persistence: initial revision, increment, stale conflict, missing record, corrupt
      envelope, no revision inside the plan
- [x] Map derivation: routed only, estimated and unavailable excluded, day filtering,
      All Days grouping, stable identity, order, no mutation
- [x] Orchestration: complete run, partial failure retained, totals recomputed, budget
      untouched, policy recorded, no request when nothing is eligible, cache reuse, abort,
      caps, and the real Lisbon plan end to end
- [x] No unit test contacts a public endpoint

### Browser verification — 67/67
- [x] Real Chrome over CDP. `/api/trips/route` is **not** stubbed: the whole server
      pipeline runs against a local fake Valhalla via `ROAMLY_VALHALLA_BASE_URL`, so the
      orchestration, builder, validation and guarded save are all genuinely exercised with
      nothing leaving the machine
- [x] Verified: no request on page load; revision 1 with estimates; the action exists; no
      coverage row before a run; partial failure keeps 14 of 18 routes; coverage reported
      honestly; revision increments exactly once; unavailable rows show no numbers; routed
      rows credit OpenStreetMap and never claim traffic; day totals carry completeness;
      transport unchanged and labelled; geometry on the map; markers interactive;
      attribution visible; day filtering; All Days; three clicks produce one run; retry
      converts failures to routes; day totals recompute; trip totals reconcile; refresh
      preserves everything; stale revision is refused without clobbering; a matching
      revision is accepted; a provider failure leaves no half-written record; unknown trip
      still 404s in-app; mobile geometry and segment detail
- [x] All Phase 1, 2, 3 and 4 checks still pass
- [x] `/dev/routing` and `/dev/places` both 404 against a real production build, and the
      dev-only store seam is absent from all 32 production client chunks

---

## Phase 5A deviations and notes

**O1 — schema version stays at 3.** The brief said to increment to 4 "if the persisted
shape changes incompatibly". It does not: `routing` is `.nullable().default(null)`, so
every stored plan still parses. The *storage envelope* changed, which is what
`STORE_VERSION` governs, and that migration is lossless.

**O2 — `travelSummary` is derived, not persisted.** The brief offered either. Every field
is a pure function of the day's segments, so a persisted copy could only drift; the one
non-derivable input (which policy ran) is persisted instead, on `plan.routing`.

**O3 — Option A for the API.** The plan is ~45 KB and the pool ~11 KB, so the body is
comfortable, and server-side orchestration keeps the concurrency ceiling out of the
browser's hands. That ceiling protects someone else's donated server and must not be
client-controllable.

**O4 — the trip-level mode policy enables driving in the middle band.** `DEFAULT_MODE_POLICY`
leaves 1.8–8 km undecided, which is right for a single routing call and wrong for a trip:
an undecided leg silently becomes "pending" for a journey we could have described. The
mode is shown on the card, so nothing is hidden.

**O5 — the derived pool is self-provenance, and says so.** The sample trip predates
discovery and has no pool. `derivePlanPlacePool` still does real work during enrichment —
it is what routed endpoints are checked against — but it cannot prove provenance, and the
module states that plainly rather than implying otherwise.

**O6 — a dev-only store seam.** The optimistic-concurrency guard can only be exercised by
moving a record while a request is in flight, which no user affordance can do on purpose.
`window.__roamlyTripStore` is exposed in development only, mirroring the existing
`__roamlyForceMapFallback` seam, and is verified absent from every production chunk.

**O7 — two invariants are unrepresentable rather than checked.** "A routed segment claiming
a mock provider" and "an estimate claiming a provider route" cannot be constructed —
`provider` is a literal on each arm and TypeScript narrows a check to `never`. They are
asserted in the contract tests against hand-built objects, which is the only place the
attempt is possible.

**O8 — the browser suite restarts the dev server.** The routing cache is per process and
holds a success for 24 h, so a second run against a warm server can never exercise a
provider failure. A fresh process is the only honest way to make the suite repeatable.

**O9 — a real find from writing the tests.** Three legs across two days produce only *two*
provider requests, because day 1's a→b and day 2's a→b share coordinates and mode and are
deduplicated. Correct behaviour, and the first assertion was wrong rather than the code.

---

## Phase 5A known limitations

**Routing is still user-initiated and single-shot.** There is no per-leg retry: the
"Recalculate" action re-runs the whole trip, which is cheap because cached legs cost
nothing, but a traveller cannot retry one failed leg in isolation.

**Bracketing the day at the accommodation routes but does not render.** The legs are
derived, requested and counted under `bracket-day`, but no itinerary card owns them, so
they have nowhere to appear. The policy defaults to `none` and the gap is documented in
`owningItemIdForLeg`.

**The coordinate tolerance cannot catch a swap between very close stops.** 50 m absorbs a
road snap and catches gross misattachment; two stops 30 m apart could in principle be
swapped without tripping it. Leg identity is the primary guard.

**Concurrency is per process.** Several serverless instances each hold their own limiter
and cache, so the true ceiling is (instances × 3).

**No conflict recovery beyond "reload".** A revision conflict discards the computed routes
and tells the traveller to reload. Merging two concurrent enrichments is possible in
principle and is not worth the machinery at this scale.

**The mode policy is global, not per day.** A traveller's `pace` and a day's shape should
plausibly move the thresholds; they currently do not.

**Budget categories are still canonical.** Nothing derives `food` or `activities` from the
itinerary, because no item carries a cost category. Until one does, those figures are the
sample plan's own.

---

## Phase 5B — Free-first AI generation ✅ SHIPPED

Delivered 2026-07-27. Real itinerary generation, and **still no API key required**. The
destination is geocoded and confirmed, a planner decides what *kinds* of place each day needs,
the server searches OpenStreetMap, and the planner assembles the days from what was actually
found. Three modes: Gemini, a local Ollama, or a keyless deterministic planner — and the last
is the default.

### The product decision, recorded
- [x] **Provider-independent.** Claude Code is the development agent; the application's runtime
      planner is not Anthropic. `ANTHROPIC_API_KEY` is not read anywhere
- [x] `ROAMLY_AI_PROVIDER=auto` resolves Gemini → Ollama → deterministic. An **explicit** demand
      that cannot be met reports `not_configured` and does **not** fall back
- [x] The production build, the map, place discovery, routing and generation all work with zero
      environment variables

### The model boundary (`lib/ai/`, client-safe, provider-free)
- [x] `StructuredGenerator` — `success` / `refused` / `unavailable` with a reason from a closed
      set. **No provider response object crosses it**
- [x] `generate` returns `unknown`, deliberately: Zod *strips* unknown keys, so an adapter that
      parsed would destroy the evidence before the prohibited-field scan could see it
- [x] `TripStrategySchema` and `GeneratedTripAssemblySchema` — neither can express a place. The
      assembly schema has nowhere to put a `TripPlace`, only a `placeId`
- [x] `prohibited.ts` — a raw-payload key scan across identity, provider facts and routing facts.
      A hit is a hard failure, never a strip
- [x] `json-schema.ts` — one Zod schema feeds both the prompt and the runtime, with `$ref`s
      inlined and `oneOf` → `anyOf` for Ollama's grammar compiler
- [x] Frozen system prompts: no dates, no trip ids, no interpolated user values, so a
      prompt-caching provider can reuse the prefix and the whole instruction is reviewable in
      one place

### Adapters (`lib/providers/ai/`, server-only)
- [x] **Gemini** — REST over `fetch`, no SDK. Key in a header, never the URL. `promptFeedback`
      checked **before** indexing into `candidates`, which is the crash this shape invites
- [x] **Ollama** — `format` carries the schema, so decoding is grammar-constrained; `num_ctx`
      raised so the candidate list is not silently truncated. A 200 carrying `error` is a
      first-class field
- [x] **Deterministic** — the same interface, the same validators, real OSM places, and prose
      that is explicitly generic. No clock, no randomness: byte-identical output
- [x] Selection makes **no network request**. Nothing probes Ollama
- [x] No transport-level retry, so the ceiling is 4 model calls per generation

### The pipeline (`lib/generate/`)
- [x] `discovery.ts` — ≤3 Overpass requests, ≤8 categories each, radius clamped twice, ≤150
      pool places. `allSettled`, so one failed batch does not lose the others
- [x] An empty category produces a warning and an empty bucket — never a substitution, never a
      widened retry, never a fabricated place
- [x] `candidates.ts` — every field copied or omitted. **No** relevance score, quality signal or
      distance: any score we could compute would be our opinion dressed as data
- [x] `assemble-plan.ts` — the pool's record attached unchanged; days dated from the request, not
      the model; items sorted chronologically; unfilled slots kept as visible gaps
- [x] `assertItineraryUsesPool` on the **finished** plan, backups included
- [x] `cost-bands.ts` — a proposed amount is clamped into its band and the clamp is warned about.
      Independent per-currency tables, **no conversion anywhere**
- [x] `pace-policy.ts` — the walking threshold follows `TripRequest.pace`; the model shapes the
      day but does not move the ruler
- [x] `generate-trip-plan.ts` — five result arms, one `AbortSignal`, a 90 s internal budget, and
      **no persistence and no routing at any point**

### Schema and persistence
- [x] `TRIP_PLAN_SCHEMA_VERSION` stays at **3**. `source` gains `"generated"`, `ItemKind` gains
      `transport`/`logistics`, `costEstimate` is optional — all widenings
- [x] `accommodation` becomes nullable: a destination with no mapped hotel has none to offer, and
      inventing one is the prohibited thing while failing the whole trip over one panel is worse
- [x] `TripGenerationContext` lives in the **stored envelope**, not on the plan — provenance is a
      fact about a run, and on the plan it would reach the routing endpoint
- [x] The retained pool is the real search result set, unused candidates included, so the
      no-invention claim has evidence behind it. `derivePlanPlacePool` is now a labelled fallback
- [x] `STORE_VERSION` stays at 2: `generation` is `.nullable().default(null)`
- [x] Plan and pool saved in **one** `set`, at revision 1. A routing write passes the context
      through; a regeneration replaces it under the same guard

### API
- [x] `POST /api/trips/generate` — SSE progress plus one buffered `result`, or plain JSON on
      `Accept: application/json`. 8 KB body cap, `maxDuration = 120`, no persistence
- [x] **No part of the plan is streamed.** A renderable half-plan is the failure this codebase
      exists to prevent
- [x] `GET /api/ai/status` — booleans and a display label. No key, no host, no model id, no probe

### Workflow and provenance
- [x] Geocode → confirm which "Lisbon" → choose the planner → real stage-by-stage progress →
      one atomic save → navigate
- [x] The AI action is present but **disabled with an explanation** when nothing is configured,
      never silently swapped for the demo planner
- [x] The trip page states: which planner, that places came from OpenStreetMap, that prices are
      estimates, that routes are not yet calculated, and how many slots were left open
- [x] The template banner appears for `source: "mock"` only — the fixed sample and the demo
      planner — and never for model output

### Tests — 837 unit tests, 45 files (up from 509 / 28)
- [x] Provider abstraction: Gemini and Ollama normalisation, the deterministic planner, selection,
      missing configuration, refusal, empty content, truncation, malformed JSON, HTML bodies,
      timeout, abort, rate limiting, and that no user message leaks a host or a status
- [x] The scan that justifies `prohibited.ts`: a test proving Zod *would* have stripped the
      fabrication silently
- [x] Strategy: valid, exact day count, category allowlist, bounded slots, positional slot ids,
      budget reconciliation, invalid day numbers, prohibited coordinates and business names
- [x] Assembly: pool ids only, unknown id, category mismatch, duplicate item id, duplicate slot,
      invalid interval, overlap, unresolved required slot, prohibited route data and ratings,
      backup membership, cost basis and currency
- [x] Canonical attachment: record attached, coordinates/name/source unchanged, optional provider
      facts preserved, no input mutation, backups verified, pool gate on the output
- [x] Repair: one maximum, supplied-place replacement, unresolved → unavailable, identity
      violations unrepairable, no recursion, same candidates re-sent
- [x] Orchestration: complete, sparse-partial, refusal, unavailable, partial discovery failure,
      invalid assembly, deterministic labelled as template, **no routing call**, no save on failure
- [x] Persistence: atomic pair, revision 1, increment, stale conflict, corrupt pool dropped,
      bounded pool, legacy fallback, generation absent from the plan
- [x] API: valid request, body cap, day cap, abort, refusal, partial, both delivery shapes, and
      that no prompt, model text, provider payload or secret crosses the boundary
- [x] Cost bands: ordering, per-currency independence (proving no single conversion factor),
      clamping in both directions, party scaling, rooms not people, mandatory disclaimer
- [x] No unit test contacts a model or a public endpoint

### Browser verification — 70/70
- [x] Real Chrome over CDP (`npm run verify:browser`), with Nominatim, Overpass, Gemini and
      Valhalla each replaced by a local fixture server. The **whole server pipeline runs**;
      nothing leaves the machine, so the suite is repeatable
- [x] The Gemini fixture is a planner rather than a recording — it reads the candidate list out of
      the prompt, which is what makes its `fabricate` mode a genuine test of the pool gate
- [x] Verified: no provider request on load; geocoding on submit; two candidates offered; the AI
      action disabled with an explanation when unconfigured; the demo planner working with **no
      environment at all**; six progress stages; revision 1; the full pool retained with unused
      candidates; every resolved place in the saved pool; template banner for demo and absent for
      generated; provenance naming the planner without the model id in the headline; prices
      labelled estimates; OSM attribution; "routes not calculated yet"; **zero routing requests
      during generation**; routing using the retained `discovery:` pool; one revision increment;
      the context surviving routing and a reload; three rapid clicks → one generation; cancel
      saving nothing and a late answer unable to resurrect it; a sparse destination producing
      visible gaps, no invented stay, and reachable notes; a fabricated `placeId`, a refusal,
      empty content and a 429 each controlled with nothing saved and no provider detail on the
      page; the guarded revision refusing a stale replacement and accepting a matching one;
      mobile; no hydration warnings; no console errors; no horizontal overflow
- [x] Production build: `/dev/places` and `/dev/routing` both 404; `__roamlyTripStore` absent from
      all 28 client chunks; no prompt text, provider host or key material in any chunk
- [x] All Phase 1, 2, 3, 4 and 5A checks still pass

### Optional live checks
- [x] `npm run test:integration:ai:gemini` — 2 requests, skips cleanly with no key, and skips
      rather than fails on a quota ceiling
- [x] `npm run test:integration:ai:ollama` — 2 requests, skips cleanly with no base URL, and
      asserts the one non-negotiable property: grammar-constrained output must not fabricate

---

## Phase 5B deviations and notes

**P1 — Gemini's schema goes in the prompt, not in `responseJsonSchema`.** Provider-side enforcement
is stricter, but the accepted dialect is a moving subset across model versions and a rejected schema
is a hard 400 that takes the feature down for everyone on that model. A prompt-embedded contract
degrades into drift our own validator catches and the repair pass fixes. Ollama is the opposite case
and *does* get the schema, because `format` becomes a sampling grammar.

**P2 — `StructuredGenerator.generate` returns `unknown`.** The brief's sketch returned the schema's
type. It cannot: Zod strips unknown keys, so an adapter that parsed would silently discard exactly
the fabrication `prohibited.ts` exists to catch. Validation is downstream on the raw object, which
also turns a schema-invalid answer into a structured violation report rather than a dead end.

**P3 — budget allocation is shares, not amounts.** The brief showed numbers. A model asked for
currency amounts produces arithmetic, and no arithmetic from a model is trusted here — every total is
recomputed. Shares are a real planning judgement, are currency-free, and reconcile against 1 exactly.

**P4 — cost amounts are clamped, not rejected.** `validate-assembly` checks `basis` and `currency`,
which are claims about provenance, and leaves the amount to attachment, which pulls it into a band and
warns. Rejecting an out-of-band amount would invite the model to guess our bands rather than the
traveller's spending.

**P5 — `accommodation` became nullable.** Not in the brief, and unavoidable: a destination with no
mapped hotel, hostel or guest house has none to recommend. Inventing one is the prohibited thing;
failing a good five-day itinerary because one panel cannot be filled is worse. The card says plainly
that the search found nothing.

**P6 — the demo planner is `source: "mock"`, not `"generated"`.** It runs the whole pipeline, so
labelling it `"generated"` would have been tempting and wrong. It is template output and the banner
says so.

**P7 — `ItemKind` gained `transport` and `logistics`.** Non-place blocks needed somewhere to land. A
day whose 90-minute airport run is invisible reads as a day with a suspiciously easy afternoon.

**P8 — progress is streamed; the plan is not.** The brief allowed either. Stage events are emitted
when the work begins, so progress is a report rather than an animation, while the itinerary arrives
once, whole and validated.

**P9 — a real find from the browser suite.** The verification harness had to wait for
`window.__roamlyTripStore` before submitting: before hydration, `requestSubmit()` performs a native
GET submit and the page reloads with the answers in the query string. The first version of the suite
asserted against an unhydrated document and reported passes. Two other harness bugs of the same kind
— asserting on candidates before they rendered, and on the workspace before it left its skeleton —
were also producing vacuous passes.

**P10 — the deterministic planner's prose is deliberately flat.** It could have read better from a
lookup table of destination adjectives. That would be inventing local knowledge, which is the same
offence as inventing a restaurant in a form that is harder to catch. Every sentence it writes is
either mechanically true of the data or explicitly labelled generic.

**P11 — no Anthropic dependency was added.** No new runtime dependency was added at all: Gemini and
Ollama are reached with `fetch`, matching every other provider in the codebase, and the browser
harness drives Chrome over Node's built-in `WebSocket`.

---

## Phase 5B known limitations

**A long generation can outlive a serverless function.** `maxDuration = 120` with a 90 s internal
budget, and Vercel's Hobby tier caps well below that. A slow local model or a loaded Overpass can
exceed the platform limit, and the traveller then sees a network failure rather than our timeout
message. Nothing is saved either way. The deterministic planner makes no model call and Gemini Flash
is fast; a platform with a longer ceiling removes the issue.

**Regeneration has no UI.** `replaceGeneratedTrip` is implemented, guarded and verified, but nothing
on the trip page calls it — a traveller who wants a different itinerary starts a new trip. The
conflict path is exercised through the development-only store seam.

**Repair is one shot per stage, and cannot re-search.** A model that needs a category nobody searched
for cannot ask for one. The honest outcome is an unavailable slot, which is what happens.

**Cost bands are destination-blind.** Reykjavík and Rabat are both outside a single "typical
destination" band. Every figure is labelled an estimate, but the estimate does not know where it is.

**Opening hours are still uninterpreted.** The model is shown the raw tag and told it means nothing
about availability, so it can avoid a market tagged `Tu,Sa` on a Monday only by reading the string
itself. A real `opening_hours` parser and a scheduling validator remain unbuilt.

**The strategy's `preferredArea` is never geocoded.** It reaches assembly as prompt context and is
compared against candidate addresses by the model, not by us. A model can therefore schedule two
stops it believes are adjacent that are not — until routing runs and says so.

**Candidate ordering is alphabetical, not spatial.** The pool is ordered by category then name, so
the model's choice between eight cafés is informed by their addresses and nothing else. Distance to
the destination centre is deliberately absent, since including it would be a computed signal.

**Prompt caching is unverified.** The system instructions are frozen and cacheable, but nothing
asserts a cache hit — Gemini's implicit caching reports through fields the adapter does not read.

**One generation per request, and no queue.** Two browser tabs generating at once each pay their own
Overpass and model calls; the OSM limiter is per process, so several serverless instances multiply the
true ceiling as they already do for routing.

---

## Phase 6A — Safe refinement, regeneration and route recovery ✅ SHIPPED

Delivered 2026-07-27. A traveller can change a saved trip — one stop, one backup, one day, or
the whole itinerary — and retry only the routes that failed, without weakening any invariant
that produced the trip in the first place.

### The product decision, recorded
- [x] **Constrained actions, not free text.** Eight typed commands in a closed Zod union. A
      prompt field would be an instruction channel capable of asking for a place that was never
      discovered, and the schema would be no defence
- [x] Because each action is narrow, its *result* can be checked against its own promise —
      "cheaper" that cost more is a failure, not a result
- [x] **Rollback is structural.** The pipeline persists nothing and the failure arms carry no
      plan, so a refused, rejected, timed-out or cancelled refinement leaves the saved trip
      untouched rather than restored

### The command model (`lib/refinement/commands.ts`)
- [x] `regenerate-trip` (with optional `preserve`), `replace-item`, `replace-backup`,
      `adjust-day`, `retry-routes`
- [x] Nowhere to put a coordinate, a duration, a geometry, a place name as identity or a
      mutation instruction — asserted by tests that check those keys are stripped
- [x] `AiRefinementCommandSchema` is what the refine route accepts; `retry-routes` goes to the
      routing route, which owns the routing provider and its budget

### Capabilities
- [x] **AI-required:** regenerate, replace stop, replace backup, adjust day
- [x] **Deterministic:** route retry, recalculation, revision checks, invalidation, pool
      validation, total recomputation, canonical attachment, atomic save, undo
- [x] A Gemini/Ollama trip needs a real model; with none configured the AI actions are
      **disabled with the reason shown** and route retry keeps working
- [x] A demo-planner trip may be refined by the demo planner — the same planner doing the same
      job, so the keyless path is not a dead end
- [x] `lib/refinement/eligibility.ts` is the one predicate the panel, the per-stop action and
      the per-backup action all use, so they cannot disagree

### Provider boundary
- [x] One new operation, `refinement`, on the existing `StructuredGenerator`. No second
      AI-client architecture
- [x] Output schemas are tiny — a `placeId`, a description, a cost — rather than a whole
      `TripPlan` for one swap
- [x] **One model call per refinement, no repair.** A model that misreads a thirty-item list is
      not going to be talked round
- [x] `lib/providers/ai/deterministic/refine.ts` — nearest eligible candidate, and
      `unavailable` with a reason when the day offers no such move. It will not shave an
      estimate to satisfy a button

### Candidate derivation (`lib/refinement/candidates.ts`)
- [x] Facts only: pool membership, category, already-in-use, bounded distance, explicit
      preference. **No score of any kind**
- [x] Ordering is distance-from-anchor, then name, then id — total, stable, and a claim about
      geometry rather than about the place
- [x] An **empty** category list means "nothing eligible", never "no filter"
- [x] A backup place is schedulable during a day adjustment (`includeBackups: false`)
- [x] `cheaper` cannot be a filter — same category, same band — so it is verified instead

### Route invalidation (`lib/refinement/invalidate-routes.ts`)
- [x] One rule for all five situations: keep a segment if and only if its leg id is still
      expected. A leg id **is** its adjacency
- [x] A replaced stop gets a **new item id**, so the previous place's routes cannot survive
      re-keying and put real geometry on a journey nobody makes
- [x] Nothing compares array positions
- [x] Invalidation is **measured** by diffing the two plans, not accumulated — the accumulated
      version was wrong for a replaced stop and for regeneration
- [x] `totalTravelMinutes` and the coverage summary recomputed; `plan.routing` dropped when no
      segment survives
- [x] `selectRetryLegs` — explicit ids, `unavailable-only` (which excludes retained estimates),
      or `all`

### Pool-stable regeneration
- [x] Reuses the generation pipeline with `existingPool`, which skips discovery entirely: no
      Overpass request, no geocoding, provably the same universe of places
- [x] The strategy call is told which categories the pool actually holds
- [x] `preserve` passed to the model **and** verified afterwards
- [x] Destination, dates, party size, currency, trip id and `createdAt` all preserved
- [x] Every route cleared, `plan.routing` with it — a regenerated itinerary shares only its
      dates with the old one
- [x] A **pool refresh** is deliberately not implemented: it would change what places exist

### Persistence and undo
- [x] `applyRefinement` — plan, context and snapshot in one guarded `set`
- [x] `StoredTripRecord.previousSnapshot` — **one** level, optional, so every pre-6A record
      parses unchanged and `STORE_VERSION` stays at 2
- [x] Undo restores **forwards**: the revision increments, because decrementing would make two
      states share a revision number
- [x] **Routing is not undoable**, by decision: it adds provider facts and takes nothing away,
      and undoing it would consume the slot a refinement needs
- [x] A corrupt snapshot is ignored safely rather than becoming the traveller's trip

### API
- [x] `POST /api/trips/refine` — SSE progress plus one buffered result, or JSON. 512 KB cap,
      `maxDuration = 90` against a 60 s internal budget, no persistence, no routing calls
- [x] Day and pool caps re-checked before any model call
- [x] `POST /api/trips/route` gained `retryLegIds`, filtered server-side against the plan's
      expected legs
- [x] No prompt, raw model output, provider payload or secret crosses back; internal error
      context is stripped to `code`, `message`, `dayNumber`, `itemId`

### Workspace
- [x] `RefinePanel` — a disclosure rather than a popover, so keyboard and screen-reader
      behaviour comes from the platform and there is no focus trap to get wrong on a phone
- [x] Regeneration confirms; a single replacement does not, because one Undo reverses it
- [x] Per-stop "Replace this stop" rendered **outside** the card, since the card is itself a
      single `<button>` and nested buttons are invalid HTML
- [x] Per-backup "Replace"; per-segment "Retry" on unavailable legs only
- [x] The outcome states what changed and how many routes need recalculating
- [x] Rapid clicks cannot duplicate a request — a ref guard, because React has not re-rendered
      when a second click lands in the same tick

### Tests — 1,022 unit tests, 53 files (up from 837 / 45)
- [x] Commands: every action, arbitrary actions rejected, prompt text stripped, coordinates and
      route facts stripped, day bounds, bounded preserve lists, charset
- [x] Candidates: pool membership, exclusions, distance bounds, indoor/outdoor, deterministic
      total ordering, cap, no fake ranking, empty-list semantics, preference mapping
- [x] Schedule: intervals, duration floor, overlap, transition floor, day bounds, pace caps,
      meal coverage, day alignment, and that opening hours are *not* interpreted
- [x] Invalidation: replace, remove, add, reorder, regenerate, unaffected preserved, stale
      geometry dropped, not keyed on position, retry selection, duplicate collapse
- [x] Appliers: canonical attachment, **reference equality** on untouched items and days, new
      item id, cost clamping, recomputed totals, no input mutation
- [x] Orchestration: one model call, no discovery, no routing, eligible subset, fabricated place
      fails with no plan, prohibited field fails, unavailable becomes a visible gap, cheaper
      verified, adjustment promises verified, refusal and timeout carry no plan
- [x] Regeneration: pool retained, available categories passed, destination/dates/party
      preserved, routes cleared, preserve enforced, invalid result fails
- [x] Persistence: snapshot captured, routing does not consume it, undo restores and increments,
      one level only, corrupt snapshot rejected, no provider response stored
- [x] API: body cap, day cap, pool cap, `retry-routes` rejected, context required, both delivery
      shapes, no leaks, failure carries no plan
- [x] Targeted retry: only named legs requested, stale ids ignored, duplicates collapsed
- [x] No unit test contacts a model or a public endpoint

### Browser verification — 102/102
- [x] Real Chrome over CDP with Nominatim, Overpass, Gemini and Valhalla all local fixtures.
      The whole server pipeline runs; nothing leaves the machine
- [x] The Gemini fixture answers refinements as well as generations, and gained a
      `fabricate-refinement` mode so the rejection path can be reached on a trip that exists
- [x] Verified: the panel appears on a generated trip; AI actions disabled with a reason and
      per-stop replacement absent when no planner is configured; route retry available and
      working without one; a replacement applies, attaches the canonical place, changes no
      unrelated stop, clears the affected route line and keeps the others, recomputes coverage
      and increments the revision exactly once; routing does not consume the undo slot; undo
      restores the previous itinerary, increments the revision, keeps only one level and then
      disappears; a day adjustment lowers the estimate or honestly reports it cannot; a refresh
      preserves the refined plan and its pool; a fabricated replacement is rejected with the
      trip byte-identical afterwards and no provider detail on the page; keyboard reachable, no
      hover-only control, mobile usable, no hydration warnings, no console errors, no horizontal
      overflow
- [x] Production build: `/dev/*` 404s, no store seam, prompt text or provider host in any client
      chunk, 512 KB body cap enforced
- [x] All Phase 1–5B checks still pass

---

## Phase 6A deviations and notes

**Q1 — the demo planner may refine its own trips.** The brief said not to silently use the
deterministic planner for "an existing real generated trip", which leaves the demo planner's
*own* trips unaddressed. Refusing them would make the keyless path a dead end — plan for free,
then be unable to change anything — so `resolveRefinementProvider` allows it and forbids the
substitution the brief actually warns about.

**Q2 — `retry-routes` is dispatched to the routing route.** The brief allowed a separate route
"only if necessary". It was the opposite: adding `retryLegIds` to `POST /api/trips/route` reuses
the expected-leg derivation, the service, the cache and the duration budget, whereas putting
routing inside the refinement endpoint would blur the boundary §16 draws.

**Q3 — invalidation is measured, not reported.** Handlers were originally asked which legs they
had invalidated. That was wrong twice: an applier clears a replaced stop's own segment before
re-keying can see it, and regeneration builds a fresh plan that never held the old segments.
Both produced an empty list beside a plan whose routes had visibly gone. Diffing the two plans
cannot make that mistake.

**Q4 — meal coverage is checked relative to the previous day.** Checking it inside
`validateRefinedPlan` was vacuous: with only the finished plan available, the baseline is the
day's own meals, so a day that dropped its breakfast simply stops requiring one. It moved to
`validateAdjustmentHonoured`, which has both days.

**Q5 — a replaced stop gets a new item id.** Reusing the old one would have kept the leg ids
stable and avoided invalidating routes, which is exactly why it must not be done: those routes
measured journeys to a *different place*.

**Q6 — an empty category list means nothing is eligible.** The first version treated it as "no
filter", so a "quieter" request that ruled out every category silently offered every kind of
place. The two cases are now distinct in the type's documentation and in a test.

**Q7 — a backup place is schedulable during a day adjustment.** Treating it as in-use ruled out
the obvious way to make a day cheaper. It is still excluded when replacing a *stop*, where
offering the day's own fallback is not an alternative.

**Q8 — no new dependency, and no new environment variable.** Refinement reuses the provider
configuration, the cost bands, the immutable builder and the leg-identity scheme already in
place.

**Q9 — three harness bugs, all producing vacuous passes.** A toggle clicked twice returns to
where it started, so the browser suite now drives the panel to a known state from its own
`data-open` flag; a hand-written `mode:walk` leg id was simply wrong, because the mode comes
from the distance between two real coordinates, so fixtures derive ids instead; and a regex
containing `candidates[` could not survive both a template literal and the page's parser, so
that check uses substring matching. The second of these is the one worth remembering — it made
nine route-invalidation tests fail for a reason unrelated to what they were checking.

---

## Phase 6A known limitations

**A backup cannot be promoted into the itinerary.** Replacing a stop *with* its backup is the
obvious next action and is not implemented: it changes an adjacency, so it needs the invalidation
path a replacement uses, and the brief scoped it out.

**No pool refresh.** Every refinement is confined to the places found when the trip was
generated. A destination whose map data has improved since cannot benefit without generating a
new trip. This is deliberate — a refresh changes what places exist, which is a materially
different operation — but it does mean a trip's pool ages.

**One level of undo, and only for refinements.** A second refinement discards the first's
snapshot. Routing is not undoable at all, by decision.

**Day adjustment is one shot with no repair.** A model that returns a day violating the pace cap
fails outright; the traveller presses the button again. That is cheaper than two model calls on
every edit but does mean an occasional wasted attempt.

**`preferredArea` is still never geocoded.** A replacement is bounded by distance from the stop
it replaces, which is a real check — but the model's sense of which places are "near each other"
is still inferred from addresses rather than measured, until routing runs.

**Adjustments cannot move a stop between days.** Every action is scoped to one day or to the
whole trip; "move this to Thursday" has no command.

**The refine panel is a disclosure, not a command palette.** With eight actions that is
comfortable. It will not scale to thirty.

**No per-leg retry from the map.** The retry affordance lives on the itinerary's segment rows;
clicking a route line on the map does nothing.

---

## Phase 6B — Schedule accuracy, opening hours and destination-aware costs ✅ SHIPPED

Delivered
- [x] `lib/opening-hours/` — a conservative `opening_hours` subset parser (`parser.ts`), an
      override-applying normaliser (`normalize.ts`), a curated IANA timezone table with DST
      resolution (`timezone.ts`), and a seven-state evaluator (`evaluate.ts`). Pure,
      client-safe, no clock, no network, no dependency
- [x] Bounded before parsing: 512 characters, 24 rules, 8 intervals per rule; every regex
      anchored and free of nested quantifiers; `25:00` rejected, `24:00` end-of-day, a
      zero-length interval rejected rather than read as "closed"
- [x] Unsupported constructs refused **whole** rather than half-read: `PH`, `SH`,
      sunrise/sunset, `easter`, week numbers, month names, quoted comments, `||`, `09:00+`,
      literal `unknown`
- [x] `lib/plan/schedule-report.ts` — plan-level aggregation, derived on every read and never
      persisted; conflicts (the one closure claim) separated from warnings (absences)
- [x] `lib/plan/schedule-repair.ts` — one deterministic pass at generation, moving a stop's
      clock within its own day and nothing else; applied only if the moved stop verifies open
      *and* the day stays sound
- [x] `lib/costs/` — versioned, hand-entered destination profiles holding only dimensionless
      weights and relative multipliers; budget allocation that reconciles **exactly**; a
      two-stage estimate (allocate from the budget, clamp into the currency's own band); and
      `validate.ts` asserting both the allocation identity and the curated table
- [x] `TripGenerationContext.destinationTimezone` and `.costProfile` — optional, so
      `schemaVersion` stays 1, `TRIP_PLAN_SCHEMA_VERSION` 3 and `STORE_VERSION` 2 unchanged
- [x] Three new deterministic commands — `resolve-hours-conflict` (adjust-time /
      replace-place / mark-unavailable), `move-item-time`, `recalculate-estimates` — applied
      entirely in the browser under the same revision guard and undo snapshot, with no
      endpoint
- [x] `components/trip/schedule-accuracy.tsx` and `opening-hours-badge.tsx` — three visual
      states, icons and words rather than colour alone, never green for unknown, the OSM
      string shown verbatim wherever it could not be read
- [x] Cost-profile and timezone provenance in the details panel
- [x] 1,336 unit tests across 65 files; 137/137 browser checks (35 of them Phase 6B), all
      against local fixtures

---

## Phase 6B deviations and notes

**R1 — unknown hours are not generation warnings.** The brief asked for unresolved conflicts to
be retained as explicit warnings, which they are. Unknown hours are not, and that was a
deliberate call: most OSM places have no `opening_hours` tag at all, so a warning per unchecked
stop turned every clean generation into a `partial` result and buried the conflicts that
mattered. They are stated instead in the derived schedule-accuracy report, per stop, where a
traveller can act on them. Seven existing generation tests were asserting a clean pipeline and
would have been asserting something else.

**R2 — the automatic repair moves a clock, never a place.** "One deterministic repair using only
the existing pool" would also permit substituting a pool place. It does not: a substitution is a
visible change to what the traveller asked for, and it belongs behind an action they take rather
than behind a generation step they did not. Substitution *is* offered — as
`resolve-hours-conflict` with `replace-place`, chosen by the traveller from candidates the pool
already vouches for.

**R3 — "Move to opening hours" is not drawn when there is nowhere to move to.** The button is
gated on the same slot-finder the repair uses. A stop closed all day has no slot, and offering a
control whose only possible outcome is an error message is worse than not offering it. The
browser suite asserts the absence.

**R4 — a re-estimate rewrites provenance even when the amount does not move.** An item can come
out at the same figure while its `basis` changes from `category-estimate` to `destination-band`.
Leaving the old basis would leave a figure claiming a provenance that no longer produced it, so
the estimate is rewritten and `changedItemIds` stays about money alone.

**R5 — five modules were importing barrels that re-export `server-only` code.** The Phase 6B
repairs run in the browser, which turned an aspirational client-safety claim into a build
failure. `lib/refinement/{schedule,replace-item,replace-backup,adjust-day,candidates}.ts` and
`lib/costs/allocate.ts` now import `@/lib/generate/pace-policy`, `assemble-plan` and `candidates`
by file rather than through `@/lib/generate`, and `lib/generate/pace-policy.ts` imports
`@/lib/plan/policy` rather than the plan barrel so the new exports do not close a cycle.

**R6 — the browser fixture's `opening_hours` strings had to be re-tagged against what the fixture
planner actually chooses.** Tagging places it happens not to schedule left every Phase 6B state
untested while looking covered. `ROAMLY_DEBUG_HOURS=1` prints the itinerary, the warnings and the
rendered badges for exactly this.

**R7 — the refinement fixture pool was fully consumed by its own itinerary.** Every one of its
seven places was in use, so no swap was possible — and a real pool is always larger than the plan
it produced. `generationWithSpare()` adds one unused café rather than reshaping the shared pool
and disturbing the candidate counts other tests assert.

**R8 — a repair that reorders a day renumbers `order`.** `order` is what the cards and the
routing legs are built from, so a stop moved from the morning to the afternoon whose `order`
still said "first" would give a day whose displayed sequence and actual times disagree. Reference
preservation therefore holds exactly for stops the move does not pass.

---

## Phase 6B known limitations

**The parser covers a subset, and says so.** Public holidays, school holidays, seasonal ranges,
sunrise/sunset, week numbers and the `||` fallback all produce `unknown_unparsed` with the string
shown as recorded. That is the correct answer for those strings, but it does mean a real
proportion of OSM data is uninterpreted rather than interpreted conservatively.

**The timezone table is curated and small.** ~50 cities and ~50 single-zone countries. A
destination in a multi-timezone country with no city entry has *no* schedule verdicts at all —
every stop reads "hours not checked". Truthful, and a real coverage gap.

**No `nextKnownOpening` across days.** "Closed Saturday, opens Monday" is not offered, because it
reads as a booking-grade fact about data that may be years old. The rule is shown instead.

**Cost profiles cover five cities and three fallbacks.** Everything else falls back to a regional
or global profile with correspondingly lower stated confidence. Adding a city means hand-checked
numbers and a source note; it is not a data pipeline and should not become one without the
sourcing to justify it.

**No currency conversion, by decision.** A traveller budgeting in AED for a European trip gets
AED figures from the AED band table, not converted euros. The bands are independent and
hand-written, which is more honest and also more accurate — but it means adding a currency is
manual work, not a rate lookup.

**Flights, accommodation and `transport` are not re-estimated.** They are carried through a
recalculation: the first two were allocated once at generation, and `transport` has no per-item
source in the schema, so recomputing it would mean inventing an attribution rule.

**An overnight interval is never used as a repair slot.** A stop moved into `18:00-02:00` would
cross midnight, and a day is a closed routing unit here.

**Opening hours are still not a saving gate.** A plan with conflicts saves normally. Deliberate —
the hours may be stale and the parser covers a subset — but it does mean a traveller can keep an
itinerary the data says is impossible.

---

## Phase 6C — Structural editing, backup promotion, cross-day moves and pool refresh ✅ SHIPPED

Delivered
- [x] `lib/structural-edits/` — a pure, client-safe boundary: `position.ts` (named positions,
      never indices), `schedule.ts` (deterministic time placement), `promote-backup.ts`,
      `move-item.ts`, `commit.ts` (the single commit path), `pool-age.ts`, `pool-diff.ts`,
      `reconcile-pool.ts`, `validate.ts`
- [x] Three commands on the closed union — `promote-backup`, `move-item`, `refresh-place-pool` —
      with one `TargetPositionSchema`, bounded categories and radius, and no way to express a
      coordinate, a place name as identity, a route fact or free text
- [x] Backup promotion: canonical pool record attached whole, a **new** item id, the promoted
      backup removed and recorded, retained places refused as new selections
- [x] Cross-day movement: item id stable, dates untouched, `transport`/`logistics` locked, a move
      that would empty a day refused, both days' totals recomputed, costs carried with the stop
- [x] Deterministic slot selection with explicit-times override, validated against the window the
      *chosen position* leaves, and a clean `no_slot_available` refusal rather than an insertion at
      an impossible time
- [x] `POST /api/trips/refresh-pool` — preview only: a refreshed pool, a deterministic diff, and a
      reconciliation preview per policy from one search. No model, no routing, no geocoding, no
      persistence, `maxDuration = 60`
- [x] Pool age (`fresh`/`aging`/`stale`/`unknown`) from an injected instant, worded so it never
      claims the places have closed
- [x] Two reconciliation policies, neither of which picks a replacement place; `retainedPlaces` on
      the generation context, capped at 48, with the widened pool invariant paid for by
      `validateRetainedPlaces`
- [x] `components/trip/placement-dialog.tsx` — one dialog for both edits, previewing the resulting
      time and the target date's opening-hours verdict through the same functions the edit uses; no
      drag-and-drop, everything keyboard-operable
- [x] `components/trip/place-pool-panel.tsx` — age, count, retained-place note, and the
      confirm → search → diff → policy → confirm flow
- [x] `TripGenerationContext.retainedPlaces` optional, so `schemaVersion` stays 1,
      `TRIP_PLAN_SCHEMA_VERSION` 3 and `STORE_VERSION` 2 unchanged
- [x] 1,530 unit tests across 74 files; 188/188 browser checks (51 of them Phase 6C), all against
      local fixtures

---

## Phase 6C deviations and notes

**S1 — object identity does not survive a structural edit.** `commitStructuralEdit` re-parses the
finished plan, and Zod rebuilds it, so unrelated items come back deep-equal rather than `===` as
they do from the refinement appliers. The parse was kept: a structural edit rearranges the itinerary
rather than swapping one field, so it is the change most likely to produce a shape the schema would
reject. The appliers still return untouched items by reference *into* the commit, so preservation is
enforced where it is cheap and asserted by deep equality where it is not.

**S2 — `addedLegIds` is measured against the expected leg set, not the stored segments.** The first
implementation compared against the segments a plan happened to hold, so a trip whose routes had
never been calculated reported every one of its legs as newly created — "two new journeys" became
"eleven". What a traveller needs is the journeys the *edit* created, which is a question about the
itinerary's shape.

**S3 — `requiresPlanner` became a positive list.** It was "everything except `retry-routes`", and
the exclusions grew to six across two phases. An exclusion list gets a new command wrong by
default — silently routing it to the planner endpoint — so the four AI actions are now named
explicitly.

**S4 — the browser fixture planner was offering backups it later scheduled.** It picked a
day-one fallback with `peek` and, two days later, made the same place a stop with `take`. Promoting
one was then correctly refused as a duplicate, which made the suite fail for a reason unrelated to
promotion. A backup now **reserves** its place. A real planner should not do this either.

**S5 — the fixture planner treated the check-in block as a droppable stop.** It is a place stop with
no meal type, so "make this day cheaper" removed the hotel — and because accommodation is a
canonical budget category rather than one derived from items, the day total fell while the trip
total did not. Accommodation categories are now excluded from the droppable set. The underlying
asymmetry is real and is recorded as a limitation below.

**S6 — a mid-day promotion is refused on a tightly-planned day, and the dialog says so before
anything is submitted.** The browser suite asserts the refusal rather than working around it: the
confirm control is disabled and the reason is on screen. The invalidation case is exercised by the
*move*, which genuinely splits an adjacency.

**S7 — the old retained collection is not carried forward across refreshes.** A place retained by a
previous refresh either turns up again — in which case it is a pool member and needs no special
case — or it does not, in which case the new pass retains it from the plan. Merging the two lists
would accumulate entries no plan references, which is exactly what `validateRetainedPlaces` reports
as a hard failure.

**S8 — the pool refresh re-reads the revision at the commit step.** The echoed `expectedRevision`
is carried through the response for symmetry with the other routes, but the guard uses the
*current* record: the search takes seconds, and comparing against a token read before it would
guard nothing.

---

## Phase 6C known limitations

**No drag-and-drop.** Position is chosen from a radio list. Deliberate — it is keyboard-operable and
needs no touch story of its own — but it is more clicks than dragging a card.

**A move never re-times the day around it.** The source day's gap simply closes and the target day's
stops are untouched. That keeps the edit to one change, and it does mean a day can be left with an
awkward hole the traveller has to close themselves.

**One item at a time.** There is no multi-select, no "move the whole afternoon", and no undo deeper
than one level, so a five-stop rearrangement is five edits and only the last is undoable.

**`transport` and `logistics` blocks cannot be moved at all.** The lock is by `kind`, so a
legitimately movable logistics block — a left-luggage stop, say — is locked with the airport run.

**A day's cost can move without the trip's total moving.** `dayTotal` sums every item, but only
`food` and `activities` are derived from items; `flights`, `accommodation` and `transport` are
canonical. So adding or removing a `logistics` stop changes a day total and not the trip's. This is
pre-existing and now visible; fixing it needs a per-item cost category, which is a schema change.

**Pool refresh cannot narrow the search from the interface.** The command accepts `categories` and
`radiusMeters` and the route honours them, but the panel always re-runs the original search's
parameters. There is no UI for a narrower refresh.

**Retained places are never re-checked.** Once a place is retained it stays retained until a later
refresh finds it again. Nothing periodically asks whether it has come back.

**A partial search can still be applied.** The interface warns prominently that some places are
missing from the *result* rather than from the map, and then lets the traveller proceed. Blocking it
would be defensible; it is not blocked.

**No multi-city trips, and no change of dates.** Both remain out of scope, and cross-day movement
does not open a path to either.

---

## Phase 7 — Deployment hardening and release verification ✅ SHIPPED

Delivered
- [x] **Storage resilience.** `lib/store/capacity.ts` probes whether a write will fit *before* the state
      changes — Zustand's `persist` writes after the update, so a full quota previously showed a saved
      trip that vanished on reload. Every guarded save now pre-flights.
- [x] `lib/store/storage-usage.ts` — exact measurement of what the app stores, kept separate from the
      browser's own fuzzy estimate and never divided into a fabricated percentage
- [x] **Export and import.** `lib/store/portable-trip.ts` — a versioned document wrapping the whole
      record. Import runs `TripRecordSchema` *and* `validatePlanMembership`, so a tampered file cannot
      bypass the pool invariant. Copy or confirmed replacement; a failed import writes nothing
- [x] `components/trip/storage-panel.tsx` — count, bytes, largest trips, per-trip export/delete, undo-
      snapshot drop with confirmation, clear-all with confirmation
- [x] **Offline handling.** `lib/hooks/use-online-status.ts` plus a banner; every provider-backed control
      disables itself with a specific reason rather than starting a doomed request
- [x] **Production metadata.** `metadataBase`, canonical, Open Graph, Twitter card, robots, theme colour,
      a favicon from the wordmark glyph, and a social image generated from JSX by `next/og`
- [x] **Basemap override** via `NEXT_PUBLIC_BASEMAP_STYLE_URL`, and a completed `.env.example` covering
      all thirteen variables
- [x] **Structured logging** (`lib/providers/log.ts`) with a field **allowlist**, so a caller who passes
      a destination gets a log line without it rather than a leak
- [x] **Production smoke test** (`npm run test:smoke:production`) — 28 checks against a deployed or local
      production build, using only static fetches and deliberately invalid requests
- [x] **Screenshots** (`npm run screenshots`) — ten captures from a *production* build against local
      fixtures, asserting afterwards that no fixture URL, key name or provider host is visible
- [x] `docs/DEPLOYMENT.md`, `docs/DEMO_SCRIPT.md`, a rewritten README with a Mermaid architecture
      diagram, `SECURITY.md`, a CI workflow, and `.claude/{settings,memory}.md`
- [x] 1,590 unit tests across 78 files · 188/188 browser checks · 28/28 smoke checks

---

## Phase 7 deviations and notes

**T1 — no performance changes were made, because measurement said none were warranted.** MapLibre is
absent from the landing page's first-load set (its `react-loadable-manifest.json` is `{}`); it ships as a
lazy 1,032,126 B JS + 69,808 B CSS chunk when the trip map mounts. Landing first-load is 1,078,200 B
across 14 chunks. No provider host, key name or prompt phrase appears in any client chunk. All three
expensive derivations were already memoised. Reporting "no change" is the honest outcome; inventing an
optimisation to have something to report would not be.

**T2 — All Days marker density: Option B, already satisfied.** The day selector *is* the focus control,
and a trip is bounded at 7 days × the pace stop cap, so All Days peaks near 23 markers. A second toggle
beside an existing one would be redundant UI, so the decision is recorded rather than built.

**T3 — the smoke test caught a stale server, which is exactly its job.** Its first run reported six
failures — missing metadata, a 404 on `refresh-pool` — because a `next start` from an earlier phase was
still bound to port 3000 and serving old code. Recorded in `docs/DEPLOYMENT.md` as a trap, since it reads
like a code failure and is not.

**T4 — `shadcn` moved from `dependencies` to `devDependencies`.** It is a code-generation CLI: bin-only,
no `main`, zero runtime imports. The misclassification put it and two of its transitive dependencies in
the production tree. `npm audit --omit=dev` went from 6 advisories to 3.

**T5 — three production advisories accepted with evidence, not patched.** `next`, `postcss` and `sharp`
all offer the same remediation: `next@9.3.3`, a downgrade across seven majors. `sharp` is Next's image
optimiser and there is **no `next/image` usage anywhere**, so the libvips path is never invoked;
`postcss` processes only CSS this repository authors. See `SECURITY.md` for the per-package reasoning.

**T6 — `test/browser/run.mjs` now exports its helpers and guards `main()`.** The screenshot script reuses
`submitForm`-style helpers, and a bare `await main()` would have run the whole 188-check suite as an
import side effect.

**T7 — screenshots come from `next start`, not `next dev`.** The verification suite needs the
development-only `__roamlyTripStore` seam, so it runs `next dev` — which renders the Next devtools badge.
A badge is a developer tool, and a published image must not contain one. The capture script therefore
starts a production server and navigates by link rather than through the store.

**T8 — two capture bugs were fixed rather than accepted.** The "destination confirmation" shot was a
duplicate of the landing page (the content was below the fold, and a swallowed timeout hid it), and
"generation in progress" was a duplicate of the finished workspace (the fixture answered faster than the
capture). Both are now mandatory waits on the actual content, with the Gemini fixture deliberately slowed
for the progress shot.

**T9 — security review found five issues; four were fixed.** `FlightEstimate.searchUrl` accepted
`javascript:` and `data:` because Zod's `.url()` only checks that `new URL()` parses — now scheme-
constrained at the schema. `reviveRecords` used unsafe bracket assignment on keys from raw
`localStorage` — now a prototype-less map with an explicit key filter. The import size cap now checks
`file.size` (real bytes, no read) rather than only `text.length` (UTF-16 units, after decoding). A
`"__proto__"` plan id produced a false "trip already exists" message — now `Object.hasOwn`.

**T10 — accessibility review found twelve issues; six genuine barriers were fixed.** No focus trap or
focus restoration in the placement dialog; an invisible file input that was still tabbable and
unlabelled; three silent state transitions; a confirm-label swap with no announcement; terracotta text at
~3.3:1 on a terracotta tint (a new `--terracotta-ink` token at 4.5:1+); and repeated unqualified
"Delete"/"Export" names on the storage rows.

---

## Phase 7 known limitations

**Border contrast is a systemic token issue.** `--line` against cream computes near 1.2:1, under the 3:1
that WCAG 1.4.11 wants for a control boundary. It affects the whole visual system rather than any file
this phase touched, and changing it is a design decision rather than a bug fix. Accepted and recorded.

**Opening-hours elaboration is hover-only for sighted keyboard users.** The state label is always visible
text and the full detail is in an `sr-only` span, so screen-reader users have it — but the `title`
tooltip cannot be triggered by keyboard. Accepted because the same information appears in full,
keyboard-reachable text in the schedule-accuracy panel.

**The screenshots show the schematic map fallback.** Headless Chrome has no WebGL and the fixture
environment reaches no tile host. It is a real product state — what a visitor without WebGL sees — but not
what the map looks like in a browser. Noted beside the images.

**`maxDuration = 120` on generation exceeds Vercel's Hobby limit.** On Hobby, a long Gemini generation is
cut off by the platform before the internal budget fires: the request fails and nothing is saved, which
is safe but harder to explain. Documented in `docs/DEPLOYMENT.md`.

**No CI browser suite.** The workflow runs types, lint, unit tests and the build. The CDP suite needs a
real Chrome and the live suites would put CI traffic on donated public services on every push.

**No error tracking and no analytics.** Deliberate. Vercel's function logs are the only server-side
observability, and they carry no travel data by design.

---

## After deployment

Only bug fixes, security fixes, infrastructure replacement, evidence-based performance work and
provider-capacity changes. There is no Phase 8 feature plan, by decision.

---

## Superseded — the original Google-based phases

Kept for provenance. **Do not implement these**: Phases 2–3 replaced the whole Google
stack with free, keyless OpenStreetMap providers. The field-mask billing notes and
Routes API contracts below no longer apply to this project.

### Superseded — Google data layer

Server-side only, behind `ROAMLY_USE_MOCKS`. Record real responses into fixtures **first**, then
write mappers against the recorded bytes — never against an assumed shape.

- [ ] `lib/google/fieldmasks.ts` — named mask constants per search intent. Every mask lives here;
      none is built inline (this is the billing-tier control, see ARCHITECTURE §5)
- [ ] `lib/google/places.ts` — `searchText` POST to
      `https://places.googleapis.com/v1/places:searchText` with `X-Goog-Api-Key` +
      `X-Goog-FieldMask`; Zod-parse `{ places: [...] }` on the way in
- [ ] `lib/google/mappers.ts` — `Place` → `PlaceCandidate`; `PRICE_LEVEL_*` → cost band;
      `location.{latitude,longitude}` → internal coords
- [ ] `lib/google/routes.ts` — `computeRouteMatrix` POST to
      `https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix`
      (note: `distanceMatrix/v2:`, **not** `directions/v2:`). One call per day, that day's stops as
      both origins and destinations. Check `condition` before reading `duration`
- [ ] Guard the documented element caps: 625 standard, **100 for `TRANSIT`**, 50 total
      origins+destinations when using Place IDs
- [ ] Deduplicate candidates by `placeId` across searches; cap results per search
- [ ] `app/api/places/photo/route.ts` — proxy photo bytes so the server key never reaches the client
- [ ] Record fixtures for one destination; add a "recorded on <date>" note beside each

**Done when:** a script prints real candidates and a real travel matrix for one destination, and the
same code path serves fixtures with `ROAMLY_USE_MOCKS=1`.

---

### Superseded — Claude pipeline (see Phase 5 above)

- [ ] `lib/claude/client.ts` — SDK client, model `claude-opus-5`, adaptive thinking. **No**
      `temperature`/`top_p`/`top_k` and no `budget_tokens` — all 400 on this model
- [ ] `lib/claude/prompts/` — two byte-frozen system prompts (strategy, assembly). No dates, trip
      IDs, or user values before the cache breakpoint; those belong in the user turn
- [ ] `cache_control: {type: "ephemeral"}` on both system prompts; assert
      `usage.cache_read_input_tokens > 0` on the second identical-prefix call in a dev check
- [ ] `lib/claude/strategy.ts` — call #1 → `DestinationStrategy` via
      `messages.parse()` + `zodOutputFormat(DestinationStrategySchema)`
- [ ] `lib/claude/assemble.ts` — call #2 → `DraftItinerary`, candidate pool in the user turn,
      stops referenced by `placeId` only. **Stream** (`max_tokens` will exceed ~16 000)
- [ ] Check `stop_reason === "refusal"` before reading `content` on both calls — a refusal returns
      HTTP 200 with empty or partial content
- [ ] Typed error taxonomy: refusal, rate limit, overload, schema mismatch, upstream Google failure

**Done when:** both calls return schema-valid objects, and call #2 provably cannot name a place
outside the pool it was given.

---

### Superseded framing — Orchestration, validation, repair

- [ ] `lib/pipeline/validate.ts` — the eight rules in ARCHITECTURE §7; returns `Issue[]`, never
      throws
- [ ] `lib/pipeline/repair.ts` — **exactly one** pass, same candidate pool, structurally unable to
      loop. Not a bounded retry — a single call
- [ ] `lib/pipeline/generate.ts` — the 8-step orchestration; parallel Places searches; per-day
      route matrices; final `TripPlanSchema.parse` before returning
- [ ] `app/api/generate/route.ts` — `POST`, Zod at entry, `export const maxDuration` sized for a
      two-call pipeline plus repair, typed JSON error envelope
- [ ] Wire the form to the real endpoint; `GenerationProgress` reflects real pipeline stages
- [ ] Surface surviving `Issue[]` in the UI — a plan with warnings must still be usable
- [ ] Slots that fail repair render as `unavailable`, never as an invented business

**Done when:** a real request produces a real, validated itinerary end to end, and a deliberately
impossible request (£50, 7 days, Tokyo) degrades with visible issues rather than fabricating.

---

## Phase 6 — Polish and deploy (original scope, still open)

- [ ] Loading, empty, and error states audited on every surface
- [ ] Keyboard traversal of the full flow; focus visible throughout; map has a non-map fallback
- [ ] Screen-reader pass: itinerary reads as an ordered list; markers are not the only affordance
- [ ] Mobile: 375px → 1440px, itinerary/map tab switch, no horizontal scroll
- [ ] `metadata` + OG image; favicon replacing the template's
- [ ] Vercel: env vars set, Google key restrictions verified in production (referrer + IP)
- [ ] Cost check: log Places SKU tier and Routes element count per generation
- [ ] README: setup, env vars, mock mode, cost notes

---

## Dependencies

### Installed in Phase 1

Resolved versions as of 2026-07-25.

| Package | Installed | Purpose |
| --- | --- | --- |
| `zod` | `4.4.3` | validation at every boundary; source of all types |
| `react-hook-form` | `7.83.0` | form state |
| `@hookform/resolvers` | `5.4.2` | Zod ↔ RHF bridge (see deviation D6) |
| `zustand` | `5.0.14` | trip + workspace state, `persist` middleware |
| `framer-motion` | `12.42.2` | restrained animation, client-only |
| `date-fns` | `4.4.0` | date maths and formatting |
| `nanoid` | `6.0.0` | trip ids |
| `lucide-react` | `1.26.0` | icons |
| `clsx` | `2.1.1` | class composition |
| `tailwind-merge` | `3.6.0` | class conflict resolution |

Pulled in by `shadcn init` and load-bearing (deviation D5):

| Package | Installed | Why it is required |
| --- | --- | --- |
| `@base-ui/react` | `1.6.0` | `button`, `input`, `badge`, `separator` are built on it |
| `class-variance-authority` | `0.7.1` | variant definitions in the generated primitives |
| `shadcn` | `4.14.1` | `app/globals.css` imports `shadcn/tailwind.css` for `data-*` variants |
| `tw-animate-css` | `1.4.0` | referenced by `shadcn/tailwind.css` |

Added in Phase 2:

| Package | Installed | Purpose |
| --- | --- | --- |
| `maplibre-gl` | `5.24.0` (exact) | the map renderer — BSD-3, no key, no billing |
| `react-map-gl` | `8.1.1` | React bindings, via its `react-map-gl/maplibre` entry |
| `vitest` | `4.1.10` (dev) | unit tests for the map derivations |

**Not installed**, contrary to the original plan: `react-day-picker` (deviation D3),
`@vis.gl/react-google-maps` and `@types/google.maps` (cancelled, deviation M1).

Added in Phase 3:

| Package | Installed | Purpose |
| --- | --- | --- |
| `server-only` | latest | turns a client import of the provider layer into a **build** error |

Nominatim and Overpass need **no client library** — both are plain `fetch` against public
HTTP endpoints, validated with Zod. No SDK, no key, no account.

### Deliberately not added in Phase 5B

No runtime dependency was added for AI generation. Gemini and Ollama are reached with `fetch`,
matching every other provider adapter in the codebase, and the browser-verification harness drives
Chrome over Node's built-in `WebSocket`. In particular **`@anthropic-ai/sdk` is not a dependency**:
Claude Code is the development agent, and the application's runtime planner is provider-independent.

### Still to add

| Phase | Package | Purpose |
| --- | --- | --- |
| 5 | `@anthropic-ai/sdk` | Claude API — the first paid dependency |

`@vis.gl/react-google-maps`, `@types/google.maps` and any Google Places or Routes client
are **cancelled**. Routing (Phase 4) is expected to need no client library either.

No HTTP client: Places and Routes are plain `fetch` POSTs. No database, no auth, no ORM — out of
scope by constraint.

---

## Technical risks

Ordered by expected cost of being wrong.

**1 · We become a bad citizen of free infrastructure.** ~~Google Places billing~~ — no
longer applicable; there is no bill. The replacement risk is worse in a different way:
Nominatim and Overpass are volunteer-run, and an accidental loop, a search-as-you-type
field or a parallel fan-out would be abuse of a shared public good, with blocking as the
consequence. → A process-wide promise-chain limiter (not a clock check), explicit-submit
only with a synchronous re-entry guard, server-side caching with empty-result TTLs, one
retry ceiling, an identifying User-Agent, and unit tests that never touch a live endpoint.
Self-hosting is the documented path before real traffic.

**2 · Response shapes drift from assumption.** Confirmed twice in practice: Nominatim's
`boundingbox` is `[south, north, west, east]` rather than the usual ordering, and Overpass
answers "too busy" with **HTTP 200 and an HTML body**. Both were found by probing live
responses, not by reasoning about them. → Fixtures reduced from real captured responses;
Zod on every inbound payload; response bodies sniffed, not trusted by status code alone.

**3 · Claude names a place that does not exist.** The central product risk, and now
mechanically defended ahead of the model arriving: `buildVerifiedPlacePool` and
`assertItineraryUsesPool` exist and are tested, `placeId` must equal
`source.canonicalId`, OSM element fields must reconstruct it, attached copies cannot be
renamed or moved, and unresolvable slots render `unavailable` rather than invented.
Nothing is silently repaired.

**4 · Latency vs. serverless limits.** Two Claude calls (the second streaming, with adaptive
thinking), parallel Places searches, up to seven route matrices, plus a possible repair pass. Vercel
function limits are real and vary by plan. → `maxDuration` set explicitly; stream call #2; run Places
searches in parallel; stage the progress UI so a 60-second wait is legible rather than suspicious.

**5 · Prompt caching silently never hits.** A single interpolated date or trip ID in the system
prefix invalidates the cache on every request — with no error, only cost. Minimum cacheable prefix on
Opus 5 is 512 tokens. → Prompts are frozen string constants; all dynamic content in the user turn; a
dev-mode assertion on `usage.cache_read_input_tokens`.

**6 · Refusals crash the pipeline.** `stop_reason: "refusal"` arrives as HTTP 200 with empty or
partial `content`; `content[0].text` throws. Adaptive thinking and elevated safeguards make this
worth handling on day one, not after the first incident. → Check `stop_reason` before reading
`content` at both call sites; typed refusal error surfaced as a retryable UI state.

**7 · The map stack breaks silently across a major version.** `react-map-gl@8.1.1` reaches into
MapLibre's internal `transform`, which changed shape in `maplibre-gl@6`. It installs, type-checks and
renders tiles — then the camera stops working, with only a console `TypeError` to show for it. This
already happened during Phase 2 and cost a debugging cycle. → `maplibre-gl` is pinned **exactly** to
`5.24.0`, the pin is explained in `package.json`'s neighbourhood and in BUILD_PLAN M2, and the browser
suite asserts a real camera outcome ("All Days fits Lisbon and Sintra") rather than merely that a
canvas exists.

**8 · Next.js 16 breaking changes.** Async `params`/`searchParams`/`cookies`/`headers` are Promises
with synchronous access *removed*, `middleware`→`proxy`, `revalidateTag` requiring a `cacheLife`
argument, `next lint` gone. Habits from 14/15 produce type errors at best and wrong behaviour at
worst. → `next typegen` early; consult `node_modules/next/dist/docs/` per feature rather than
recalling; `cacheComponents` deliberately off (§1).

**9 · localStorage hydration mismatch.** Reading storage during render diverges server and client
HTML. → Hydrate in a post-mount effect only; Zod-parse on read; discard on version mismatch. Also a
real ceiling: a handful of large `TripPlan`s can approach the ~5 MB quota — quota errors must be
caught, and the store must survive a failed write.

**10 · Server-only code leaking client-side.** One `import { searchText }` from a `"use client"` file
bundles the server key path into the browser. Next will usually error, but not in every shape. → ESLint
`no-restricted-imports` on `@/lib/{claude,google,pipeline}/*`; two Google keys with distinct
restrictions so a leak of the browser key is not a leak of Places/Routes billing.

**11a · OSM facts get mistaken for quality signals.** "Verified" now means "exists at
this location" — not good, not open, not affordable. A UI that presents an OSM place the
way it presented a 4.7-star Google result would be making a claim the data cannot support.
→ `CostEstimate` carries a `basis` and `confidence`; absent metadata renders as "unknown";
the dev surface shows missing fields explicitly so the gap is visible while building.

**11 · Flight estimates read as real prices.** No live inventory in the MVP. An unlabelled number
next to real restaurant costs implies a bookable fare. → Always rendered as "estimate" with a
visible external search link, never styled like a confirmed price.

**12 · Route matrix caps under-appreciated.** `TRANSIT` allows only 100 elements — a fifth of the
standard 625 — and Place-ID locations cap at 50 origins+destinations combined. Per-day batching keeps
us well inside both, but a future "optimise the whole trip" feature would breach them. → Enforce
per-day batching in `routes.ts`; assert element counts before dispatch rather than trusting the
caller.
