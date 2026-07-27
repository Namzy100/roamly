import { describe, expect, it } from "vitest";

import {
  ASSEMBLY_SYSTEM_INSTRUCTION,
  GeneratedTripAssemblySchema,
  STRATEGY_SYSTEM_INSTRUCTION,
  TripStrategySchema,
  validateAssembly,
  validateStrategy,
} from "@/lib/ai";
import { buildModelCandidates } from "@/lib/generate/candidates";
import {
  FIXTURE_DESTINATION,
  FIXTURE_REQUEST,
  fixturePool,
  fixtureStrategy,
} from "@/lib/generate/test-fixtures";
import { createOllamaGenerator, resolveAiConfig } from "@/lib/providers/ai";
import { tripDayCount } from "@/lib/schemas";

/**
 * Opt-in live check against a local Ollama.
 *
 * Run with `npm run test:integration:ai:ollama`, having set `OLLAMA_BASE_URL` and
 * pulled the configured model. Excluded from `npm test` and from CI, where no Ollama
 * exists.
 *
 * Costs nothing but local compute and sends nothing off the machine — but it is
 * *slow*, which is the other reason it is opt-in: a small model assembling a two-day
 * itinerary can take a minute, and the integration config allows for that.
 *
 * Responsible-use properties:
 *  - two requests total
 *  - **skips cleanly** when no base URL is configured
 *  - skips when the server is unreachable or the model is not pulled, rather than
 *    failing — "you have not run `ollama pull`" is a setup step, not a regression
 *
 * The interesting property here is different from the Gemini suite: it checks that
 * grammar-constrained decoding via `format` actually produces schema-valid output
 * from a small local model, which is the claim the Ollama adapter rests on.
 */

const config = resolveAiConfig();
const configured = config.ollama !== null;

const SKIP_REASONS = new Set([
  "provider_unavailable",
  "timeout",
  "not_configured",
  "rate_limited",
]);

describe.skipIf(!configured)("live Ollama structured generation", () => {
  const generator = configured ? createOllamaGenerator(config.ollama!) : null;
  const dayCount = tripDayCount(FIXTURE_REQUEST);

  it("returns a strategy our validator accepts", async () => {
    if (!generator) return;

    const result = await generator.generate({
      operation: "strategy",
      systemInstruction: STRATEGY_SYSTEM_INSTRUCTION,
      input: {
        destinationName: FIXTURE_DESTINATION.name,
        destinationDisplayName: FIXTURE_DESTINATION.displayName,
        departureCity: FIXTURE_REQUEST.departureCity,
        startDate: FIXTURE_REQUEST.startDate,
        endDate: FIXTURE_REQUEST.endDate,
        dayCount,
        nightCount: dayCount - 1,
        budget: FIXTURE_REQUEST.budget,
        currency: FIXTURE_REQUEST.currency,
        travelers: FIXTURE_REQUEST.travelers,
        vibes: FIXTURE_REQUEST.vibes,
        pace: FIXTURE_REQUEST.pace,
        accommodation: FIXTURE_REQUEST.accommodation,
        dietary: FIXTURE_REQUEST.dietary,
        interests: FIXTURE_REQUEST.interests,
        notes: FIXTURE_REQUEST.notes,
      },
      outputSchema: TripStrategySchema,
      schemaName: "TripStrategy",
    });

    if (result.status === "unavailable" && SKIP_REASONS.has(result.reason)) {
      console.warn(
        `[skipped] Ollama unavailable: ${result.reason}. Is the server running and the model pulled?`,
      );
      return;
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const validated = validateStrategy({
      raw: result.value,
      expectedDayCount: dayCount,
    });

    if (!validated.ok) {
      // A small model failing a cross-field invariant is informative rather than
      // surprising — the pipeline's repair pass exists for exactly this.
      console.error(
        "strategy violations:",
        validated.violations.map((violation) => violation.code),
      );
    }
    // The structural half must hold regardless: `format` constrains the grammar.
    expect(TripStrategySchema.safeParse(result.value).success).toBe(true);
  });

  it("assembles from a fixture pool without inventing a place", async () => {
    if (!generator) return;

    const pool = fixturePool();
    const strategy = fixtureStrategy();
    const candidates = buildModelCandidates({ pool, limitPerCategory: 6 });

    const result = await generator.generate({
      operation: "assembly",
      systemInstruction: ASSEMBLY_SYSTEM_INSTRUCTION,
      input: {
        destinationName: FIXTURE_DESTINATION.name,
        destinationDisplayName: FIXTURE_DESTINATION.displayName,
        currency: FIXTURE_REQUEST.currency,
        budget: FIXTURE_REQUEST.budget,
        travelers: FIXTURE_REQUEST.travelers,
        pace: FIXTURE_REQUEST.pace,
        dietary: FIXTURE_REQUEST.dietary,
        interests: FIXTURE_REQUEST.interests,
        vibes: FIXTURE_REQUEST.vibes,
        notes: FIXTURE_REQUEST.notes,
        dayDates: [
          { dayNumber: 1, date: "2026-09-12", weekday: "Saturday" },
          { dayNumber: 2, date: "2026-09-13", weekday: "Sunday" },
        ],
        strategy,
        candidates: candidates.candidates,
        candidateCountsByCategory: candidates.countsByCategory,
        categoriesWithNoResults: [],
      },
      outputSchema: GeneratedTripAssemblySchema,
      schemaName: "GeneratedTripAssembly",
    });

    if (result.status === "unavailable" && SKIP_REASONS.has(result.reason)) {
      console.warn(`[skipped] Ollama unavailable: ${result.reason}`);
      return;
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    // Grammar-constrained output must be structurally valid.
    expect(GeneratedTripAssemblySchema.safeParse(result.value).success).toBe(true);

    const validated = validateAssembly({
      raw: result.value,
      pool,
      strategy,
      currency: FIXTURE_REQUEST.currency,
    });

    /**
     * The non-negotiable half. A grammar can police shape but not truth, so a small
     * model *can* emit a schema-valid id it made up — and if it does, that must show
     * up here as a hard failure rather than as a repairable slip.
     */
    const fabrications = validated.violations.filter((violation) =>
      ["place_outside_pool", "backup_outside_pool", "prohibited_field"].includes(
        violation.code,
      ),
    );
    if (fabrications.length > 0) {
      console.error("fabrications:", fabrications);
    }
    expect(fabrications).toEqual([]);
  });
});

describe.skipIf(configured)("live Ollama structured generation", () => {
  it("skips cleanly when OLLAMA_BASE_URL is not set", () => {
    expect(config.ollama).toBeNull();
  });
});
