# Place intelligence — landmark enrichment from Wikidata and Wikimedia Commons

**Status:** Checkpoint 5B complete. Shipped behind an explicit traveller action; never automatic.
**Providers:** Wikidata (CC0) and Wikimedia Commons (per-file licence). No credential of any kind.
**Research gate:** `docs/PROVIDER_RESEARCH.md`. Nothing here may exceed what that document resolved.

This document describes what Roamly asks external encyclopaedias about a place, what it is allowed to keep,
and what a traveller actually sees. It is the operational companion to the research document: that one records
*what the terms permit*, this one records *what the code does*.

> **Naming.** "Checkpoint 5A/5B" is the place-intelligence series used throughout `lib/place-intelligence/`
> comments. It is **not** the same numbering as "Phase 5A/5B" in `docs/BUILD_PLAN.md`, which refers to trip
> generation. The two series are independent and were built in different phases.

---

## 1. The one rule that shapes everything

**Enrichment never runs on its own.** There is no request on landing, no request during trip generation, no
request when a saved trip is opened, no request on render, and no background pass. A traveller presses a
control, or nothing happens.

Two reasons, and the second is the load-bearing one:

- Wikimedia is volunteer-funded infrastructure, and its etiquette asks for serial requests and caching.
- Enrichment is **serial by requirement**, so a full trip takes seconds rather than milliseconds. Anything
  that ran it implicitly would be spending a volunteer service's capacity on a page view.

`lib/hooks/use-trip-intelligence.ts` holds the guard; `components/trip/landmark-controls.tsx` is the only
thing that calls it.

---

## 2. Scope — what gets enriched, and what never does

Enrichment applies to **public-interest landmarks only**, decided by a closed category allow-list in
`lib/place-intelligence/landmark-eligibility.ts`:

> `museum`, `gallery`, `monument`, `historic_site`, `attraction`, `viewpoint`, `park`, `garden`, `beach`,
> `place_of_worship`, `theatre`

**No restaurant, café, bar or ordinary hotel is ever enriched.** They are commercial premises rather than
public-interest places, an encyclopaedia has little to say about them, and the facts a traveller would want
about them — is it good, is it busy, what does it cost — are precisely the facts Roamly refuses to carry.

**No ratings, no reviews, no review counts, no popularity, no crowding, no live prices, no booking.** These
are refused at the fact-kind level in `lib/place-intelligence/facts.ts`, so they are refused whoever supplies
them. There is also no code path that could produce one.

**Cap: 12 candidate places per trip** (`MAX_LANDMARK_CANDIDATES_PER_TRIP`), selected itinerary-first and then
from the place pool, de-duplicated by canonical id.

---

## 3. Identity — how a place is matched to an entity

Three rungs, in `lib/providers/place-intelligence/enrich.ts`. They are *not* fallbacks for one another.

| Rung | Trigger | Method recorded | Rank | Facts attached? |
| --- | --- | --- | --- | --- |
| 1 | OSM `wikidata` tag | `shared-external-id` | 3 | **Yes** |
| 2 | OSM `wikipedia` tag, resolved by the official API | `shared-external-id` | 3 | **Yes** |
| 3 | Bounded geographic search (`wikibase:around`, 250 m) | `name-and-proximity` | 1 | **No — review only** |

- **A resolved QID is terminal.** If Wikidata no longer holds the tagged entity, the answer is "no
  enrichment" — never "look for something else nearby". Falling through would swap a rank-3 identity for a
  rank-1 guess.
- **An unusable `wikipedia` tag is the one fall-through.** A missing article, a disambiguation page, or an
  article with no entity all mean the tag told us nothing, so the geographic rung is still available.
- **A rank-1 match produces an identity and no facts.** `MINIMUM_TRUSTED_MATCH_RANK` is 2, and
  `mergeIntelligence` refuses every fact across an untrusted identity. So a nearby hit is offered for
  confirmation and nothing more — which is also why no entity fetch and no media lookup happen on that path.

**A shared external id is the only thing that displays.** A geographic match is a review item, not content.

### Identity collisions

One Wikidata entity may not auto-attach to two canonical places. The second place is reported `review` with
the holder named. This holds on the tag path too: two OSM records legitimately carry the same `wikidata` tag
sometimes, and "sometimes" is not a basis for putting one entity's photograph on two cards.

The canonical identity is always **OpenStreetMap's**. Wikidata never becomes the place's id, and enrichment
has no way to write a `TripPlace`.

---

## 4. What a card may show

Derived from the stored sidecar alone, by `lib/place-intelligence/landmark-card.ts` and
`lib/trip/landmark-context.ts`. Rendered by `components/trip/landmark-context.tsx`.

- a **description** — Wikidata's one-line gloss, in its own language, refused if promotional
- **facts** — founding year (`Dates from`), heritage designation, official website
- one **photograph** from Commons, when every media gate passed
- a **source line** and an expandable attribution disclosure

Everything is rendered as a **text node**. There is no `dangerouslySetInnerHTML` anywhere in the codebase, and
provider HTML is stripped before it is stored, not at render time.

### `Dates from` — a stated limitation

The year comes from Wikidata's `inception` (P571), or failing that `date of official opening` (P1619). It is
labelled **`Dates from`** rather than "Built in" deliberately: a monastery begun in 1501 and finished in 1601
carries one inception date, and "Built in 1501" would be a stronger claim than the data supports.

Precision coarser than a year is **dropped, not rounded**. Wikidata models decades and centuries, and
rendering a decade as a year would fabricate a fact.

### Stale descriptions

A description older than its freshness window is still shown, with a visible **stale label** beside it
(`lib/place-intelligence/freshness.ts`). Hiding it would lose real information; showing it silently would
present an old fact as current.

### Expired thumbnails

A media record past its freshness window is **omitted** rather than labelled. An image is not a claim a label
can qualify — it either shows the place or it does not.

---

## 5. Media — the licence path

`lib/providers/place-intelligence/wikimedia/media.ts`. Every gate fails **closed**, and every refusal is a
named code rather than a `null`.

Roamly **never touches the image bytes.** No fetch, copy, cache, resize, crop, re-encode or proxy. What is
stored is a URL on `upload.wikimedia.org` and the credit that must travel with it; the traveller's browser
loads the file directly from Commons. The scaled file is generated by Wikimedia, so **no derivative work is
created** and CC BY-SA's ShareAlike obligation is not triggered.

### Exactly supported licences

Mapped through a closed table onto a `LicenceId`. Anything unrecognised is **refused**, not stored as
`unknown`.

| Accepted | |
| --- | --- |
| `CC0-1.0` | also `CC0`, `CC Zero`, `Creative Commons Zero` |
| `public-domain` | also `PD`, `PD-old`, `PD-US`, `No restrictions` |
| `CC-BY-2.0` · `CC-BY-2.5` · `CC-BY-3.0` · `CC-BY-4.0` | plus the `Attribution … Generic/Unported/International` long forms |
| `CC-BY-SA-2.0` · `CC-BY-SA-2.5` · `CC-BY-SA-3.0` · `CC-BY-SA-4.0` | plus the `Attribution-ShareAlike …` long forms |

Two refusals are deliberate and are the point of the table:

- **Unversioned names are refused.** There is no `"cc by sa"` key, because such a name does not say which
  licence a reuser must comply with.
- **Ported licences are refused.** `CC BY-SA 3.0 DE`, `CC BY-SA 2.5 ES` normalize to keys that are not in the
  table. A port is a separate licence document, and labelling one as the unported text would be a false
  statement about a licence — in a record built to make licence statements checkable.

Nothing is ever folded onto a neighbouring version.

### The other media gates

| Gate | Rule |
| --- | --- |
| Trust | A rank-1 (`name-and-proximity`) match gets **no photograph** — checked *before* the request |
| MIME | Closed allow-list: `image/jpeg`, `image/png`, `image/webp` |
| **SVG** | **Refused**, even though Commons offers a PNG thumbnail — an SVG is a document that can carry script and external references |
| Scriptable MIME | Refused by the same allow-list — HTML or a script type in an image field means the record is wrong |
| GIF | Refused — a narrowing, not a safety claim: almost always an animation |
| Thumbnail host | Exact host match on `upload.wikimedia.org` (a suffix test would accept `upload.wikimedia.org.evil.example`) |
| Thumbnail URL | `https:` and bounded, via `urlIsSafe` |
| Licence URL | Refused unless `https:` and bounded |
| Source page | Must be a Commons file page — refused, never reconstructed from the title |
| Dimensions | Present, positive, and ≤ 4096 px |
| Credit | A licence requiring attribution with no author or source is **refused**, never given a substitute string |
| Attribution length | > 320 characters means the field holds markup, not a credit — refused |
| Generic images | Titles naming a flag, coat of arms, map, plan, logo or QR code are refused |
| Subject agreement | The file title must share a significant word with the place name or entity label |

### Attribution matches what is visible

The credit describes the photograph **that is actually on screen**. If the image fails to load, the component
drops the Commons-specific attribution with it — the source line stops naming Wikimedia Commons and the
disclosure stops printing a licence. Crediting a photograph nobody can see would state a licence about the
wrong thing.

Wikidata attribution for the **still-rendered facts** remains, because those facts are still displayed.

A failed image costs the traveller the photograph and nothing else: `onError` sets one boolean. No request, no
store write, no map update, no revision change.

---

## 6. Execution — budgets, continuation and saving

### Serial, by etiquette

One place at a time. `await` in a `for` loop, no `Promise.all` anywhere, `maxConcurrent: 1`. Wikimedia
publishes **no numeric read rate limit**, and etiquette asks for serial rather than parallel — a concurrency
rule, not an interval. Inventing a requests-per-second budget would be a number dressed up as a limit.

### The bounds

| Bound | Value | Where |
| --- | --- | --- |
| Places per trip | **12** | `MAX_LANDMARK_CANDIDATES_PER_TRIP` |
| HTTP calls per user action | **3** | `MAX_ENRICHMENT_CALLS` |
| Server budget per call | **90 s** | `ENRICHMENT_BUDGET_MS` |
| Route ceiling | **120 s** | `maxDuration` |
| Per-request timeout | 8 s (SPARQL 10 s) | `WIKIMEDIA_LIMITS` |
| Retries | 1, on transient 5xx only | `WIKIMEDIA_LIMITS.maxRetries` |
| Response size | 512 KB, enforced **while reading** | `maxResponseBytes` |

The 90 s budget sits below the 120 s route ceiling so the run ends *itself* and returns a partial answer.
A run that hit the platform ceiling would be killed mid-request and return nothing — discarding work already
paid for against Wikimedia.

### Bounded continuation

A response carrying `abandoned.code === "budget_exhausted"` — and **only** that code — may be continued.
`rate_limited`, `forbidden` and `wikimedia_misconfigured` stop the workflow: asking again is how a soft block
becomes a hard one.

Each continuation requests **only the places still unresolved**. A place already answered is never asked about
again, and the first answer wins. A server that reports `budget_exhausted` having answered nothing stops the
workflow rather than being asked twice more for the same thing.

Continuations send **whole places, not ids**, so a cold serverless instance produces the same answer as a warm
one. Correctness never depends on a warm server cache.

### One action, one save

`runEnrichmentWorkflow` may make up to three calls. The store is written **once**, at the end.

- an **abort** saves nothing, whatever earlier calls returned
- a **stale revision** saves nothing, and says the trip changed elsewhere
- a **storage refusal** saves nothing, and says to free room
- a **partial** result saves once, because those answers are real

**The revision increments at most once per action, and enrichment creates no undo history.** The plan is
passed through unchanged, and there is no code path by which enrichment could produce a plan.

**A refresh that is cancelled preserves the existing sidecar byte-for-byte.** An initial enrichment that is
cancelled writes nothing at all.

**Clear** removes the sidecar and only the sidecar. The itinerary is untouched.

### Reconciliation and ownership

The sidecar is reconciled against the plan on the way in as well as after an edit — a traveller can remove a
stop during a 90-second run, and storing an entry for a place the trip no longer owns would store something no
reader could reach.

| Concern | Owner |
| --- | --- |
| Canonical place identity and category | **OpenStreetMap** — never overwritten |
| Landmark facts, description, photograph | Wikidata / Commons sidecar |
| Accommodation | The planner — never enriched |
| Pool refresh and regeneration | Structural editing; the sidecar is reconciled, not rebuilt |

---

## 7. Storage, import and export

The sidecar lives beside the plan in the trip record, keyed by canonical place id:

```
record.intelligence = {
  byCanonicalPlaceId: { "<osm-canonical-id>": PlaceIntelligence },
  fetchedAt: "<ISO-8601>"
}
```

`PlaceIntelligence` holds `canonicalPlaceId`, `identities[]`, `facts[]` and `media[]`. Every fact and media
record carries a full `provenance`: provider, `retrievedAt`, licence, licence URL, attribution text, source
URL, external id, and a **policy snapshot** recording what the terms granted when it was fetched.

**Export strips; import refuses.** On the way out, anything unexportable is simply not written — a traveller
asked for their trip, and the trip is exportable even when some enrichment is not. On the way in, a file
containing something unexportable was produced by something that ignored the policy, which is a fact about the
file worth refusing over.

The policy snapshot matters because terms change: a fact stored under a permission later withdrawn is exactly
the record that becomes a breach, and the **current table always wins**.

**Old trips and old exports remain valid.** Checkpoint 5A added no field to `TripPlace` and none to the
portable wrapper; the sidecar is additive and optional.

**No raw provider payload is ever persisted or returned.** The adapter's cache holds normalized records only,
never a raw body and never a *match* — a cached entity still passes through the identity evaluation and the
merge on every read, so the cache can shorten the question and can never answer it.

---

## 8. Errors the traveller sees

Traveller-facing copy never carries a provider message, a host, a status line, a stack trace or an internal
code. `lib/trip/trip-intelligence-ui.ts` owns the wording.

A **misconfigured deployment answers 503**, not a tidy 200 with an `abandoned` code. Wikimedia answers 403 to
a request without a descriptive `User-Agent` and may block a client without notice, so this is the failure
that most needs to be loud. The message names the variable to set — `ROAMLY_CONTACT_URL` — and nothing else:
no value, no host, no header.

---

## 9. Test infrastructure

### Fixture generation and drift

`lib/providers/place-intelligence/wikimedia/fixtures.ts` holds the recorded response bodies.
`browser-bodies.test.ts` asserts the browser harness's copies have not drifted from them. Rewriting is
opt-in — a test that silently rewrote its own expectation would assert nothing.

### Browser-harness controls — test infrastructure only

Three controls exist so the browser suite can verify paths that are otherwise unreachable, behind one shared
opt-in flag. **None is product configuration**, none is documented for operators, and none can activate in a
served application.

| Control | Purpose |
| --- | --- |
| `ROAMLY_BROWSER_FIXTURE_RUN` | The harness opt-in. Set only by `test/browser/run.mjs`, immediately before it spawns `next dev`. |
| Fixture **HTTP URL** allowance | Lets a loopback fixture serve a thumbnail without a certificate, so a *displayed* Commons photograph can be exercised end to end. |
| Fixture **budget override** (`ROAMLY_ENRICHMENT_BUDGET_MS`) | The only honest way to exercise a continuation: the server must genuinely run out of time, and 90 s against a 120 s ceiling leaves no room. Clamped to ≤ 30 s, so it can only make the server *stricter*. |
| Fixture **cache-read bypass** (`ROAMLY_WIKIMEDIA_CACHE_DISABLED`) | A second lookup of the same trip is answered from memory, which makes a cancelled refresh unobservable — there is no in-flight request to cancel. Bypasses **reads only**; writes stay active. |

All four share one gate in `lib/place-intelligence/fixture-origin.ts`, which requires **every** condition at
once:

- the explicit private flag, **and** fixture mode
- `NODE_ENV === "development"` — `next build` and `next start` both report `production`, so a served
  application is excluded by the runtime itself
- **no deployment marker** present (`VERCEL`, `VERCEL_ENV`, `AWS_LAMBDA_FUNCTION_NAME`, `NETLIFY`, `CF_PAGES`,
  `RENDER`, `FLY_APP_NAME`, `HEROKU_APP_NAME`, `K_SERVICE`, …)
- a well-formed **loopback** origin with an explicit port
- **every one** of the five Wikimedia endpoints redirected onto that one origin

The browser half of the URL allowance uses the `NEXT_PUBLIC_` pair, and additionally requires the page itself
to be served from loopback, read from `window.location` — which no deployment can satisfy however its
environment is configured, and which no caller can pass in.

**The public variables alone cannot enable anything server-side.** A `NEXT_PUBLIC_` value does not exist in a
Node process's private-variable space, and `typeof window` selects which branch runs — so neither branch can
borrow the other's permission.

---

## 10. Measured performance

See `docs/BUILD_PLAN.md` for the full table. Every number is a **fixture measurement** over loopback under
`next dev` — they measure Roamly's own overhead with provider latency held near zero, and are **not**
measurements of real Wikidata or Commons latency.

Headlines:

- direct-QID, one place, cold: **104 ms**, 2 provider requests
- the same place, warm: **7 ms**, **0 provider requests**
- serial cost curve: 12 untagged places = 12 requests in **13 ms** of Roamly overhead
- sidecar: **~2.4–2.5 KB per matched landmark**
- trip record: 28,864 B → 31,389 B with one matched landmark (**+2,525 B, +8.7 %**)
- **the provider adapter is absent from every client chunk** (see §11)

---

## 11. What never reaches the browser

The Wikimedia adapter is `server-only`. Verified against the production build by searching every file in
`.next/static/` for adapter markers — `query.wikidata.org`, `Special:EntityData`, `wbgetentities`,
`wikibase:around`, `iiextmetadatafilter`, `COMMONS_LICENCES`, the `User-Agent` string, `maxlag` — all of which
return **zero client files** while returning matches in `.next/server/`.

`next/image` is deliberately **not** used for Commons photographs: it would require a `remotePatterns` entry
for `upload.wikimedia.org`, and a remote pattern is a standing permission granted to a host for the whole
application. The URL rendered has already passed a much narrower per-file gate. `next.config.ts` therefore
contains **no image host configuration at all**.

External links carry `rel="noopener noreferrer"`, and the `<img>` carries `referrerPolicy="no-referrer"` — a
trip URL is not something to hand to a third party.

---

## 12. Current limitations

1. **Rung 3 produces no visible content.** A geographic match is review-only by design, so a landmark with
   neither a `wikidata` nor a `wikipedia` OSM tag shows nothing. Coverage is therefore a property of
   OpenStreetMap tagging, not of Roamly.
2. **No manual confirmation UI.** A rank-1 identity is recorded and can be upgraded to `manual` by design, but
   nothing in the interface offers that action yet.
3. **`Dates from` is not "built in".** See §4.
4. **One heritage designation is recognised** (UNESCO World Heritage Site). Others are dropped rather than
   rendered as a bare QID.
5. **Nearby-search candidates carry no aliases** — the fixed SPARQL query does not select them, so
   "Jerónimos Monastery" would not match an entity labelled only "Mosteiro dos Jerónimos" on that rung. The
   conservative direction: an unmatched place costs a missing photograph, a wrongly matched one shows the
   wrong building.
6. **Hotlinking is the discouraged path.** Commons says hotlinking is "possible, but not recommended". It is
   not prohibited, and the alternative — local copies — is gated behind `mayCopyMediaBytes` and unbuilt.
7. **The adapter cache is per-process and dies with the serverless instance.** A cold start begins empty.
   Nothing depends on it for correctness.
8. **No batching on the entity path.** `wbgetentities` accepts 50 ids, but the orchestrator reports per-place
   outcomes and a batch would have to be reassembled against those places by title — the matching problem this
   design exists to avoid.
