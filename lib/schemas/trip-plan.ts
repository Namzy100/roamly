import { z } from "zod";

import {
  AccommodationStyleSchema,
  CurrencySchema,
  InterestSchema,
  ItemKindSchema,
  MealTypeSchema,
  RoutedTravelModeSchema,
  TravelModeSchema,
} from "./enums";
import {
  CostEstimateSchema,
  LatLngSchema,
  LineStringGeometrySchema,
  TripPlaceSchema,
  type TripPlace,
} from "./place";
import {
  AppliedRoutingPolicySchema,
  RoutingEnrichmentSummarySchema,
} from "./routing-state";
import { TripRequestSchema } from "./trip-request";

/**
 * Bump when a stored plan's shape changes. The store discards any localStorage entry
 * whose version does not match, so an old plan can never be rendered by newer
 * components that expect fields it lacks.
 *
 * v2 (Phase 3): `TripPlace` gained a required `source`, moved to a controlled
 * `category` vocabulary, and made `address`/`rating`/`userRatingCount`/`priceLevel`
 * genuinely optional.
 *
 * v3 (Phase 4): `TravelSegment` became a discriminated union — a flat
 * `{mode, durationMinutes, distanceMeters}` record cannot say whether those
 * numbers came from a routing engine or from a guess, and a stored v2 segment
 * has no `status` to discriminate on. Plans saved under an older version are
 * dropped on read; the sample trip is one click to regenerate.
 */
export const TRIP_PLAN_SCHEMA_VERSION = 3;

/**
 * `TripPlace`, `LatLng` and the place vocabulary live in `./place` — they are shared
 * with the provider layer, which must not import the whole trip schema. Both are
 * re-exported from `./index`, so `@/lib/schemas` remains the single import surface.
 */

/* -------------------------------------------------------------------------- */
/* Travel between two consecutive stops                                        */
/* -------------------------------------------------------------------------- */

/**
 * Three genuinely different claims, so three arms.
 *
 * The previous shape was one flat record with a duration and a distance, and it
 * could not distinguish "the routing engine says 12 minutes" from "somebody
 * guessed 12 minutes" from "we could not find out". All three rendered
 * identically, which meant the UI had no way to be honest even if it wanted to
 * be. `status` is now the discriminant and each arm carries exactly the evidence
 * its claim requires:
 *
 * | `status` | The claim | Carries geometry? |
 * | --- | --- | --- |
 * | `routed` | a provider computed this path | yes, ≥2 points |
 * | `estimated` | a plausible figure, with its basis | never |
 * | `unavailable` | we do not know, and here is why | never |
 *
 * The impossible states are impossible by construction: an estimate cannot
 * acquire route geometry, an unavailable leg cannot acquire a duration, and a
 * routed leg cannot report zero of anything.
 */

const TravelSegmentEndpointsSchema = z.object({
  id: z.string().min(1),
  fromPlaceId: z.string().min(1),
  toPlaceId: z.string().min(1),
  /** Editorial colour, never a factual claim about the journey. */
  note: z.string().nullable(),
});

/**
 * A leg a routing provider actually computed.
 *
 * `positive()` throughout, not `nonnegative()`. Zero distance between two
 * distinct stops means the provider snapped both to one road segment, and zero
 * duration means nothing was computed — using either as a failure sentinel is
 * precisely what the `unavailable` arm replaces.
 *
 * `durationSeconds` is the provider's figure and `durationMinutes` is derived
 * from it deterministically. Both are stored because the UI wants minutes and
 * any future aggregation wants the unrounded value; the rounding rule lives in
 * `lib/routing/format.ts` so it is applied identically everywhere.
 */
export const RoutedTravelSegmentSchema = TravelSegmentEndpointsSchema.extend({
  status: z.literal("routed"),
  provider: z.literal("valhalla"),
  mode: RoutedTravelModeSchema,
  distanceMeters: z.number().finite().positive(),
  durationSeconds: z.number().finite().positive(),
  durationMinutes: z.number().int().positive(),
  geometry: LineStringGeometrySchema,
  /** ISO timestamp of the provider response this leg came from. */
  fetchedAt: z.string().min(1),
  attribution: z.string().min(1),
});
export type RoutedTravelSegment = z.infer<typeof RoutedTravelSegmentSchema>;

/**
 * A planning figure, with its provenance attached.
 *
 * Mirrors `CostEstimate`'s discipline for money: a number may not be shown
 * without saying where it came from and how much to trust it. `disclaimer` is
 * required rather than optional, so an estimate cannot be rendered as though it
 * were measured.
 *
 * This arm accepts the full `TravelMode` vocabulary, including `TRANSIT` —
 * "take the metro, roughly 20 minutes" is a legitimate thing for a plan to say,
 * and it is legitimate precisely because it is labelled an estimate.
 */
export const EstimatedTravelSegmentSchema = TravelSegmentEndpointsSchema.extend({
  status: z.literal("estimated"),
  provider: z.literal("mock"),
  mode: TravelModeSchema,
  estimatedDistanceMeters: z.number().finite().positive().optional(),
  estimatedDurationMinutes: z.number().int().positive(),
  /** Where the figure came from. Free text, because estimates vary in kind. */
  basis: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  disclaimer: z.string().min(1),
});
export type EstimatedTravelSegment = z.infer<typeof EstimatedTravelSegmentSchema>;

/**
 * A leg we could not route, stated as such.
 *
 * No distance, no duration, no geometry — not zeroes, not nulls-that-render-as-
 * zero, and nothing for the map to draw. The traveller is told there is a gap,
 * which is the same principle as an `unavailable` itinerary item.
 */
export const UnavailableTravelSegmentSchema = TravelSegmentEndpointsSchema.extend({
  status: z.literal("unavailable"),
  requestedMode: TravelModeSchema,
  reason: z.enum([
    "no_route",
    "provider_unavailable",
    "timeout",
    "rate_limited",
    "invalid_locations",
    "unsupported_mode",
    "invalid_response",
    "aborted",
    "unknown",
  ]),
  /** Plain language, safe to render. Never a provider name or a status code. */
  userMessage: z.string().min(1),
});
export type UnavailableTravelSegment = z.infer<
  typeof UnavailableTravelSegmentSchema
>;

export const TravelSegmentSchema = z.discriminatedUnion("status", [
  RoutedTravelSegmentSchema,
  EstimatedTravelSegmentSchema,
  UnavailableTravelSegmentSchema,
]);
export type TravelSegment = z.infer<typeof TravelSegmentSchema>;

/** True for a leg whose figures came from a routing provider. */
export function isRoutedSegment(
  segment: TravelSegment,
): segment is RoutedTravelSegment {
  return segment.status === "routed";
}

/**
 * The duration a segment may claim, in minutes, or `null` when it may not claim
 * one.
 *
 * A single accessor so no caller reaches for `durationMinutes` on a union arm
 * that does not have it and gets `undefined` rendered as a blank.
 */
export function segmentDurationMinutes(segment: TravelSegment): number | null {
  switch (segment.status) {
    case "routed":
      return segment.durationMinutes;
    case "estimated":
      return segment.estimatedDurationMinutes;
    case "unavailable":
      return null;
  }
}

const TimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour HH:MM time");

export const ItineraryItemSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().nonnegative(),
  kind: ItemKindSchema,
  mealType: MealTypeSchema.nullable(),
  title: z.string().min(1),
  /** Model-authored: why this stop, for this traveller, at this point. */
  rationale: z.string().min(1),
  /**
   * `unavailable` marks a slot the pipeline could not fill with a verified place
   * — see ARCHITECTURE §4. Such a slot still appears in the itinerary, so the
   * traveller knows there is a gap, but it is never given a map marker.
   *
   * Defaulted rather than required so plans already in localStorage keep
   * parsing; no `schemaVersion` bump is needed.
   */
  status: z.enum(["confirmed", "unavailable"]).default("confirmed"),
  /**
   * The traveller's own pin (Phase 8).
   *
   * ## Distinct from the structural lock, deliberately
   *
   * Two different things get called "locked" in this codebase, and conflating them would be a
   * real bug. `transport` and `logistics` items are fixed by the trip's *dates* — the airport
   * run cannot happen on day three — and that is a product rule a traveller may not switch
   * off. This field is the opposite: something they chose, and may unchoose. Both predicates
   * live side by side in `lib/structural-edits/locks.ts` so a later caller cannot reach for
   * the wrong one by accident, and `unlock-item` refuses on a structurally locked stop rather
   * than appearing to free it.
   *
   * ## What it prevents, and what it does not
   *
   * A locked stop cannot be moved, re-timed, resized, removed, or have its place swapped — by
   * the traveller, by a drag, or by an assistant proposal. It is *not* a claim about the
   * world: locking a museum does not assert it is open, and the hours report still says
   * whatever it says. Nor does it survive a regeneration, which replaces the whole itinerary
   * and tells the traveller so.
   *
   * Defaulted rather than required, so every plan already in `localStorage` keeps parsing and
   * `TRIP_PLAN_SCHEMA_VERSION` stays at 3 — the same reasoning `status` was added under.
   */
  locked: z.boolean().default(false),
  /**
   * Null for items with no single mappable location — downtime, a free
   * afternoon, or an unfilled slot. These are excluded from the map.
   */
  place: TripPlaceSchema.nullable(),
  startTime: TimeSchema,
  endTime: TimeSchema,
  estimatedCost: z.number().nonnegative(),
  costNote: z.string().nullable(),
  /**
   * The provenance of `estimatedCost`, for generated plans (Phase 5B).
   *
   * `estimatedCost` stays the canonical number — every total in the plan is summed
   * from it, and adding a second source of truth for money would let the budget
   * panel disagree with the cards. This carries the *claim about* that number:
   * where it came from, how much to trust it, and the disclaimer the UI must show.
   *
   * Optional rather than required, because the sample plan's hand-written figures
   * predate it and inventing a basis for them would be exactly the kind of
   * retrofitted provenance this field exists to prevent. Present on every
   * generated item; absent on the sample.
   */
  costEstimate: CostEstimateSchema.optional(),
  bookingRequired: z.boolean(),
  tip: z.string().nullable(),
  /** Travel from this stop to the next. Null on the last stop of a day. */
  travelToNext: TravelSegmentSchema.nullable(),
});
export type ItineraryItem = z.infer<typeof ItineraryItemSchema>;

/** A swap-in if something is closed, full, or simply unappealing on the day. */
export const BackupOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  kind: ItemKindSchema,
  reason: z.string().min(1),
  place: TripPlaceSchema,
  estimatedCost: z.number().nonnegative(),
});
export type BackupOption = z.infer<typeof BackupOptionSchema>;

export const ItineraryDaySchema = z.object({
  dayNumber: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  theme: z.string().min(1),
  summary: z.string().min(1),
  items: z.array(ItineraryItemSchema).min(1),
  backups: z.array(BackupOptionSchema),
  dayTotal: z.number().nonnegative(),
  totalTravelMinutes: z.number().int().nonnegative(),
});
export type ItineraryDay = z.infer<typeof ItineraryDaySchema>;

export const DestinationSummarySchema = z.object({
  city: z.string().min(1),
  country: z.string().min(1),
  overview: z.string().min(1),
  recommendedNeighborhood: z.object({
    name: z.string().min(1),
    why: z.string().min(1),
  }),
  bestFor: z.array(InterestSchema).min(1),
  languageNote: z.string().min(1),
  currencyNote: z.string().min(1),
  weatherNote: z.string().min(1),
  center: LatLngSchema,
});
export type DestinationSummary = z.infer<typeof DestinationSummarySchema>;

/**
 * Always an estimate — the MVP has no live inventory. `isEstimate` is a literal
 * `true` so the type system cannot express a "confirmed" fare, and the UI is
 * obliged to label it.
 */
export const FlightEstimateSchema = z.object({
  isEstimate: z.literal(true),
  departureCity: z.string().min(1),
  destinationCity: z.string().min(1),
  perTraveler: z.number().nonnegative(),
  total: z.number().nonnegative(),
  cabin: z.string().min(1),
  typicalDuration: z.string().min(1),
  typicalStops: z.string().min(1),
  /**
   * Deep link to an external search. Never a booking endpoint.
   *
   * `.url()` alone is not enough: Zod only checks that `new URL()` parses, and `javascript:alert(1)`
   * and `data:text/html,…` both parse. This field is rendered as a real `<a href>`, and a `TripPlan`
   * can arrive from an imported file or a misbehaving provider — so the scheme is constrained here,
   * at the schema, where every path into the app already passes.
   */
  searchUrl: z
    .string()
    .url()
    .refine((value) => /^https?:\/\//i.test(value), {
      message: "A search link must be http or https",
    }),
  basis: z.string().min(1),
});
export type FlightEstimate = z.infer<typeof FlightEstimateSchema>;

export const AccommodationRecommendationSchema = z.object({
  place: TripPlaceSchema,
  style: AccommodationStyleSchema,
  neighborhood: z.string().min(1),
  nightlyRate: z.number().nonnegative(),
  nights: z.number().int().nonnegative(),
  total: z.number().nonnegative(),
  whyItFits: z.string().min(1),
  amenities: z.array(z.string().min(1)),
  isEstimate: z.literal(true),
});
export type AccommodationRecommendation = z.infer<
  typeof AccommodationRecommendationSchema
>;

export const BudgetSummarySchema = z.object({
  currency: CurrencySchema,
  requestedBudget: z.number().nonnegative(),
  flights: z.number().nonnegative(),
  accommodation: z.number().nonnegative(),
  food: z.number().nonnegative(),
  activities: z.number().nonnegative(),
  transport: z.number().nonnegative(),
  total: z.number().nonnegative(),
  /** Negative when the plan overruns the requested budget. */
  remaining: z.number(),
  perTraveler: z.number().nonnegative(),
  byDay: z.array(
    z.object({
      dayNumber: z.number().int().positive(),
      amount: z.number().nonnegative(),
    }),
  ),
});
export type BudgetSummary = z.infer<typeof BudgetSummarySchema>;

/**
 * What a routing run left behind, or `null` before one has happened.
 *
 * The **only** part of enrichment that is persisted, because it is the only part
 * that cannot be recovered from the segments afterwards. Everything else — day
 * travel totals, coverage per day, the map's route lines — is a pure function of
 * `travelToNext` across the plan, and is derived at runtime in `lib/plan/` so a
 * stored copy cannot drift out of agreement with the segments it describes.
 *
 * Two things are irrecoverable and so live here: the **policy** that was applied
 * (a different mode policy expects a different number of legs, so "3 of 8" is
 * meaningless without it) and **when** it ran.
 *
 * Deliberately absent: request state, loading flags, retry counters, provider
 * errors, cache status, map viewport, provider request ids. None of that is part
 * of a saved plan, and persisting any of it would make a stored trip a record of
 * one session rather than of a trip.
 *
 * `.nullable().default(null)` rather than a schema-version bump: a plan saved
 * before this field existed parses unchanged and simply reports "not attempted",
 * which is true. Discarding everyone's saved trips to add an optional field
 * would be a cost with no compatibility benefit.
 */
export const PlanRoutingStateSchema = z.object({
  policy: AppliedRoutingPolicySchema,
  /** ISO timestamp of the run that produced the attached segments. */
  lastRoutedAt: z.string().min(1),
  summary: RoutingEnrichmentSummarySchema,
});
export type PlanRoutingState = z.infer<typeof PlanRoutingStateSchema>;

export const TripPlanSchema = z.object({
  id: z.string().min(1),
  schemaVersion: z.literal(TRIP_PLAN_SCHEMA_VERSION),
  createdAt: z.string().min(1),
  /**
   * How this plan was produced, and the discriminant the sample banner reads.
   *
   * `mock` covers both the fixed Lisbon sample and the deterministic demo planner:
   * both are template output with no model behind them, and the traveller needs to
   * be told the same thing about both. `generated` means a language model chose and
   * ordered the stops. The provider that did so is recorded outside the plan — see
   * `TripGenerationContext` in `lib/store/trip-record.ts` — so provenance does not
   * pollute the domain.
   *
   * Widening the literal to an enum is backwards-compatible: every stored plan says
   * `"mock"`, which is still valid.
   */
  source: z.enum(["mock", "generated"]),
  request: TripRequestSchema,
  destination: DestinationSummarySchema,
  flights: FlightEstimateSchema,
  /**
   * Null when no place to stay could be recommended.
   *
   * The honest representation of a real outcome: a destination whose
   * OpenStreetMap coverage includes no mapped hotel, hostel or guest house has
   * none to offer, and the alternatives are both worse. Inventing one is the
   * prohibited thing. Failing the whole generation over it would throw away a
   * perfectly good five-day itinerary because one panel cannot be filled.
   *
   * `.nullable()` without a default, so a stored plan must still say which it is
   * rather than acquiring an accommodation by omission.
   */
  accommodation: AccommodationRecommendationSchema.nullable(),
  budget: BudgetSummarySchema,
  days: z.array(ItineraryDaySchema).min(1).max(7),
  practicalNotes: z.array(z.string().min(1)).min(1),
  /** Null until the traveller asks for real routes. See above. */
  routing: PlanRoutingStateSchema.nullable().default(null),
});
export type TripPlan = z.infer<typeof TripPlanSchema>;

/** Every mappable place in day order, deduplicated by Place ID. */
export function collectPlanPlaces(plan: TripPlan): TripPlace[] {
  const seen = new Set<string>();
  const places: TripPlace[] = [];
  for (const day of plan.days) {
    for (const item of day.items) {
      if (!item.place) continue;
      if (seen.has(item.place.placeId)) continue;
      seen.add(item.place.placeId);
      places.push(item.place);
    }
  }
  return places;
}

/**
 * True when an item can carry a map marker: it has a location and the pipeline
 * actually filled the slot.
 */
export function isMappableItem(
  item: ItineraryItem,
): item is ItineraryItem & { place: TripPlace } {
  return item.status === "confirmed" && item.place !== null;
}
