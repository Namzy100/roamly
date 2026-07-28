# Provider research — place intelligence

**Status:** research gate for Checkpoint 5A. Nothing here is implemented.
**Researched:** 2026-07-28, against official provider documentation only.
**Scope:** which external facts Roamly may fetch, normalize, cache, persist, display, combine and export.

## How to read this document

Three rules govern every entry.

1. **Permission is never inferred from capability.** That an API returns a rating does not mean Roamly
   may store one. Each row below answers a *licensing* question, and the answer comes from the
   provider's own terms or not at all.
2. **Unclear means unresolved, not permitted.** Where the official documentation I could retrieve does
   not answer a question, the cell reads `unresolved` and the conclusion treats it as a blocker. A
   provider is not credited with a permission it has not granted in writing.
3. **Terms change.** Every claim carries the URL it came from and the date it was read. Anything older
   than a release cycle is stale and must be re-read before it is relied on.

### Roamly's constraint that decides most of this

Roamly persists a trip — including a full copy of every attached place record — to `localStorage`,
indefinitely, and exports it as a portable JSON file the traveller owns. The place pool *is* the
evidence the itinerary is validated against (`assertItineraryUsesPool`), so a place fact that may not
be persisted cannot enter the pool at all. This is not a preference; removing it would mean rebuilding
the storage and validation model.

That single constraint is what separates the candidates below.

---

## 1. Google Places API (New)

- Fields and SKU tiers: <https://developers.google.com/maps/documentation/places/web-service/place-details> (read 2026-07-28)
- Policies: <https://developers.google.com/maps/documentation/places/web-service/policies> (read 2026-07-28)
- Terms of Service: <https://cloud.google.com/maps-platform/terms> and <https://cloud.google.com/maps-platform/terms/maps-service-terms> — **both pages exceeded the fetch limit and could not be read in full.** Section numbers for the caching and non-Google-map clauses are therefore *not cited here*; the Places API policies page above is the citation used instead.

### Product data

Field masks are **required** — omitting one returns an error, so every request states exactly what it
wants. Fields are billed by SKU tier:

| Tier | Fields relevant to Roamly |
| --- | --- |
| Essentials (IDs only) | `id`, `name`, `photos`, `attributions` |
| Essentials | `formattedAddress`, `location`, `addressComponents`, `types`, `viewport` |
| Pro | `displayName`, `primaryType`, `businessStatus`, `googleMapsUri`, `timeZone`, `accessibilityOptions` |
| Enterprise | `nationalPhoneNumber`, `websiteUri`, `priceLevel`, `priceRange`, `rating`, `userRatingCount`, `regularOpeningHours`, `currentOpeningHours` |
| Enterprise + Atmosphere | `reviews`, `reviewSummary`, `editorialSummary`, `servesVegetarianFood` and the other `serves*` flags, `reservable`, `outdoorSeating`, `parkingOptions` |

Every fact Roamly currently lacks — ratings, review counts, opening hours from a commercial source,
dietary flags — sits in the two most expensive tiers.

### Legal and licensing

| Question | Answer | Source |
| --- | --- | --- |
| Raw responses persisted | **No** | Places API policies |
| Normalized facts persisted | **No** — "You must not pre-fetch, cache, or store Places API content" | Places API policies |
| IDs persisted | **Yes**, place IDs may be stored indefinitely | Places API policies |
| Ratings / review counts cached | **No** | Places API policies |
| Review excerpts cached | **No**; must credit authors and link to the source on Google Maps | Places API policies |
| Photos cached / proxied / transformed | **No** | Places API policies |
| Combined with OSM | unresolved — not addressed in the policies page | — |
| Displayed on a non-Google map | Attribution obligations continue to apply, and results are required to display "on a Google Map"; **displaying Places content on a competitor map is not permitted** | Places API policies |
| Beside competitor data | Prohibited in the same view | Places API policies |
| Attribution | Google Maps logo or text, minimum 16dp height, 10dp clear space, Roboto 12–16sp, 4.5:1 contrast; third-party sources named alongside ("Map data: Google, Maxar Technologies") | Places API policies |
| Commercial use | Permitted with billing | — |

### Verdict

**Rejected for Roamly.** Two independent blockers, either of which is fatal:

- The no-caching rule forbids exactly what Roamly's architecture does — persist normalized place facts
  in the trip record, indefinitely, and export them. Only place IDs survive that rule, and a place ID
  alone adds nothing Roamly does not already have from OSM.
- Roamly renders on OpenFreeMap. Displaying Places content on a non-Google map is not permitted, so the
  map would have to be replaced to use the data at all.

Cost is a distant third concern and does not need to be reached.

---

## 2. Yelp Fusion API

- Display requirements: <https://terms.yelp.com/developers/display_requirements/> (read 2026-07-28)

### Legal and licensing

| Question | Answer |
| --- | --- |
| Storage of any Yelp data | **Maximum 24 hours** |
| Ratings blended with other sources | **Prohibited** — Yelp ratings may not be blended with ratings from elsewhere; Yelp content must stand alone |
| Attribution | Yelp logo prominently visible on all Yelp-originated content, linking to yelp.com or the business's Yelp page |
| Ratings display | Aggregate stars must appear with the review count they are based on, and link to the corresponding Yelp page |
| Review excerpts | Must carry a "read more" link to the full review, or a "Read Reviews" link to the business page; no numeric limit stated |
| Voice surfaces | Must audibly credit Yelp |
| Semantic analysis | Requires prior written approval (api@yelp.com) |

### Verdict

**Rejected for Roamly.** The 24-hour storage cap is categorically incompatible with a trip record that
persists indefinitely and exports to a file. The no-blending rule independently forbids the thing this
checkpoint exists to enable — combining an external fact with Roamly's OSM-derived place.

---

## 3. Foursquare Places API

- API overview: <https://docs.foursquare.com/fsq-developers-places/reference/places-api-overview> (read 2026-07-28)
- Product page: <https://foursquare.com/products/places-api/> (read 2026-07-28)
- Pricing: <https://foursquare.com/pricing/> (read 2026-07-28)
- API License Agreement: <https://foursquare.com/legal/terms/apilicenseagreement/> (read 2026-07-28)
- Visual Crediting Policy: referenced by the licence agreement; the URLs tried (`/legal/api/attribution`, `/fsq-developers-places/docs/visual-crediting-policy`, `/legal/api/platformpolicy`) all returned 404, so **placement specifics are unresolved**.

### Product data

Endpoints: Place Search, Place Details, Place Match, Place Resolve, Autocomplete, Place Tips, Place
Photos, plus Placemaker and batch/offline jobs. Tips and Photos are **Premium** endpoints, priced
separately from the Pro endpoints.

`Place Match` and `Place Resolve` are the architecturally significant ones: they exist to reconcile a
place you already have against Foursquare's identity, which is exactly the shape Roamly needs — OSM
stays canonical and Foursquare enriches.

### Authentication and operation

| Question | Answer |
| --- | --- |
| Authentication | API key, server-side (exact scheme not stated on the overview page; **unresolved** whether any client-side flow is offered) |
| Free allowance | Up to **10,000 free calls on Pro endpoints** in sandbox, **no credit card required** |
| Pro pricing | 0–500 calls free; 501–100,000 at "$15.00 CPM"; 100,001–500,000 at "$12.00 CPM"; 500,001+ at "$9.00 CPM" |
| Premium pricing (Tips, Photos) | 0–100,000 at "$18.75 CPM"; then $15.00; then $11.25 |
| **CPM denominator** | **Unresolved.** The pricing page states "CPM" without expanding it. Per thousand and per million differ by 1000×. Recorded as published; not relied on. It does not affect this checkpoint's decision — the 10,000 free Pro calls cover the prototype either way — but it must be resolved before any paid usage. |
| Billing account | Required for production beyond the sandbox allowance |

### Legal and licensing

| Question | Answer |
| --- | --- |
| Caching permitted | **Yes**, subject to "caching and query rate limitations applicable to your Account-type" |
| Caching duration | **Unresolved.** The licence agreement defers to Usage Guidelines that could not be retrieved. This is the single most important open question and must be answered before any implementation. |
| IDs persisted | unresolved — not explicitly addressed |
| Normalized facts persisted | unresolved — permitted in principle by the caching allowance, duration unknown |
| Raw responses stored | No explicit prohibition found; **treat as unresolved** |
| Attribution | **Branded attribution required — "Powered by Foursquare" — on any page or screen within the service where Places Data may appear.** May be a button, a logo, or contextual credit woven into copy |
| Third-party / competitor map display | Not prohibited for display; what *is* prohibited is making Places Data available to third parties in bulk, letting third parties systematically query it, and exposing "material portions" that could be marketed independently |
| Beside competitor data | Not prohibited |
| Anti-crawl obligation | **Yes** — commercially reasonable efforts to prevent pages displaying Places Data from being crawled |
| User deletion | Users must be able to request deletion of all data concerning them, via a simple accessible mechanism |
| Non-public attributes | Attributes not publicly visible in the Foursquare City Guide app are internal-use only and must not be displayed |
| Commercial use | Limited to "Your Service"; reselling and prospecting are prohibited |
| Security | Industry-standard protection including encryption of stored data |

### Verdict

**Recommended, conditionally.** It is the only candidate whose terms permit caching at all, it does not
require being the canonical identity (`Place Match` is built for the opposite), it does not require its
own map, it does not forbid combining with OSM, and 10,000 free Pro calls with no credit card is a
genuine prototype allowance.

Three conditions before a line of provider code is written:

1. **Resolve the caching duration.** If it turns out to be short — 24 hours, say — Foursquare joins Yelp
   in the rejected column and this decision reverses.
2. **Resolve the CPM denominator** and the authentication scheme from the developer console.
3. **Retrieve the Visual Crediting Policy** so attribution placement is designed from the rule rather
   than guessed.

Two obligations Roamly does not currently satisfy and would have to build:

- The **anti-crawl** obligation conflicts with a public trip page being indexable. Any page showing
  Foursquare-derived facts needs `noindex`, which is a product decision, not a technical detail.
- The **user-deletion** obligation is partly satisfied — trips live in the traveller's own
  `localStorage` and deleting the trip deletes the data — but an *exported* file is outside that, and the
  export currently embeds the whole place record.

---

## 4. Wikimedia Commons (photos of public landmarks)

- Reuse guide: <https://commons.wikimedia.org/wiki/Commons:Reusing_content_outside_Wikimedia> (read 2026-07-28)

| Question | Answer |
| --- | --- |
| Licence | **Per file, not per API.** Ranges from CC0 and public domain to CC BY-SA |
| Attribution | Required by most licences — credit the *creator*, not the uploader; not legally required for CC0 or public domain, but recommended |
| Licence link | Required for CC BY-SA: link to or provide a copy of the licence |
| Cached / copied to own server | **Permitted.** Downloading to your own server is explicitly supported; hotlinking is possible but not recommended |
| Transformed | Permitted; ShareAlike derivatives must carry the same licence |
| Warranty | **None.** The Foundation warrants nothing about copyright status or licence correctness |
| Non-copyright restrictions | Trademark, personality and privacy rights may still apply independently of the licence |

### Verdict

**Accepted for public landmarks only.** The per-file licence variation is the whole design problem: a
photo cannot be displayed until its own licence, author and licence URL have been fetched and stored
alongside it, and a file whose licence cannot be determined must not be shown. That makes media
provenance a required field, not an optional one — which is why `media.ts` and `provenance.ts` exist as
separate modules in the architecture below.

Restaurants and cafés are out of scope here: Commons coverage of them is thin, and a photo of the wrong
café is worse than no photo.

---

## 5. Wikidata (landmark identity and structured facts)

- Licensing: <https://www.wikidata.org/wiki/Wikidata:Licensing> (read 2026-07-28)

| Question | Answer |
| --- | --- |
| Licence | **CC0** for structured data in the main, property and lexeme namespaces |
| Attribution | **Not legally required** (provenance still recommended) |
| Cached / stored indefinitely | Permitted |
| Modified / redistributed | Permitted, unrestricted |
| SPARQL and API results | Same CC0 terms |
| Other namespaces | Article-style text is CC BY-SA 4.0, not CC0 |

### Verdict

**Accepted.** The only source in this document with no licensing friction whatsoever. OSM places
frequently carry a `wikidata` tag, which gives a free, licence-clean join key to structured facts about
landmarks — and CC0 means the result can be persisted and exported without qualification.

---

## 6. Open-Meteo (weather)

- Terms: <https://open-meteo.com/en/terms> (read 2026-07-28)

| Question | Answer |
| --- | --- |
| Licence | **CC BY 4.0** — attribution required |
| Attribution format | Not specified in the terms; **unresolved** |
| Free allowance | <10,000 calls/day, 5,000/hour, 600/minute |
| Commercial use on free tier | **Not permitted** — free API is non-commercial only |
| Authentication | None required for the free tier |
| Caching / storage | **Not addressed — unresolved** |

### Verdict

**Accepted for the non-commercial prototype, with one flag.** No key, a generous allowance and a clean
CC BY licence. But "non-commercial only" is a live constraint: the moment Roamly is anything other than
a student project, this becomes a paid dependency. And weather is the one fact here that is *inherently*
perishable — a forecast persisted into an exported trip file and read six months later is actively
misleading, which is a freshness problem the architecture has to solve rather than a licensing one.

---

## 7. BestTime.app (crowding)

- Pricing: <https://besttime.app/subscription/pricing> and <https://besttime.app/> (read 2026-07-28)
- Reference: <https://documentation.besttime.app/> (read 2026-07-28)

| Question | Answer |
| --- | --- |
| Data | Forecast busyness per hour and per weekday, normalized 0–100% against the venue's own peak; live busyness; 150+ countries |
| Free tier | Free **test** account, no credit card, for exploration only |
| Pricing | Usage-based from **$0.06 per API credit with a $29/month minimum**; fixed plans cap unique venues per month |
| Caching / storage restrictions | **Unresolved** — not found in the pages retrieved |

### Verdict

**Rejected for this phase, on cost and on honesty.** A $29/month floor fails the student-project
constraint outright. Separately, the data is a *relative* percentage against a venue's own peak, which
is far weaker than the phrasing "less crowded" would imply to a traveller — and "less crowded" is
already on Roamly's prohibited-claims list precisely because it cannot be evidenced. Buying a number
that still cannot support the sentence is the wrong trade.

---

## 8. Ticketmaster Discovery API (events — architectural comparison only)

- Docs: <https://developer.ticketmaster.com/products-and-docs/apis/discovery-api/v2/> (read 2026-07-28)

| Question | Answer |
| --- | --- |
| Data | Events, attractions (artists, teams, performers), venues with address, coordinates, timezone |
| Authentication | `apikey` query parameter |
| Quota | 5,000 calls/day, 5 requests/second |
| Pagination | Deep paging capped — `size × page < 1000` |
| Attribution | **Not stated in the API docs — unresolved** |
| Caching / storage | **Not stated in the API docs — unresolved** |

### Verdict

**Not selected; retained for architectural comparison only,** as instructed. The lesson it carries is
about *shape* rather than about events: an event is a fact with a hard expiry and a venue reference,
which is a third kind of external fact alongside a durable place attribute and a perishable forecast.
The freshness model below is designed to hold all three, so adding events later is a new fact kind
rather than a new architecture.

Note the API-key-in-query-string design: it cannot be exposed to a browser, which reinforces the
server-only provider boundary Roamly already enforces.

---

## Comparison matrix

`—` means not applicable. `?` means unresolved in the official documentation retrieved.

| | Google Places | Yelp Fusion | Foursquare | Commons | Wikidata | Open-Meteo | BestTime | Ticketmaster |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Suitable for identity | Yes (not needed) | No | **Yes, as a match not a canon** | No | Yes, for landmarks | — | No | No |
| Suitable for restaurants | Yes | Yes | **Yes** | Weak | No | — | Yes | No |
| Suitable for attractions | Yes | Weak | Yes | **Yes** | **Yes** | — | Yes | Events only |
| Ratings | Enterprise SKU | Yes | Yes | — | — | — | — | — |
| Review count | Enterprise SKU | Yes | Yes | — | — | — | — | — |
| Photos | Yes, uncacheable | Yes | Premium endpoint | **Yes, cacheable** | — | — | — | Yes |
| Hours | Enterprise SKU | Yes | Yes | — | Sometimes | — | — | — |
| Popularity | Atmosphere SKU | Yes | Yes | — | — | — | — | — |
| Crowding | No | No | No | — | — | — | **Yes (relative)** | — |
| Weather | — | — | — | — | — | **Yes** | — | — |
| Events | — | — | — | — | — | — | — | **Yes** |
| Free prototype fit | Poor | Poor | **Good** (10k, no card) | **Excellent** | **Excellent** | **Good** | Poor ($29/mo) | Good (5k/day) |
| Public beta fit | Paid, terms hostile | Blocked by 24h cap | **Good, cost unresolved** | **Excellent** | **Excellent** | **Blocked — non-commercial only** | Paid | ? |
| Caching flexibility | **None** (IDs only) | **24 hours** | Permitted, duration ? | **Full** | **Full** | ? | ? | ? |
| Map-display compatibility | **Fails** — non-Google map not permitted | Standalone display rules | **Compatible** | **Compatible** | **Compatible** | — | ? | ? |
| Attribution burden | High, pixel-specified | High, logo + links | Medium, "Powered by Foursquare" | **High per file**, but mechanical | **None required** | Low | ? | ? |
| Implementation complexity | Medium | Medium | Medium | **High** (per-file licence) | Low | **Low** | Low | Medium |
| **Recommendation** | **Reject** | **Reject** | **Adopt, conditionally** | **Adopt, landmarks only** | **Adopt** | **Adopt, prototype only** | **Reject** | **Defer** |

---

## Provider selection against Roamly's stated requirements

Scored against the explicit requirements only. No weighted total — a weighted score would let a strong
cost position offset a fatal licensing one, and two of the candidates fail on exactly that pattern.

| Requirement | Google | Yelp | Foursquare | Evidence |
| --- | --- | --- | --- | --- |
| Server-side key | Pass | Pass | Pass | All three are key-authenticated server-side |
| Useful development allowance | Fail | Partial | **Pass** | 10,000 free Pro calls, no credit card |
| Real-place matching | Pass | Partial | **Pass** | `Place Match` / `Place Resolve` exist for exactly this |
| Useful restaurant and attraction data | Pass | Partial | **Pass** | Search, Details, Tips, Photos |
| Ratings or review counts | Pass (paid tier) | Pass | **Pass** | — |
| Photos | Pass (uncacheable) | Pass | **Partial** | Premium endpoint, priced separately |
| Opening hours | Pass (Enterprise) | Pass | **Pass** | — |
| Legal compatibility with OSM identity | Unresolved | **Fail** | **Pass** | Yelp forbids blending ratings with other sources; Foursquare's matching endpoints presuppose an external identity |
| Legal compatibility with OpenFreeMap display | **Fail** | Partial | **Pass** | Google requires display on a Google Map |
| Reasonable caching | **Fail** | **Fail** | **Unresolved** | Google: IDs only. Yelp: 24h. Foursquare: permitted, duration not retrieved |
| Clear attribution | Pass | Pass | **Partial** | Text known ("Powered by Foursquare"); placement policy 404'd |
| Provider need not be canonical identity | Pass | Pass | **Pass** | — |
| No requirement to expose raw responses | Pass | Pass | **Pass** | None requires it; all three forbid bulk redistribution |
| Manageable student-project cost | Fail | Partial | **Pass** | Free sandbox sufficient for the prototype |
| Optional configuration | Pass | Pass | **Pass** | All can be absent |
| Graceful keyless fallback | Pass | Pass | **Pass** | Roamly's existing pattern: absent key means absent capability |

### Decision

- **First place-enrichment provider: Foursquare Places** — conditional on resolving the caching
  duration, the CPM denominator, and the Visual Crediting Policy.
- **Public landmarks: Wikimedia Commons + Wikidata** — adopted. Wikidata is licence-clean; Commons is
  adopted for media with per-file provenance mandatory.
- **Weather: Open-Meteo** — adopted for the non-commercial prototype, with the commercial-use limit
  recorded as a release blocker.
- **Crowding: none.** Rejected on cost and on the gap between what the data supports and what the
  wording would imply.
- **Events: none.** Ticketmaster retained as a shape to design against, not a dependency.

### Rejected alternatives, and why

| Rejected | Decisive reason |
| --- | --- |
| Google Places | No-caching rule forbids persisting normalized facts; Places content not permitted on a non-Google map |
| Yelp Fusion | 24-hour storage cap; ratings may not be blended with other sources |
| BestTime | $29/month floor; relative-to-own-peak data cannot support the claim a traveller would read |
| Ticketmaster | Not needed this phase; attribution and caching terms unresolved in the API docs |

### Conditions that would change the decision

1. **Foursquare's caching window turns out to be ≤7 days.** Roamly would then treat every provider fact
   as session-scoped display data that never enters the pool and never exports — a materially different
   architecture, and one where the enrichment is worth much less.
2. **Roamly stops being non-commercial.** Open-Meteo becomes paid; Foursquare's per-call cost starts to
   matter and the CPM denominator becomes urgent.
3. **Google relaxes the caching rule, or Roamly adopts Google Maps for rendering.** Both are currently
   false; either would reopen Google as a candidate on data quality.
4. **A public, indexable trip page becomes a product goal.** Foursquare's anti-crawl obligation would
   have to be reconciled first.
5. **OSM's own coverage improves for the fields in question.** The cheapest outcome remains needing no
   commercial provider at all.

---

## What this permits, concretely

Until the Foursquare conditions are resolved, the answer to "which external facts may Roamly fetch,
normalize, cache, persist, display, combine and export" is:

| Fact | Fetch | Persist in pool | Export | Display |
| --- | --- | --- | --- | --- |
| OSM place identity and tags | Yes | **Yes** (today) | **Yes** (today) | Yes, attributed |
| Wikidata structured facts | Yes | **Yes** | **Yes** | Yes, attribution optional |
| Commons media | Yes | **Yes, with per-file licence, author and licence URL** | Yes, with that provenance | Only when provenance is complete |
| Open-Meteo forecast | Yes | **No** — perishable, and non-commercial-only | **No** | Yes, timestamped, non-commercial build only |
| Foursquare facts | **Not yet** | **Not yet** | **Not yet** | **Not yet** |
| Ratings, review counts, review excerpts | **No** | No | No | No |
| Crowding, popularity, live busyness | **No** | No | No | No |
| Live prices | **No** | No | No | No |

`lib/place-intelligence/` encodes this table rather than describing it, so a provider added later cannot
quietly widen it.
