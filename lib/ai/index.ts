/**
 * The model boundary's public surface.
 *
 * Client-safe and provider-free: no `server-only`, no adapter import, no network,
 * no environment read. It contains the contracts, the prompts and the mechanical
 * validation — which is precisely why the validation can be unit-tested against
 * hand-written payloads with no provider anywhere in sight.
 *
 * The adapters live in `lib/providers/ai/` and are server-only. Nothing in this
 * module names Gemini or Ollama.
 */

export {
  isGenerationSuccess,
  type AiOperation,
  type AiProviderId,
  type AiProviderPreference,
  type AiUnavailableReason,
  type NormalizedModelUsage,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type StructuredGenerator,
} from "./types";

export {
  httpStatusForReason,
  reasonFromThrown,
  refused,
  unavailable,
} from "./errors";

export {
  AssemblyBackupSchema,
  AssemblyDaySchema,
  AssemblyItemSchema,
  BudgetAllocationSchema,
  GeneratedTripAssemblySchema,
  ModelCostEstimateSchema,
  NonPlaceCategorySchema,
  SearchRequirementSchema,
  StrategyDaySchema,
  TripStrategySchema,
  isRepairable,
  type AssemblyBackup,
  type AssemblyDay,
  type AssemblyItem,
  type BudgetAllocation,
  type GeneratedTripAssembly,
  type GenerationViolation,
  type ModelPlaceCandidate,
  type NonPlaceCategory,
  type SearchRequirement,
  type StrategyDay,
  type TripStrategy,
} from "./schemas";

export {
  PROHIBITED_KEYS,
  findProhibitedFields,
  type ProhibitedFieldFinding,
} from "./prohibited";

export { jsonSchemaText, toProviderJsonSchema } from "./json-schema";

export {
  BUDGET_ALLOCATION_TOLERANCE,
  MAX_SLOTS_PER_DAY,
  validateStrategy,
  type StrategyValidationInput,
  type StrategyValidationResult,
} from "./validate-strategy";

export {
  minutesOfDay,
  validateAssembly,
  type AssemblyValidationInput,
  type AssemblyValidationResult,
} from "./validate-assembly";

export {
  STRATEGY_SYSTEM_INSTRUCTION,
  type StrategyPromptInput,
} from "./prompts/strategy";

export {
  ASSEMBLY_SYSTEM_INSTRUCTION,
  type AssemblyPromptInput,
} from "./prompts/assembly";

export {
  MAX_REPORTED_VIOLATIONS,
  assemblyRepairSystemInstruction,
  formatViolations,
  strategyRepairSystemInstruction,
} from "./prompts/repair";
