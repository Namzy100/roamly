import type { AiProviderId, AiUnavailableReason, TripStrategy } from "@/lib/ai";
import type {
  DiscoverySummary,
  GenerationWarning,
  TripGenerationContext,
  TripPlan,
  VerifiedPlacePool,
} from "@/lib/schemas";

/**
 * What a generation run can produce, and why there are five arms rather than two.
 *
 * ## The distinctions that matter
 *
 * `success` and `partial` both carry a complete, validated, saveable plan. The
 * difference is that a partial plan contains slots the search could not fill, shown
 * to the traveller as gaps. Collapsing the two would mean either presenting a plan
 * with holes as complete, or throwing away a good five-day itinerary because one
 * café was missing — and a thin destination is a fact about the map, not a failure.
 *
 * `refused`, `unavailable` and `failed` all carry **no plan**, and are kept apart
 * because they call for different things from the traveller:
 *
 *  - `refused` — the model declined. Retrying will not help; rephrase or use the
 *    demo planner.
 *  - `unavailable` — nothing was reachable, or nothing is configured. Retrying may
 *    well help, and the reason code says whether it is worth it.
 *  - `failed` — output arrived and was rejected. This is *our* bug or a model that
 *    tried to fabricate, and the honest response is to save nothing and say so.
 *
 * ## Nothing is ever partially saved
 *
 * No arm writes anything. The pipeline builds in memory, validates, and hands the
 * caller a result; persistence is one atomic write in the browser afterwards. A
 * `failed` run therefore leaves no trace at all, which is the property that makes
 * "validate then commit" real rather than aspirational.
 */

export type TripGenerationResult =
  | {
      status: "success";
      plan: TripPlan;
      generation: TripGenerationContext;
      /** Empty by definition — a run with warnings is `partial`. */
      warnings: [];
    }
  | {
      status: "partial";
      plan: TripPlan;
      generation: TripGenerationContext;
      /** Non-empty. Rendered, not logged and forgotten. */
      warnings: GenerationWarning[];
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
      /** Our codes and our sentences. Never a provider's, never a stack trace. */
      violations: { code: string; message: string }[];
      userMessage: string;
    };

/**
 * The stages, named once.
 *
 * These strings are streamed to the browser as progress and are therefore part of
 * the user-facing contract, not debug output. They describe what is happening in
 * terms a traveller recognises — "Discovering real places", not "Overpass query 2
 * of 3" — and each one is emitted when the work genuinely starts, so the progress
 * bar is a report rather than an animation.
 */
export const GENERATION_STAGES = [
  "understanding",
  "planning-searches",
  "discovering-places",
  "building-days",
  "checking",
  "finalising",
] as const;
export type GenerationStage = (typeof GENERATION_STAGES)[number];

export const GENERATION_STAGE_LABELS: Record<GenerationStage, string> = {
  understanding: "Understanding your trip",
  "planning-searches": "Finding the right types of places",
  "discovering-places": "Discovering real places",
  "building-days": "Building your daily plan",
  checking: "Checking schedule and budget",
  finalising: "Finalising your trip",
};

/** Called as each stage begins. Never awaited — progress must not pace the work. */
export type ProgressReporter = (stage: GenerationStage) => void;

/** The result of the discovery half of the pipeline. */
export type DiscoveryOutcome = {
  pool: VerifiedPlacePool;
  summary: DiscoverySummary;
  warnings: GenerationWarning[];
};

/** Everything the strategy stage produced, plus how it was produced. */
export type StrategyOutcome = {
  strategy: TripStrategy;
  provider: AiProviderId;
  model: string;
  /** True when one repair pass was needed. Recorded as a warning, not hidden. */
  repaired: boolean;
};
