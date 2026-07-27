/**
 * Destination-aware cost estimates.
 *
 * Pure and client-safe: a curated table, dimensionless multipliers and arithmetic. No
 * network, no model, no clock, and — deliberately — no currency conversion anywhere. See
 * `types.ts` for why a profile holds no money at all.
 */

export {
  MIN_BUDGET_PER_TRAVELER_PER_DAY,
  type AllocationInput,
  type AllocationWarning,
  type BudgetAllocation,
  type CategoryWeights,
  type CostBand,
  type CostClassKey,
  type DestinationCostProfile,
  type ProfileMatch,
  type ResolvedCostProfile,
} from "./types";

export { DESTINATION_COST_PROFILES, GLOBAL_PROFILE_ID } from "./profiles";

export {
  costProfileById,
  globalProfile,
  resolveCostProfile,
} from "./destination-profile";

export {
  MIN_BUFFER_SHARE,
  adjustedWeights,
  allocateBudget,
  plannedStopsPerDay,
} from "./allocate";

export {
  buildDestinationCostEstimate,
  estimateItemAllowance,
  type ItemAllowance,
  type ItemAllowanceInput,
} from "./estimate";

export {
  assertAllocationReconciles,
  validateAllocation,
  validateBandCoverage,
  validateProfileTable,
  type ValidationIssue,
} from "./validate";
