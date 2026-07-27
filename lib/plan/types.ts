import type {
  RoutingCompletion,
  RoutingEnrichmentSummary,
  TripPlan,
} from "@/lib/schemas";

/**
 * The policy, completion and summary vocabulary lives in
 * `lib/schemas/routing-state.ts`, because the plan schema itself persists it and
 * a definition here would create a module cycle. Re-exported so `lib/plan` is
 * still one import surface for callers.
 */
export {
  DEFAULT_EXISTING_SEGMENT_POLICY,
  type AccommodationRoutingPolicy,
  type AppliedRoutingPolicy,
  type ExistingSegmentPolicy,
  type RoutingCompletion,
  type RoutingDaySummary,
  type RoutingEnrichmentSummary,
} from "@/lib/schemas";

/**
 * The vocabulary of plan enrichment.
 *
 * Client-safe and provider-free, like `lib/routing/`. The server orchestration
 * in `lib/providers/routing/trip.ts` produces these; the workspace consumes
 * them; neither sees a Valhalla shape.
 */

/* -------------------------------------------------------------------------- */
/* Travel totals                                                               */
/* -------------------------------------------------------------------------- */

/**
 * A day's travel time, with its provenance.
 *
 * Derived at runtime from the day's segments rather than persisted — every
 * field below is a pure function of them, and a stored copy could only ever
 * disagree. The one exception is `pendingLegs`, which needs the *expected* leg
 * set and therefore the policy; that comes from `plan.routing`, and is `null`
 * when no run has happened.
 *
 * The point of the split is that `knownDurationMinutes` alone is a lie by
 * omission. Twenty minutes across two routed legs and twenty minutes across two
 * routed legs plus three unavailable ones are very different days, and only
 * `completeness` distinguishes them.
 */
export type DayTravelSummary = {
  dayNumber: number;
  /** Routed plus retained estimates. What `totalTravelMinutes` means. */
  knownDurationMinutes: number;
  routedDurationMinutes: number;
  estimatedDurationMinutes: number;
  routedDistanceMeters: number;
  /** Present only where an estimate supplied one; estimates often do not. */
  estimatedDistanceMeters: number;
  routedLegs: number;
  estimatedLegs: number;
  unavailableLegs: number;
  /** Expected but never attempted. `null` when no policy has been applied. */
  pendingLegs: number | null;
  completeness: RoutingCompletion;
};

/* -------------------------------------------------------------------------- */
/* Enrichment result                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A contract violation, as data.
 *
 * These are bugs, not weather: a result for a leg that does not exist, a mode
 * that does not match, coordinates that belong to a different place. They
 * produce the `failed` arm and never a partially-enriched plan, because a plan
 * assembled from mismatched parts is worse than no enrichment at all.
 */
export type PlanEnrichmentErrorCode =
  | "unknown_day"
  | "unknown_leg"
  | "duplicate_result"
  | "origin_mismatch"
  | "destination_mismatch"
  | "coordinate_mismatch"
  | "mode_mismatch"
  | "pool_violation"
  | "invalid_plan"
  | "derived_mismatch";

export type PlanEnrichmentError = {
  code: PlanEnrichmentErrorCode;
  message: string;
  legId?: string;
  dayNumber?: number;
};

export type EnrichedTripPlanResult =
  | {
      /** Every expected leg is routed. */
      status: "complete";
      plan: TripPlan;
      summary: RoutingEnrichmentSummary;
    }
  | {
      /**
       * A valid plan, with some legs unrouted. This is the normal outcome
       * against a shared demo server and is not an error.
       */
      status: "partial";
      plan: TripPlan;
      summary: RoutingEnrichmentSummary;
    }
  | {
      /** A contract violation. No plan is returned — there is nothing safe to return. */
      status: "failed";
      errors: PlanEnrichmentError[];
    };
