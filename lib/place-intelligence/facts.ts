import type { FactProvenance } from "./provenance";
import type { FactConfidence, FactVolatility, IsoTimestamp } from "./types";

/**
 * The external facts Roamly names, and which of them it is currently allowed to hold.
 *
 * ## A closed vocabulary, including the refusals
 *
 * Every fact kind a researched provider offers appears here, including the ones Checkpoint 5A forbids. A fact kind
 * absent from the enum cannot be refused by name, only forgotten — and "we never thought about ratings" is a much
 * weaker position than "ratings are refused, here is the citation". It also makes the refusal a compiler concern: an
 * adapter wanting to emit a rating must change these tables, which is a visible decision with a licence question
 * attached.
 *
 * ## Why volatility lives on the kind and not on the value
 *
 * A phone number and a weather forecast are both strings. What differs is when they stop being true, and that is a
 * property of the *kind* — so `freshness.ts` answers "is this stale" from the kind plus two timestamps, with no
 * per-provider special cases.
 *
 * ## Operational versus reputational
 *
 * `OPERATIONAL_FACT_KINDS` is the set where two sources disagreeing is a *problem to surface* — a traveller standing
 * outside a door needs to know the hours are contested. Two providers reporting different ratings is not that: they
 * measured different populations by different methods, and "conflict" is the wrong word for it. That distinction is
 * why `conflicts.ts` reports on operational kinds only, and why nothing here averages anything.
 */

/**
 * The longest a stored fact value may be.
 *
 * Bounded for the reason `PARSER_LIMITS.maxSourceLength` is: these strings arrive from a public API and are written to
 * `localStorage`, where an unbounded value is a quota failure that looks like a save bug. 512 comfortably holds every
 * legitimate value in the vocabulary — the longest realistic one is a raw `opening_hours` rule, which the OSM parser
 * already caps at 512.
 */
export const MAX_FACT_VALUE_LENGTH = 512;

export type PlaceFactKind =
  /* -- durable attributes; OSM already supplies several of these ----------- */
  | "phone"
  | "website"
  | "opening-hours"
  | "address"
  | "category"
  | "business-status"
  | "wheelchair-access"
  | "outdoor-seating"
  | "cuisine"
  | "dietary-option"
  | "reservable"
  /* -- structured landmark facts; Wikidata's territory --------------------- */
  | "wikidata-id"
  | "inception-year"
  | "heritage-status"
  /**
   * A source's own one-line factual description of the place.
   *
   * ## Why this is not `editorial-summary`
   *
   * They look like the same field and are opposites. `editorial-summary` is Google Atmosphere-tier *written* content —
   * uncacheable, unpersistable, and refused by name. This is Wikidata's `description`: a structural disambiguator that
   * exists so an editor can tell `Q243` from every other thing called "Eiffel Tower", and which reads
   * "tower in Paris, France". CC0, factual, and short by construction.
   *
   * Adding a kind rather than reusing one was the choice with the fewest bad consequences. Reusing
   * `editorial-summary` would have meant a refused kind arriving through the merge, which is the one thing
   * `factKindIsRefused` exists to prevent — so the refusal would have had to be weakened for every provider at once,
   * including Google.
   *
   * ## What may be in it, and what may not
   *
   * A source's own short description, verbatim. No rewriting, no model output, no assembled prose, and nothing that
   * reads as a recommendation — the adapter that produces one checks its text against a prohibited-phrase list, and
   * the value stays in the source's language.
   *
   * The canonical *name* remains OpenStreetMap's. This is what a place is, never what it is called.
   */
  | "official-description"
  /* -- perishable ---------------------------------------------------------- */
  | "weather-forecast"
  | "live-busyness"
  /* -- scheduled ----------------------------------------------------------- */
  | "temporary-closure"
  | "event"
  /* -- named so they can be refused, not so they can be used --------------- */
  | "rating"
  | "review-count"
  | "review-excerpt"
  | "price-level"
  | "popularity"
  | "forecast-crowding"
  | "editorial-summary"
  | "live-price";

export const FACT_VOLATILITY: Record<PlaceFactKind, FactVolatility> = {
  phone: "durable",
  website: "durable",
  "opening-hours": "durable",
  address: "durable",
  category: "durable",
  "business-status": "durable",
  "wheelchair-access": "durable",
  "outdoor-seating": "durable",
  cuisine: "durable",
  "dietary-option": "durable",
  reservable: "durable",
  "wikidata-id": "durable",
  "inception-year": "durable",
  "heritage-status": "durable",
  /* What a place *is* changes on the scale of a rebuild or a change of use, not of a season. */
  "official-description": "durable",
  "weather-forecast": "perishable",
  "live-busyness": "perishable",
  "temporary-closure": "scheduled",
  event: "scheduled",
  /*
   * A rating is `durable` in the sense that matters here — a standing attribute rather than a moment — even though
   * Roamly may not hold one. Volatility answers "when would this go stale", which is separate from "may we have it at
   * all". Conflating them would make the permission table readable from the wrong column.
   */
  rating: "durable",
  "review-count": "durable",
  "review-excerpt": "durable",
  "price-level": "durable",
  popularity: "durable",
  "forecast-crowding": "perishable",
  "editorial-summary": "durable",
  "live-price": "perishable",
};

/**
 * Kinds where a disagreement between sources is an operational problem worth surfacing.
 *
 * Deliberately excludes every reputational kind. Two providers reporting different ratings or review counts are not in
 * conflict — they surveyed different people. Calling that a conflict would invite a resolution, and every resolution
 * for a rating is either a fabricated average or an arbitrary winner.
 */
export const OPERATIONAL_FACT_KINDS: ReadonlySet<PlaceFactKind> =
  new Set<PlaceFactKind>([
    "phone",
    "website",
    "opening-hours",
    "address",
    "category",
    "business-status",
    "wheelchair-access",
    "outdoor-seating",
    "cuisine",
    "dietary-option",
    "reservable",
    "temporary-closure",
    "wikidata-id",
    "inception-year",
    "heritage-status",
  ]);

/*
 * `official-description` is deliberately **not** in that set.
 *
 * Two sources wording a description differently is not an operational problem. "tower in Paris, France" and "iron
 * lattice tower on the Champ de Mars" are both true, and a traveller shown "sources disagree, check before relying on
 * it" would be warned about nothing — where the same banner over contested opening hours is exactly what somebody
 * standing at a door needs.
 *
 * Opening hours, business status, phone, address and website stay operational for that reason: each is a fact a
 * traveller acts on, and being wrong about one wastes a journey.
 */

export function factKindIsOperational(kind: PlaceFactKind): boolean {
  return OPERATIONAL_FACT_KINDS.has(kind);
}

/**
 * Kinds where two sources reporting the same value is *evidence*, and the one kind where it is not.
 *
 * ## Why leaving a kind out of the operational set is not enough
 *
 * `merge.ts` promotes a fact to `corroborated` whenever two providers supplied its kind, and it marks a fact `disputed`
 * from `detectConflicts` — which only examines operational kinds. So a kind that is merely non-operational gets the
 * *promotion* without the *contest*: two sources describing a place differently would come out marked as corroborating
 * each other, which is an assertion neither source made and more confidence than a single description would carry.
 *
 * This predicate closes that gap. A description stays `reported` however many sources supply one, so the honest floor
 * applies: each provider said so, and Roamly is repeating it.
 *
 * ## Why not corroboratable, specifically
 *
 * Corroboration means two sources independently measured the same thing and agreed. Two prose descriptions matching
 * usually means one copied the other — Wikidata's descriptions are widely mirrored — so identical text is weaker
 * evidence than it looks, and differing text is not disagreement at all. Neither case supports a confidence upgrade.
 *
 * Kept as an exclusion list rather than an inclusion one, so a new fact kind is corroboratable by default and only an
 * explicit decision removes it. The alternative would make an omission silently suppress corroboration for a kind where
 * agreement is real evidence.
 */
const NOT_CORROBORATABLE: ReadonlySet<PlaceFactKind> = new Set<PlaceFactKind>([
  "official-description",
]);

export function factKindIsCorroboratable(kind: PlaceFactKind): boolean {
  return !NOT_CORROBORATABLE.has(kind);
}

/**
 * One external fact about one place.
 *
 * The value is a string, a number or a boolean and nothing structured. Not a limitation to work around: a fact whose
 * value needs a shape of its own is a different fact kind, and letting arbitrary objects through is how a provider's
 * raw response ends up inside a "normalised" record. Media is the deliberate exception, and it has its own module
 * because its obligations differ.
 */
export type PlaceFact = {
  /**
   * Stable identity, so two folds of the same provider response deduplicate.
   *
   * Derived by `factId` rather than random, which is what makes deduplication *deterministic*: re-fetching the same
   * fact produces the same id and replaces nothing, where a `nanoid` would accumulate a new copy on every refresh and
   * grow the sidecar without bound.
   */
  id: string;
  kind: PlaceFactKind;
  value: string | number | boolean;
  /**
   * The moment a perishable or scheduled fact describes, when that differs from the fetch.
   *
   * A forecast fetched on Monday for Thursday is fresh and describes Thursday. Without this field the two collapse and
   * Thursday's forecast reads as Monday's weather.
   */
  subjectAt?: IsoTimestamp;
  /** The hard end of a scheduled fact. After this it is history, not a fact about the trip. */
  validUntil?: IsoTimestamp;
  confidence: FactConfidence;
  provenance: FactProvenance;
};

/**
 * The deterministic id for a fact.
 *
 * `provider:kind[:subjectAt]`. Deliberately *not* including the value: a phone number that changed is the same fact
 * with a new value, so keying on the value would make a correction look like an addition and leave both in the
 * sidecar. The subject moment *is* included, because two forecasts for two hours are genuinely two facts.
 */
export function factId(input: {
  provider: FactProvenance["provider"];
  kind: PlaceFactKind;
  subjectAt?: IsoTimestamp;
}): string {
  return input.subjectAt
    ? `${input.provider}:${input.kind}:${input.subjectAt}`
    : `${input.provider}:${input.kind}`;
}

/** Facts Checkpoint 5A does not permit at all, with the reason each is refused. */
export const REFUSED_FACT_REASONS: Partial<Record<PlaceFactKind, string>> = {
  rating:
    "No accepted provider may supply one: Google forbids caching it, Yelp forbids blending it with another source, and OSM has none.",
  "review-count": "As `rating` — no accepted provider may supply one.",
  "review-excerpt":
    "Yelp requires a read-more link back and forbids blending; Google forbids caching. Neither is compatible with a persisted trip record.",
  "price-level":
    "Available only from providers whose terms forbid persisting it. Roamly's own cost bands already answer the planning question honestly.",
  popularity:
    "A ranking signal with no licence-clean source, and every phrasing of it is on the prohibited-claims list.",
  "forecast-crowding":
    "BestTime rejected on cost, and its relative-to-own-peak figure cannot support the sentence a traveller would read.",
  "editorial-summary":
    "Google Atmosphere tier only, and uncacheable. A summary nobody may store cannot appear in a saved trip.",
  "live-price":
    "No researched provider offers one under terms Roamly can meet, and a stale price is worse than no price.",
};

/** True when the fact kind is one this checkpoint refuses outright, whatever the provider. */
export function factKindIsRefused(kind: PlaceFactKind): boolean {
  return kind in REFUSED_FACT_REASONS;
}
