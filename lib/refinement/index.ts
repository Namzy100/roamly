/**
 * The refinement layer's public surface.
 *
 * Mixed, like `lib/generate`: `commands`, `schemas`, `candidates`, `schedule`,
 * `validate`, `invalidate-routes`, `summary` and the three appliers are **pure and
 * client-safe**, while `refine-trip` is `server-only` because it reaches a provider.
 *
 * That split is deliberate and load-bearing. The UI needs the command vocabulary and
 * the stage labels; it must not be able to import the orchestrator, and importing
 * this barrel from a `"use client"` file fails at build time for exactly that reason.
 * A component that needs a label imports `./types` or `./commands` directly.
 */

export {
  AdjustDayCommandSchema,
  AiRefinementCommandSchema,
  InsertFreeTimeCommandSchema,
  LockItemCommandSchema,
  RemoveItemCommandSchema,
  SelectAlternativeCommandSchema,
  SetItemDurationCommandSchema,
  SetItemTimeCommandSchema,
  UnlockItemCommandSchema,
  REFINEMENT_ACTION_LABELS,
  RecalculateEstimatesCommandSchema,
  RegenerateTripCommandSchema,
  ResolveHoursConflictCommandSchema,
  isDeterministic,
  ReplaceBackupCommandSchema,
  ReplaceItemCommandSchema,
  RetryRoutesCommandSchema,
  TripRefinementCommandSchema,
  needsConfirmation,
  requiresPlanner,
  type AiRefinementCommand,
  type RefinementActionType,
  type TripRefinementCommand,
} from "./commands";

export {
  canRefinePlaces,
  refinementUnavailableReason,
} from "./eligibility";

export {
  REFINEMENT_STAGES,
  REFINEMENT_STAGE_LABELS,
  ROUTE_RETRY_STAGE_LABELS,
  type RefinementError,
  type RefinementErrorCode,
  type RefinementProgressReporter,
  type RefinementStage,
  type RefinementSummary,
  type RefinementWarning,
  type TripRefinementResult,
} from "./types";

export {
  MAX_REFINEMENT_CANDIDATES,
  REPLACEMENT_RADIUS_METERS,
  deriveEligibleCandidates,
  filterForReplacement,
  orderCandidates,
  placesInUse,
  type CandidateFilter,
  type EligibleCandidates,
} from "./candidates";

export {
  SCHEDULE_LIMITS,
  countStops,
  currentMealTypes,
  validateDayAlignment,
  validateSchedule,
  type ScheduleViolation,
} from "./schedule";

export {
  AdjustDayResultSchema,
  REFINEMENT_SCHEMA_NAMES,
  RefinedDayItemSchema,
  ReplaceBackupResultSchema,
  ReplaceItemResultSchema,
  type AdjustDayResult,
  type RefinedDayItem,
  type ReplaceBackupResult,
  type ReplaceItemResult,
} from "./schemas";

export {
  clearAllRoutes,
  rekeyDaySegments,
  rekeyPlanSegments,
  selectRetryLegs,
  type RekeyedDay,
} from "./invalidate-routes";

export {
  RefinementBuildError,
  applyItemReplacement,
  applyItemUnavailable,
  nextItemId,
} from "./replace-item";

export {
  applyBackupReplacement,
  applyBackupUnavailable,
} from "./replace-backup";

export { applyDayAdjustment } from "./adjust-day";

export { buildRefinementSummary } from "./summary";

export {
  applyHoursAdjustTime,
  applyHoursMarkUnavailable,
  applyHoursReplacePlace,
  hoursConflictCandidates,
  itemHasHoursConflict,
  type ResolveOutcome,
} from "./resolve-hours";

export {
  costProfileProvenance,
  previousCostProfile,
  reestimatePlanCosts,
  type ReestimateOutcome,
} from "./reestimate";

export {
  expectedDayDates,
  validateAdjustDayResult,
  validateAdjustmentHonoured,
  validatePreserved,
  validateRefinedPlan,
  validateReplaceBackupResult,
  validateReplaceItemResult,
} from "./validate";

export {
  REFINEMENT_BUDGET_MS,
  refineTrip,
  resolveRefinementProvider,
  withRefinementProvenance,
  type RefineTripInput,
} from "./refine-trip";
