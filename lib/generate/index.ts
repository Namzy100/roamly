/**
 * The generation pipeline's public surface.
 *
 * Mixed by design, and the split is worth naming: `assemble-plan`, `candidates`,
 * `pace-policy` and `types` are pure and client-safe, while `discovery` and
 * `generate-trip-plan` are `server-only` because they reach a provider.
 *
 * Importing this barrel from a client component therefore fails at build time,
 * which is correct — the browser's route to generation is `POST /api/trips/generate`
 * and nothing else. A component that needs a stage label imports
 * `./types` directly.
 */

export {
  GENERATION_STAGES,
  GENERATION_STAGE_LABELS,
  type DiscoveryOutcome,
  type GenerationStage,
  type ProgressReporter,
  type StrategyOutcome,
  type TripGenerationResult,
} from "./types";

export {
  PlanAssemblyError,
  assembleTripPlan,
  countryFrom,
  kindForCategory,
  pickStay,
  type AssembledPlan,
  type AssemblePlanInput,
} from "./assemble-plan";

export {
  MAX_PROMPT_CANDIDATES,
  buildModelCandidates,
  sourceFacts,
  toCandidate,
  type CandidateSet,
} from "./candidates";

export {
  DISCOVERY_LIMITS,
  MAX_DISCOVERY_REQUESTS,
  clampRadius,
  discoverForStrategy,
  orderForPool,
  perCategoryLimit,
  requestedCategories,
} from "./discovery";

export { STOPS_PER_DAY, routingPolicyForPace } from "./pace-policy";

export {
  GENERATION_BUDGET_MS,
  generateTripPlan,
  type GenerateTripPlanInput,
} from "./generate-trip-plan";
