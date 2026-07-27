import type { AiUnavailableReason } from "@/lib/ai";
import type {
  TripGenerationContext,
  TripPlan,
} from "@/lib/schemas";

import type { RefinementActionType } from "./commands";

/**
 * What a refinement can produce, and why the arms are separated the way they are.
 *
 * The rule that shapes all of it: **`refused`, `unavailable` and `failed` carry no
 * plan.** There is nothing partially applied to clean up, because nothing was ever
 * applied — the builder produces a candidate in memory and the caller either saves
 * it whole or discards it whole. That is what makes "failure never corrupts the
 * current trip" a structural property rather than a promise about error handling.
 *
 * `partial` exists for the same reason it does in generation: a refinement that
 * leaves a slot open produced a valid, saveable plan with a visible gap, and
 * collapsing it into `success` would present a hole as a clean result.
 */

export type RefinementErrorCode =
  | "item_not_found"
  | "item_not_replaceable"
  | "backup_not_found"
  | "day_not_found"
  | "no_eligible_candidates"
  | "place_outside_pool"
  | "prohibited_field"
  | "schema_invalid"
  | "schedule_invalid"
  | "stop_cap_exceeded"
  | "meal_coverage_lost"
  | "action_not_honoured"
  | "preserve_violated"
  | "cost_basis_invalid"
  | "pool_violation"
  | "plan_invalid"
  | "generation_context_missing"
  | "unsupported_command"

  /* -- Phase 6B: the deterministic schedule and estimate repairs ----------- */

  /** The action would leave the plan exactly as it is. Refused so nothing burns an undo. */
  | "no_change"
  /** No destination timezone, so no claim about opening hours can be made either way. */
  | "hours_unknown"
  /** Nothing on the day is both inside the published hours and free in the itinerary. */
  | "no_open_slot"
  /** The trip has no saved pool, so there is no verified set of alternatives. */
  | "pool_unavailable"
  /** The chosen place is already somewhere in this trip. */
  | "place_already_used";

export type RefinementError = {
  code: RefinementErrorCode;
  message: string;
  dayNumber?: number;
  itemId?: string;
  placeId?: string;
};

export type RefinementWarning = {
  code: string;
  message: string;
  dayNumber?: number;
  itemId?: string;
};

/**
 * What changed, in terms a traveller can be shown.
 *
 * Deliberately about *the plan*, never about the model: no reasoning, no prompt
 * fragment, no confidence. It is also the thing the UI uses to say "3 stops
 * changed, 2 routes need recalculating", which is the difference between a
 * refinement the traveller can trust and one that silently rearranged their week.
 */
export type RefinementSummary = {
  action: RefinementActionType;
  changedItemIds: string[];
  addedItemIds: string[];
  removedItemIds: string[];
  preservedItemIds: string[];
  /** Legs whose stored result no longer describes a real adjacency. */
  invalidatedLegIds: string[];
  affectedDays: number[];
  previousEstimatedTotal: number;
  newEstimatedTotal: number;
  revisionBefore: number;
  /** Filled in by the client after a successful guarded save. */
  revisionAfter?: number;
};

export type TripRefinementResult =
  | {
      status: "success";
      plan: TripPlan;
      generationContext: TripGenerationContext;
      summary: RefinementSummary;
      warnings: [];
    }
  | {
      status: "partial";
      plan: TripPlan;
      generationContext: TripGenerationContext;
      summary: RefinementSummary;
      warnings: RefinementWarning[];
    }
  | {
      status: "refused";
      userMessage: string;
    }
  | {
      status: "unavailable";
      reason: AiUnavailableReason;
      userMessage: string;
    }
  | {
      status: "failed";
      errors: RefinementError[];
      userMessage: string;
    };

/**
 * The stages, named once and streamed as they happen.
 *
 * Shorter than generation's because a refinement is a smaller operation, and
 * inventing extra stages to make the progress bar look busier would be exactly the
 * simulated progress this codebase avoids.
 */
export const REFINEMENT_STAGES = [
  "reviewing",
  "finding-alternatives",
  "rebuilding",
  "checking",
  "finalising",
] as const;
export type RefinementStage = (typeof REFINEMENT_STAGES)[number];

export const REFINEMENT_STAGE_LABELS: Record<RefinementStage, string> = {
  reviewing: "Reviewing your current plan",
  "finding-alternatives": "Finding eligible alternatives",
  rebuilding: "Rebuilding the affected schedule",
  checking: "Checking places and budget",
  finalising: "Finalising changes",
};

/** Route retry has its own two, because it is not an AI refinement. */
export const ROUTE_RETRY_STAGE_LABELS = {
  recalculating: "Recalculating route",
  updating: "Updating your trip",
} as const;

export type RefinementProgressReporter = (stage: RefinementStage) => void;
