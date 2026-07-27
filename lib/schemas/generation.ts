import { z } from "zod";

import { VerifiedPlacePoolSchema } from "./pool";
import { PlaceCategorySchema, TripPlaceSchema } from "./place";
import { AppliedRoutingPolicySchema } from "./routing-state";

/**
 * How a generated trip came to exist — kept deliberately outside `TripPlan`.
 *
 * ## Why not on the plan
 *
 * A `TripPlan` is a trip. Which model produced it, which endpoint answered, how
 * many Overpass queries it took and what the search missed are facts about a
 * *generation run*, and none of them belong in the domain object. Put them on the
 * plan and every fixture grows a provider field, two plans with identical
 * itineraries compare unequal, and the routing endpoint starts receiving model
 * metadata it has no business seeing.
 *
 * So this travels beside the plan inside the stored record, at the same revision,
 * saved in the same write. See `lib/store/trip-record.ts`.
 *
 * ## Why the pool is here rather than re-derived
 *
 * This is the load-bearing part. `derivePlanPlacePool` builds a pool from the
 * places a plan already uses, which is the plan checking itself — it would happily
 * validate a fabricated place. The pool below is the **actual search result set**
 * the itinerary was assembled from, including the candidates that were *not*
 * chosen, which is what makes "the itinerary references nothing that was not
 * discovered" a claim with evidence behind it.
 *
 * It is also what routing is checked against later, so a re-route months later is
 * verified against the original search rather than against the plan's own contents.
 */

/** Bump when this record's shape changes. Stored records carrying an older version are dropped. */
export const GENERATION_CONTEXT_SCHEMA_VERSION = 1;

export const AiProviderIdSchema = z.enum(["gemini", "ollama", "deterministic"]);
export type AiProviderIdValue = z.infer<typeof AiProviderIdSchema>;

/**
 * A destination as the geocoder resolved it.
 *
 * Lives here rather than in `lib/api/` because it is domain vocabulary that both
 * the API contract and the stored record need, and defining it twice is how the two
 * would eventually disagree about coordinate bounds.
 */
export const GeocodedDestinationSchema = z.object({
  canonicalId: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  boundingBox: z
    .object({
      south: z.number(),
      west: z.number(),
      north: z.number(),
      east: z.number(),
    })
    .optional(),
  countryCode: z.string().length(2).optional(),
  source: z.object({
    provider: z.literal("openstreetmap"),
    osmType: z.enum(["node", "way", "relation"]),
    osmId: z.string().regex(/^\d+$/),
    fetchedAt: z.string().min(1),
  }),
});
export type GeocodedDestinationRecord = z.infer<typeof GeocodedDestinationSchema>;

/**
 * Something the traveller should know about how their plan was made.
 *
 * Not an error — a generation that produced warnings still produced a plan. These
 * are the places where the result is thinner or less certain than it looks:
 * a category that returned nothing, a cost the model proposed that had to be pulled
 * into its band, a slot left open. Rendering them is what stops a partial result
 * passing for a complete one.
 */
export const GenerationWarningSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  dayNumber: z.number().int().positive().optional(),
  slotId: z.string().min(1).optional(),
  placeId: z.string().min(1).optional(),
});
export type GenerationWarning = z.infer<typeof GenerationWarningSchema>;

/**
 * What the place search actually did.
 *
 * `categoriesWithNoResults` is the field that earns its keep: it is the difference
 * between "this destination has no museums mapped" and "the model chose not to
 * include a museum", and without it a sparse itinerary is unexplainable.
 */
export const DiscoverySummarySchema = z.object({
  categoriesRequested: z.array(PlaceCategorySchema),
  categoriesWithNoResults: z.array(PlaceCategorySchema),
  radiusMeters: z.number().int().positive(),
  /** How many Overpass requests were issued. Bounded, and worth being able to audit. */
  requestCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  /** Records normalisation dropped, as a count. Never the records themselves. */
  discardedCount: z.number().int().nonnegative(),
  attribution: z.string().min(1),
});
export type DiscoverySummary = z.infer<typeof DiscoverySummarySchema>;

/**
 * Bounded on purpose.
 *
 * A pool is stored in `localStorage`, which is a few megabytes for the whole
 * origin. 150 places is roughly 45 KB — comfortably more than any itinerary needs
 * for real choice, and small enough that a browser holding a dozen saved trips is
 * nowhere near the limit.
 */
export const MAX_PERSISTED_POOL_PLACES = 150;

/**
 * The ceiling on retained legacy places (Phase 6C).
 *
 * A trip has at most 7 days and 24 stops, plus an accommodation and its backups, so 48 is
 * comfortably above anything a real plan can reference — and low enough that a bug which
 * started retaining indiscriminately would fail loudly rather than quietly growing a
 * second pool inside `localStorage`.
 */
export const MAX_RETAINED_PLACES = 48;

export const TripGenerationContextSchema = z.object({
  schemaVersion: z.literal(GENERATION_CONTEXT_SCHEMA_VERSION),
  provider: AiProviderIdSchema,
  /** A model id, or the demo planner's version string. A label, never a claim. */
  model: z.string().min(1),
  generatedAt: z.string().min(1),
  destination: GeocodedDestinationSchema,
  /** The exact search result set. Validated on read, not taken on trust. */
  placePool: VerifiedPlacePoolSchema.refine(
    (pool) => pool.places.length <= MAX_PERSISTED_POOL_PLACES,
    `A stored pool holds at most ${MAX_PERSISTED_POOL_PLACES} places`,
  ),
  discoverySummary: DiscoverySummarySchema,
  warnings: z.array(GenerationWarningSchema).max(40),
  /**
   * The routing policy this trip's pace implies (ARCHITECTURE §22).
   *
   * Recorded at generation time and applied when the traveller later asks for real
   * routes, so a relaxed trip is routed under relaxed thresholds even though
   * routing happens minutes or days afterwards. The model has no say in it — it is
   * derived from `TripRequest.pace` by `lib/generate/pace-policy.ts`.
   */
  routingPolicy: AppliedRoutingPolicySchema,
  /**
   * The most recent AI refinement, if any (Phase 6A).
   *
   * ## Why only the latest
   *
   * A full history would grow without bound inside `localStorage`, and the question
   * it would answer — "what changed, and can I go back?" — is already answered better
   * by the one-level undo snapshot on the stored record. This field answers a
   * different and smaller question: *who last touched this itinerary*, so a trip
   * generated by Gemini and later refined by Ollama does not silently attribute
   * everything to the first.
   *
   * Absent for a trip that has never been refined, and absent for one refined by the
   * deterministic planner — there is no model to attribute, and recording
   * `provider: "deterministic"` here would suggest an AI refinement happened.
   * Recalculating routes is likewise not recorded: it adds provider facts, not
   * planner choices.
   *
   * Optional, so every record written before Phase 6A parses unchanged and the
   * context's `schemaVersion` stays at 1.
   */
  latestRefinement: z
    .object({
      provider: z.enum(["gemini", "ollama"]),
      model: z.string().min(1),
      /** Which action ran. A closed vocabulary, matching `TripRefinementCommand`. */
      action: z.enum([
        "regenerate-trip",
        "replace-item",
        "replace-backup",
        "adjust-day",
      ]),
      refinedAt: z.string().min(1),
    })
    .optional(),

  /**
   * The destination's timezone, resolved once at generation time (Phase 6B).
   *
   * ## Why it is stored rather than re-derived
   *
   * Opening hours can only be checked against a schedule if the destination's zone is
   * known, and the curated table that answers that question will change — a city added,
   * a country reclassified. Re-deriving on every read would mean a plan's schedule
   * verdicts could change under a traveller without the plan changing, which is exactly
   * the drift the derived-field rule exists to prevent for coverage counts.
   *
   * `source` records how we knew. A city match is specific; a country match is only
   * trustworthy because the country has one zone. Both are stated so the interface can
   * say which, and neither is ever the device's timezone.
   *
   * Absent is a real state, not a bug: a destination in a multi-timezone country with no
   * city match has no honest answer, and every schedule verdict for that trip is
   * `unknown_timezone` as a result.
   *
   * Optional, so every record written before Phase 6B parses unchanged.
   */
  destinationTimezone: z
    .object({
      /** IANA zone id, e.g. `Europe/Lisbon`. */
      timezone: z.string().min(1),
      source: z.enum(["city", "country"]),
    })
    .optional(),

  /**
   * Which cost profile the estimates were built from (Phase 6B).
   *
   * Provenance, not data: the profile itself lives in `lib/costs/profiles.ts` and is
   * looked up by id. Storing the id and version means a later change to the curated
   * numbers can be told apart from the estimates it produced, and a re-estimate can say
   * "this used to be figured against lisbon@1.0.0".
   *
   * `match` and `confidence` are recorded because they are what the interface shows. A
   * global-fallback estimate is not wrong, it is uninformed, and a traveller reading a
   * figure deserves to know which they have.
   *
   * Absent for trips generated before Phase 6B. Those estimates keep their original
   * `category-estimate` basis and are **not** backfilled — inventing provenance for a
   * figure produced by different arithmetic would be a worse answer than admitting we do
   * not know which profile it came from.
   */
  costProfile: z
    .object({
      profileId: z.string().min(1),
      version: z.string().min(1),
      match: z.enum(["city", "country", "region", "global"]),
      confidence: z.enum(["low", "medium", "high"]),
    })
    .optional(),

  /**
   * Places the itinerary still uses that the latest search no longer returns (Phase 6C).
   *
   * ## Why this exists rather than a looser pool check
   *
   * Refreshing the place pool replaces the trip's universe of allowed places, and a place
   * can disappear from it for reasons that say nothing about the place: a mapper retagged
   * it, the radius moved, the category query changed, Overpass timed out on one batch. The
   * traveller's museum is still there.
   *
   * There were two bad options and one good one. Keeping the missing place *in* the pool
   * would be asserting that the latest search found it, which is false. Silently relaxing
   * `assertItineraryUsesPool` would delete the invariant that makes every place in every
   * itinerary traceable to a real search. So the place moves **here** instead: out of the
   * pool, explicitly recorded, with the date and the reason.
   *
   * ## The widened invariant, stated exactly
   *
   * > Every *newly selected* place must belong to the active pool. An existing itinerary
   * > reference may resolve to a retained place only when that place is recorded here and
   * > is still used by the plan.
   *
   * Enforced mechanically: retained places are never in a candidate list (they are not in
   * the pool, and every candidate derivation reads the pool), a retained entry that no
   * plan item references is a hard validation failure, and a placeId appearing in both the
   * pool and here is a hard validation failure.
   *
   * Bounded to the places actually referenced, so this cannot grow into a second pool.
   * Optional, so every record written before Phase 6C parses unchanged.
   */
  retainedPlaces: z
    .array(
      z.object({
        place: TripPlaceSchema,
        retainedAt: z.string().min(1),
        reason: z.literal("missing-after-refresh"),
      }),
    )
    .max(MAX_RETAINED_PLACES)
    .optional(),
});
export type TripGenerationContext = z.infer<typeof TripGenerationContextSchema>;
