import { describe, expect, it } from "vitest";

import {
  GeneratedTripAssemblySchema,
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
import {
  ASSEMBLY_SYSTEM_INSTRUCTION,
  STRATEGY_SYSTEM_INSTRUCTION,
} from "@/lib/ai";
import { createGeminiGenerator, resolveAiConfig } from "@/lib/providers/ai";
import { tripDayCount } from "@/lib/schemas";

/**
 * Opt-in live check against the Gemini API.
 *
 * Run with `npm run test:integration:ai:gemini`. Deliberately **excluded** from
 * `npm test` and from CI: it costs real quota on a rate-limited free tier, and a unit
 * suite that consumed someone's daily allowance on every save would be unusable.
 *
 * Responsible-use properties:
 *  - **two requests total**: one short strategy call, one bounded assembly call
 *  - a two-day trip and a seven-place fixture pool, so both prompts are small
 *  - no retry, no loop, no repair pass
 *  - **skips cleanly** with no key configured, rather than failing
 *  - a rate limit or an outage **skips** too, so someone else's quota ceiling can
 *    never break a run
 *
 * What it verifies is narrow and deliberate: that a real model, given our real
 * prompts, produces output our real validators accept. It does not judge itinerary
 * quality — that is not a property a test can assert.
 */

const config = resolveAiConfig();
const configured = config.gemini !== null;

/** A quota ceiling or a bad hour on Google's side is not a failure of ours. */
const SKIP_REASONS = new Set([
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "not_configured",
]);

describe.skipIf(!configured)("live Gemini structured generation", () => {
  const generator = configured ? createGeminiGenerator(config.gemini!) : null;
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
      console.warn(`[skipped] Gemini unavailable: ${result.reason}`);
      return;
    }
    if (result.status === "refused") {
      console.warn("[skipped] Gemini refused a benign travel prompt");
      return;
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const validated = validateStrategy({
      raw: result.value,
      expectedDayCount: dayCount,
    });

    // The whole point: a real model, our real prompt, our real gate.
    expect(validated.violations).toEqual([]);
    expect(validated.ok).toBe(true);
  });

  it("assembles from a fixture pool, referencing only supplied placeIds", async () => {
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
      console.warn(`[skipped] Gemini unavailable: ${result.reason}`);
      return;
    }
    if (result.status === "refused") {
      console.warn("[skipped] Gemini refused a benign travel prompt");
      return;
    }

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const validated = validateAssembly({
      raw: result.value,
      pool,
      strategy,
      currency: FIXTURE_REQUEST.currency,
    });

    if (!validated.ok) {
      // Printed rather than swallowed: a live failure here is genuinely interesting,
      // and the codes say whether it was a fabrication or a scheduling slip.
      console.error(
        "assembly violations:",
        validated.violations.map((violation) => violation.code),
      );
    }
    expect(validated.ok).toBe(true);

    // Every id came from the pool, and nothing was fabricated alongside it.
    const poolIds = new Set(pool.places.map((place) => place.placeId));
    const referenced = (result.value as {
      days: { items: { placeId?: string }[] }[];
    }).days
      .flatMap((day) => day.items)
      .flatMap((item) => (item.placeId ? [item.placeId] : []));

    expect(referenced.length).toBeGreaterThan(0);
    for (const placeId of referenced) expect(poolIds.has(placeId)).toBe(true);
  });
});

describe.skipIf(configured)("live Gemini structured generation", () => {
  it("skips cleanly with no key configured", () => {
    // Not a silent pass: the whole suite is one visible skip, and the project's
    // keyless path is covered by the unit suite.
    expect(config.gemini).toBeNull();
  });
});
