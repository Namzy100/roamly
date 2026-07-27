import "server-only";

import { format, parseISO } from "date-fns";

import {
  ASSEMBLY_SYSTEM_INSTRUCTION,
  GeneratedTripAssemblySchema,
  STRATEGY_SYSTEM_INSTRUCTION,
  TripStrategySchema,
  assemblyRepairSystemInstruction,
  formatViolations,
  isRepairable,
  strategyRepairSystemInstruction,
  validateAssembly,
  validateStrategy,
  type AiProviderPreference,
  type GeneratedTripAssembly,
  type GenerationViolation,
  type StructuredGenerationResult,
  type StructuredGenerator,
  type TripStrategy,
} from "@/lib/ai";
import { createStructuredGenerator } from "@/lib/providers/ai";
import {
  GENERATION_CONTEXT_SCHEMA_VERSION,
  PoolValidationError,
  tripDayCount,
  tripNightCount,
  type DiscoverySummary,
  type GeocodedDestinationRecord,
  type GenerationWarning,
  type PlaceCategory,
  type TripGenerationContext,
  type TripRequest,
  type VerifiedPlacePool,
} from "@/lib/schemas";

import { resolveCostProfile } from "@/lib/costs";
import { resolveDestinationTimezone } from "@/lib/opening-hours";
import {
  buildScheduleAccuracyReport,
  repairScheduleConflicts,
} from "@/lib/plan";

import { assembleTripPlan, PlanAssemblyError } from "./assemble-plan";
import { buildModelCandidates } from "./candidates";
import { discoverForStrategy, perCategoryLimit } from "./discovery";
import { routingPolicyForPace } from "./pace-policy";
import type {
  ProgressReporter,
  TripGenerationResult,
} from "./types";

/**
 * The generation pipeline, composed.
 *
 * ```
 * strategy ──(≤1 repair)──► discovery ──► assembly ──(≤1 repair)──► attach ──► validate
 * ```
 *
 * ## What it does not do, and why each matters
 *
 * **It does not persist.** Not at any stage, not even a partial result. The trip
 * lives in the traveller's browser, so the server has nothing to write to and no
 * business writing anywhere else — and the consequence is the property that makes
 * this safe: a run that fails at the last validation leaves *no trace at all*.
 *
 * **It does not route.** A generation makes zero requests to the Valhalla demo
 * server. Routing is a separate action the traveller takes, through the Phase 5A
 * orchestration unchanged, and the plan says so until they do. Routing 20 legs
 * nobody asked for, on someone else's donated machine, as a side effect of pressing
 * "generate", would be indefensible.
 *
 * **It does not retry.** One strategy call, one assembly call, at most one repair
 * each. There is no transport-level retry underneath (see
 * `lib/providers/ai/http.ts`), so the ceiling is four model calls per generation and
 * it is a ceiling rather than an expectation.
 *
 * **It does not fall back between providers.** A configured Gemini that fails does
 * not silently become the demo planner. The traveller is told what happened and
 * chooses.
 *
 * ## The deadline
 *
 * One `AbortController` derived from the caller's signal plus a wall-clock budget,
 * threaded through every model call and every Overpass request. When it fires,
 * everything in flight stops and the result is a controlled `timeout` — not a
 * half-built plan, and not a serverless function killed mid-write.
 */

/**
 * The wall-clock budget, inside the route's `maxDuration`.
 *
 * Roughly: strategy 5–20 s, discovery 3–8 s (three paced Overpass requests),
 * assembly 15–45 s, and a repair only if something was wrong. 90 s covers the
 * unlucky-but-working case with room to return a response, and the route allows 120.
 * A local Ollama on modest hardware is the case most likely to exceed it, which is
 * why the failure is a clean, explained timeout.
 */
export const GENERATION_BUDGET_MS = 90_000;

export type GenerateTripPlanInput = {
  tripId: string;
  request: TripRequest;
  selectedDestination: GeocodedDestinationRecord;
  providerPreference?: AiProviderPreference;
  signal?: AbortSignal;
  onProgress?: ProgressReporter;
  /** Injected in tests so timestamps and provider are deterministic. */
  now?: () => string;
  generator?: StructuredGenerator;
  budgetMs?: number;
  /**
   * A pool that already exists, which makes discovery unnecessary.
   *
   * This is how Phase 6A regeneration stays **pool-stable**: it replans the
   * itinerary against the exact search result set the trip was originally built
   * from, so the universe of allowed places is provably unchanged and no Overpass
   * request is issued. A pool refresh — genuinely re-searching — would change that
   * universe and is a materially different operation, deliberately not offered here.
   *
   * When present, the strategy call is also told which categories the pool actually
   * contains, so it plans for what exists rather than asking for a category that
   * would come back empty by construction.
   */
  existingPool?: {
    pool: VerifiedPlacePool;
    summary: DiscoverySummary;
  };
  /**
   * Places and stops the traveller asked to keep.
   *
   * Passed to the assembly call *and* verified afterwards by the caller — a
   * constraint that is only requested is a preference.
   */
  preserve?: {
    placeIds?: string[];
    itemIds?: string[];
  };
  /** Overrides the plan's `createdAt`, so a regenerated trip keeps its birthday. */
  createdAt?: string;
};

export async function generateTripPlan(
  input: GenerateTripPlanInput,
): Promise<TripGenerationResult> {
  const progress = input.onProgress ?? (() => {});
  const now = input.now ?? (() => new Date().toISOString());

  const selection = input.generator
    ? ({ ok: true, generator: input.generator } as const)
    : createStructuredGenerator({ preference: input.providerPreference });

  if (!selection.ok) {
    return {
      status: "unavailable",
      reason: "not_configured",
      userMessage:
        "No AI planner is configured on this deployment, so an AI itinerary cannot be generated. The demo planner works without any configuration.",
    };
  }

  const generator = selection.generator;
  const deadline = withDeadline(input.signal, input.budgetMs ?? GENERATION_BUDGET_MS);

  try {
    const dayCount = tripDayCount(input.request);
    const warnings: GenerationWarning[] = [];

    /* -- 1. strategy ---------------------------------------------------- */
    progress("understanding");

    const strategyInput = buildStrategyInput(input, dayCount);
    const strategyOutcome = await runStrategy({
      generator,
      input: strategyInput,
      expectedDayCount: dayCount,
      signal: deadline.signal,
    });

    if (strategyOutcome.status !== "ok") return strategyOutcome.result;
    if (strategyOutcome.repaired) {
      warnings.push({
        code: "strategy_repaired",
        message:
          "The planner's first outline did not pass validation and was corrected once before the trip was built.",
      });
    }
    const strategy = strategyOutcome.strategy;

    /* -- 2. discovery, or the pool we already have ----------------------- */
    progress("planning-searches");
    progress("discovering-places");

    /**
     * Regeneration takes this branch: the pool is fixed, so no Overpass request is
     * made and the universe of allowed places is provably the original one.
     */
    const discovery = input.existingPool
      ? {
          pool: input.existingPool.pool,
          summary: input.existingPool.summary,
          warnings: [] as GenerationWarning[],
        }
      : await discoverForStrategy({
          strategy,
          destination: input.selectedDestination,
          signal: deadline.signal,
        });
    warnings.push(...discovery.warnings);

    /**
     * An empty pool is a hard stop, and it is the one place where refusing to
     * continue is clearly right. A model given zero candidates can only produce a
     * plan of gaps or a plan of inventions, and neither is worth a second call.
     */
    if (discovery.pool.places.length === 0) {
      return {
        status: "failed",
        violations: [
          {
            code: "discovery_empty",
            message: "No verifiable places were found near this destination",
          },
        ],
        userMessage:
          "No places could be found in OpenStreetMap near this destination, so there was nothing to build an itinerary from. Try a larger town or city nearby.",
      };
    }

    /* -- 3. assembly ---------------------------------------------------- */
    progress("building-days");

    const candidateSet = buildModelCandidates({
      pool: discovery.pool,
      limitPerCategory: perCategoryLimit(strategy),
    });

    if (candidateSet.truncated) {
      warnings.push({
        code: "candidates_truncated",
        message:
          "More places were found than fit in one planning request, so the planner chose from a capped shortlist.",
      });
    }

    const assemblyInput = buildAssemblyInput({
      input,
      strategy,
      candidateSet,
      discovery,
    });

    const assemblyOutcome = await runAssembly({
      generator,
      input: assemblyInput,
      pool: discovery.pool,
      strategy,
      currency: input.request.currency,
      signal: deadline.signal,
    });

    if (assemblyOutcome.status !== "ok") return assemblyOutcome.result;
    if (assemblyOutcome.repaired) {
      warnings.push({
        code: "assembly_repaired",
        message:
          "The planner's first itinerary did not pass validation and was corrected once before the trip was built.",
      });
    }

    /* -- 4. attach and build -------------------------------------------- */
    progress("checking");

    const generatedAt = now();
    const assembled = assembleTripPlan({
      tripId: input.tripId,
      request: input.request,
      destination: input.selectedDestination,
      strategy,
      assembly: assemblyOutcome.assembly,
      pool: discovery.pool,
      /**
       * The provenance discriminant, and the honest half of the free-first promise.
       *
       * The demo planner produces `"mock"`, which is what makes the sample banner
       * appear for it. It is template output with no model behind it, and a
       * traveller must be told that — labelling it `"generated"` because it went
       * through the same pipeline would be exactly the substitution this phase
       * forbids.
       */
      source: generator.id === "deterministic" ? "mock" : "generated",
      // A regenerated trip keeps its original creation date: it is the same trip.
      createdAt: input.createdAt ?? generatedAt,
    });

    warnings.push(...assembled.warnings);

    /* -- 5. opening hours: check, repair once, check again ---------------- */

    /**
     * Resolved here rather than in the schema, because it is a fact about the
     * *destination* the geocoder returned and it must be recorded with the trip. A
     * multi-timezone country with no city match resolves to null, and every schedule
     * verdict for that trip is then honestly `unknown_timezone`.
     */
    const timezone = resolveDestinationTimezone({
      name: input.selectedDestination.name,
      displayName: input.selectedDestination.displayName,
      ...(input.selectedDestination.countryCode
        ? { countryCode: input.selectedDestination.countryCode }
        : {}),
    });

    /**
     * One deterministic pass, and it happens *after* canonical attachment.
     *
     * Before attachment the items carry `placeId` references and no `openingHours`, so
     * there would be nothing to evaluate. After it, every stop's hours are the
     * provider's own string and the repair is pure arithmetic — no model, no search, no
     * new places.
     *
     * A conflict it cannot fix by moving the clock survives into `warnings` below.
     * Reporting it is the point: a planner that quietly left the museum on the Monday it
     * shuts, and said nothing, would be worse than one that says so.
     */
    const repair = repairScheduleConflicts({
      plan: assembled.plan,
      timezone: timezone?.timezone ?? null,
    });

    for (const change of repair.changes) {
      warnings.push({
        code: "schedule_repaired",
        message: `“${change.placeName}” was moved from ${change.from.startTime} to ${change.to.startTime} on day ${change.dayNumber}, because its published hours that day are ${change.interval.opensAt}–${change.interval.closesAt}.`,
        dayNumber: change.dayNumber,
      });
    }

    // Re-evaluated against the repaired plan, so the retained warnings describe what the
    // traveller will actually see rather than what the first draft looked like.
    const scheduleReport = buildScheduleAccuracyReport({
      plan: repair.plan,
      timezone: timezone?.timezone ?? null,
    });

    for (const conflict of scheduleReport.conflicts) {
      warnings.push({
        code: "schedule_conflict",
        message: conflict.message,
        dayNumber: conflict.dayNumber,
        placeId: conflict.placeId,
      });
    }

    /**
     * Unknown hours are deliberately **not** a generation warning.
     *
     * Most OpenStreetMap places have no `opening_hours` tag, so a warning per unchecked
     * stop would turn almost every generation into a "partial" result and bury the
     * conflicts that actually matter under a wall of "we could not check this one".
     *
     * They are not dropped: `buildScheduleAccuracyReport` re-derives them on every read
     * and the schedule-accuracy panel states them plainly, per stop, which is where a
     * traveller can act on them. This channel carries what went *wrong* with the
     * generation; an absent OSM tag is not that.
     */

    /* -- 6. the retained context ---------------------------------------- */
    progress("finalising");

    const unfilled = countUnavailableItems(repair.plan);
    if (unfilled > 0) {
      warnings.push({
        code: "slots_unfilled",
        message: `${unfilled} planned stop${unfilled === 1 ? "" : "s"} could not be matched to a real place and ${unfilled === 1 ? "is" : "are"} shown as an open slot.`,
      });
    }

    /**
     * Which curated cost profile this trip's estimates belong to.
     *
     * Always resolves — an unrecognised destination gets the global fallback, which
     * reproduces the pre-profile baseline exactly. What changes with a vaguer match is the
     * recorded *confidence*, not the correctness.
     */
    const costProfile = resolveCostProfile({
      name: input.selectedDestination.name,
      displayName: input.selectedDestination.displayName,
      ...(input.selectedDestination.countryCode
        ? { countryCode: input.selectedDestination.countryCode }
        : {}),
    });

    const generation: TripGenerationContext = {
      schemaVersion: GENERATION_CONTEXT_SCHEMA_VERSION,
      provider: generator.id,
      model: generator.model,
      generatedAt,
      destination: input.selectedDestination,
      // The exact search result set, not a pool derived from the finished plan.
      placePool: discovery.pool,
      discoverySummary: discovery.summary,
      warnings,
      // Derived from pace, never from the model. See `pace-policy.ts`.
      routingPolicy: routingPolicyForPace(input.request.pace),
      /**
       * Both recorded rather than re-derived on read.
       *
       * The curated tables behind them will change — a city added, a weight corrected —
       * and a plan whose schedule verdicts or cost provenance shifted underneath a
       * traveller without the plan changing would be the same drift the derived-field
       * rule prevents for totals.
       */
      ...(timezone ? { destinationTimezone: timezone } : {}),
      costProfile: {
        profileId: costProfile.profile.profileId,
        version: costProfile.profile.version,
        match: costProfile.match,
        confidence: costProfile.confidence,
      },
    };

    if (warnings.length === 0) {
      return { status: "success", plan: repair.plan, generation, warnings: [] };
    }
    return {
      status: "partial",
      plan: repair.plan,
      generation,
      warnings,
    };
  } catch (error) {
    return toFailure(error, deadline);
  } finally {
    deadline.dispose();
  }
}

/* -------------------------------------------------------------------------- */
/* Stage runners                                                              */
/* -------------------------------------------------------------------------- */

type StageOutcome<T> =
  | ({ status: "ok"; repaired: boolean } & T)
  | { status: "stop"; result: TripGenerationResult };

async function runStrategy(context: {
  generator: StructuredGenerator;
  input: unknown;
  expectedDayCount: number;
  signal: AbortSignal;
}): Promise<StageOutcome<{ strategy: TripStrategy }>> {
  const first = await context.generator.generate({
    operation: "strategy",
    systemInstruction: STRATEGY_SYSTEM_INSTRUCTION,
    input: context.input,
    outputSchema: TripStrategySchema,
    schemaName: "TripStrategy",
    signal: context.signal,
  });

  const firstValue = readValue(first);
  if (firstValue.status !== "ok") return firstValue;

  const validated = validateStrategy({
    raw: firstValue.value,
    expectedDayCount: context.expectedDayCount,
  });
  if (validated.ok) {
    return { status: "ok", repaired: false, strategy: validated.strategy };
  }

  /**
   * The repair gate.
   *
   * An unrepairable violation — a fabricated place, a prohibited field — fails here
   * rather than being sent back. Asking a model to try again after it asserted a
   * coordinate is asking it to assert a different one.
   */
  if (!isRepairable(validated.violations)) {
    return { status: "stop", result: failedFrom(validated.violations) };
  }

  const repaired = await context.generator.generate({
    operation: "repair",
    systemInstruction: strategyRepairSystemInstruction(),
    input: {
      previousAnswer: firstValue.value,
      problems: formatViolations(validated.violations),
      originalInput: context.input,
    },
    outputSchema: TripStrategySchema,
    schemaName: "TripStrategy",
    signal: context.signal,
  });

  const repairedValue = readValue(repaired);
  if (repairedValue.status !== "ok") return repairedValue;

  const revalidated = validateStrategy({
    raw: repairedValue.value,
    expectedDayCount: context.expectedDayCount,
  });
  // No second repair. One pass, then the answer stands or the generation fails.
  if (!revalidated.ok) {
    return { status: "stop", result: failedFrom(revalidated.violations) };
  }

  return { status: "ok", repaired: true, strategy: revalidated.strategy };
}

async function runAssembly(context: {
  generator: StructuredGenerator;
  input: Record<string, unknown>;
  pool: Parameters<typeof validateAssembly>[0]["pool"];
  strategy: TripStrategy;
  currency: TripRequest["currency"];
  signal: AbortSignal;
}): Promise<StageOutcome<{ assembly: GeneratedTripAssembly }>> {
  const first = await context.generator.generate({
    operation: "assembly",
    systemInstruction: ASSEMBLY_SYSTEM_INSTRUCTION,
    input: context.input,
    outputSchema: GeneratedTripAssemblySchema,
    schemaName: "GeneratedTripAssembly",
    signal: context.signal,
  });

  const firstValue = readValue(first);
  if (firstValue.status !== "ok") return firstValue;

  const validated = validateAssembly({
    raw: firstValue.value,
    pool: context.pool,
    strategy: context.strategy,
    currency: context.currency,
  });
  if (validated.ok) {
    return { status: "ok", repaired: false, assembly: validated.assembly };
  }

  if (!isRepairable(validated.violations)) {
    return { status: "stop", result: failedFrom(validated.violations) };
  }

  const repaired = await context.generator.generate({
    operation: "repair",
    systemInstruction: assemblyRepairSystemInstruction(),
    input: {
      previousAnswer: firstValue.value,
      problems: formatViolations(validated.violations),
      /**
       * The candidate list is re-sent, unchanged.
       *
       * A repair pass that could not see the candidates would have to work from
       * memory of its own previous answer, and "select a different supplied place"
       * would be impossible to comply with. It is the *same* list — no new search
       * happens during a repair.
       */
      originalInput: context.input,
    },
    outputSchema: GeneratedTripAssemblySchema,
    schemaName: "GeneratedTripAssembly",
    signal: context.signal,
  });

  const repairedValue = readValue(repaired);
  if (repairedValue.status !== "ok") return repairedValue;

  const revalidated = validateAssembly({
    raw: repairedValue.value,
    pool: context.pool,
    strategy: context.strategy,
    currency: context.currency,
  });
  if (!revalidated.ok) {
    return { status: "stop", result: failedFrom(revalidated.violations) };
  }

  return { status: "ok", repaired: true, assembly: revalidated.assembly };
}

/**
 * A provider result, reduced to "here is a value" or "here is why we stop".
 *
 * Written once so the refusal and unavailable arms cannot be handled two different
 * ways in the two stages — which is precisely how a refusal ends up reported as a
 * generic failure in one place and correctly in the other.
 */
function readValue(
  result: StructuredGenerationResult<unknown>,
):
  | { status: "ok"; value: unknown }
  | { status: "stop"; result: TripGenerationResult } {
  switch (result.status) {
    case "success":
      return { status: "ok", value: result.value };
    case "refused":
      return {
        status: "stop",
        result: { status: "refused", userMessage: result.userMessage },
      };
    case "unavailable":
      return {
        status: "stop",
        result: {
          status: "unavailable",
          reason: result.reason,
          userMessage: result.userMessage,
        },
      };
  }
}

function failedFrom(violations: GenerationViolation[]): TripGenerationResult {
  // Logged in full server-side; only codes and our own sentences go back.
  console.error(
    "[roamly] generation rejected model output",
    JSON.stringify(violations.slice(0, 12)),
  );
  return {
    status: "failed",
    violations: violations.map((violation) => ({
      code: violation.code,
      message: violation.message,
    })),
    userMessage:
      "The planner's itinerary did not pass verification, so nothing was saved. Please try again, or use the demo planner.",
  };
}

function toFailure(
  error: unknown,
  deadline: { timedOut: boolean },
): TripGenerationResult {
  if (deadline.timedOut) {
    return {
      status: "unavailable",
      reason: "timeout",
      userMessage:
        "Generating this trip took longer than the time available, so nothing was saved. Please try again, or use the demo planner.",
    };
  }

  if (error instanceof Error && error.name === "AbortError") {
    return {
      status: "unavailable",
      reason: "aborted",
      userMessage: "Trip generation was cancelled, so nothing was saved.",
    };
  }

  /**
   * A pool or attachment violation is *our* bug, not the traveller's, and it is the
   * most serious failure this pipeline has. It means a place reached the plan that
   * the pool does not vouch for. It is logged in full and nothing is saved.
   */
  if (error instanceof PoolValidationError) {
    console.error(
      "[roamly] generated plan failed pool verification",
      error.code,
      error.message,
    );
    return {
      status: "failed",
      violations: [{ code: error.code, message: error.message }],
      userMessage:
        "The generated itinerary failed verification against the places that were actually found, so nothing was saved.",
    };
  }

  if (error instanceof PlanAssemblyError) {
    console.error("[roamly] generated plan could not be assembled", error.message);
    return {
      status: "failed",
      violations: [{ code: "assembly_failed", message: error.message }],
      userMessage:
        "The generated itinerary could not be turned into a valid trip, so nothing was saved.",
    };
  }

  console.error("[roamly] generation failed unexpectedly", error);
  return {
    status: "unavailable",
    reason: "unknown",
    userMessage:
      "Something went wrong generating this trip, so nothing was saved. Please try again.",
  };
}

/* -------------------------------------------------------------------------- */
/* Deadline                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One signal for the whole pipeline.
 *
 * Every model call and every Overpass request receives it, so a cancelled request
 * or an exhausted budget stops *all* of the work rather than only the step that
 * happened to notice. `timedOut` is tracked separately from `aborted` because the
 * two mean different things to the traveller: one is us running out of time, the
 * other is them changing their mind.
 */
function withDeadline(
  callerSignal: AbortSignal | undefined,
  budgetMs: number,
): { signal: AbortSignal; timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  const state = {
    signal: controller.signal,
    timedOut: false,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };

  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new DOMException("Generation budget exhausted", "TimeoutError"));
  }, budgetMs);

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  return state;
}

/* -------------------------------------------------------------------------- */
/* Prompt inputs                                                               */
/* -------------------------------------------------------------------------- */

function buildStrategyInput(input: GenerateTripPlanInput, dayCount: number) {
  const { request } = input;

  /**
   * When the pool is fixed, the strategy is told what is in it.
   *
   * Without this the model would happily ask for a category the saved search never
   * covered, and every slot needing one would come back unavailable — a
   * regeneration full of gaps for a reason that had nothing to do with the
   * destination.
   */
  const availableCategories: PlaceCategory[] | undefined = input.existingPool
    ? [...new Set(input.existingPool.pool.places.map((place) => place.category))].sort()
    : undefined;

  return {
    ...(availableCategories ? { availableCategories } : {}),
    destinationName: input.selectedDestination.name,
    destinationDisplayName: input.selectedDestination.displayName,
    ...(input.selectedDestination.countryCode
      ? { countryCode: input.selectedDestination.countryCode }
      : {}),
    departureCity: request.departureCity,
    startDate: request.startDate,
    endDate: request.endDate,
    dayCount,
    nightCount: tripNightCount(request),
    budget: request.budget,
    currency: request.currency,
    travelers: request.travelers,
    vibes: request.vibes,
    pace: request.pace,
    accommodation: request.accommodation,
    dietary: request.dietary,
    interests: request.interests,
    notes: request.notes,
  };
}

function buildAssemblyInput(context: {
  input: GenerateTripPlanInput;
  strategy: TripStrategy;
  candidateSet: ReturnType<typeof buildModelCandidates>;
  discovery: Awaited<ReturnType<typeof discoverForStrategy>>;
}): Record<string, unknown> {
  const { request } = context.input;

  return {
    destinationName: context.input.selectedDestination.name,
    destinationDisplayName: context.input.selectedDestination.displayName,
    currency: request.currency,
    budget: request.budget,
    travelers: request.travelers,
    pace: request.pace,
    dietary: request.dietary,
    interests: request.interests,
    vibes: request.vibes,
    notes: request.notes,
    // Weekdays matter: a market tagged `Tu,Sa` and a museum that shuts on Mondays
    // are both things a model can reason about only if it knows which day is which.
    dayDates: buildDayDateLabels(request),
    strategy: context.strategy,
    candidates: context.candidateSet.candidates,
    candidateCountsByCategory: context.candidateSet.countsByCategory,
    categoriesWithNoResults: context.discovery.summary.categoriesWithNoResults,
    // Verified after the fact in `lib/refinement/validate.ts`, so this is a
    // guarantee rather than a request.
    ...(context.input.preserve ? { preserve: context.input.preserve } : {}),
  };
}

function buildDayDateLabels(request: TripRequest) {
  const start = parseISO(request.startDate);
  return Array.from({ length: tripDayCount(request) }, (_, index) => {
    const date = new Date(start);
    date.setDate(date.getDate() + index);
    return {
      dayNumber: index + 1,
      date: format(date, "yyyy-MM-dd"),
      weekday: format(date, "EEEE"),
    };
  });
}

function countUnavailableItems(plan: {
  days: { items: { status: string }[] }[];
}): number {
  return plan.days.reduce(
    (total, day) =>
      total + day.items.filter((item) => item.status === "unavailable").length,
    0,
  );
}
