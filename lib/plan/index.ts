/**
 * The plan-enrichment layer's public surface.
 *
 * Pure and client-safe: no `server-only`, no provider imports, no network. It
 * takes a plan plus routing results and produces a new plan, which is exactly
 * what lets the same code run on the server (inside `POST /api/trips/route`) and
 * be tested without a network at all.
 *
 * The provider-facing orchestration that *obtains* the routing results lives in
 * `lib/providers/routing/trip.ts` and is server-only.
 */

export {
  DEFAULT_EXISTING_SEGMENT_POLICY,
  type AccommodationRoutingPolicy,
  type AppliedRoutingPolicy,
  type DayTravelSummary,
  type EnrichedTripPlanResult,
  type ExistingSegmentPolicy,
  type PlanEnrichmentError,
  type PlanEnrichmentErrorCode,
  type RoutingCompletion,
  type RoutingDaySummary,
  type RoutingEnrichmentSummary,
} from "./types";

export {
  enrichTripPlanWithRouting,
  type EnrichTripPlanInput,
} from "./enrich-routing";

export {
  deriveExpectedLegs,
  deriveExpectedLegsForDay,
  indexExpectedLegs,
  owningItemIdForLeg,
  type ExpectedLeg,
} from "./expected-legs";

export {
  completionFor,
  daySegments,
  deriveDayTravelSummary,
  deriveTripTravelSummaries,
  withDerivedBudget,
  withDerivedDayTotals,
} from "./derive-totals";

export { buildRoutingSummary } from "./summary";

export {
  COORDINATE_TOLERANCE_METERS,
  coordinatesMatch,
  validateDayTotals,
  validateEnrichedPlan,
  validateSegmentShapes,
  validateSummaryReconciliation,
} from "./validate-derived";

export { derivePlanPlacePool } from "./pool";

export {
  ACCOMMODATION_ESTIMATE_BASIS,
  COST_ESTIMATE_DISCLAIMER,
  FLIGHT_ESTIMATE_BASIS,
  bandFor,
  buildCostEstimate,
  clampPartyCost,
  costClassFor,
  flightBandFor,
  type CostClass,
} from "./cost-bands";

export {
  DEFAULT_ROUTING_POLICY,
  planRoutingPolicy,
  type RoutingPolicyOverrides,
} from "./policy";

export {
  buildScheduleAccuracyReport,
  conflictsForDay,
  evaluateItem,
  evaluatePlanItems,
  hasScheduleConflicts,
  reportTotalsReconcile,
  type BuildScheduleReportInput,
  type ItemScheduleEvaluation,
  type ScheduleAccuracyReport,
  type ScheduleConflict,
  type ScheduleConflictKind,
  type ScheduleWarning,
  type ScheduleWarningCode,
} from "./schedule-report";

export {
  findOpenSlotForItem,
  repairScheduleConflicts,
  type RepairScheduleInput,
  type ScheduleRepairChange,
  type ScheduleRepairResult,
} from "./schedule-repair";
