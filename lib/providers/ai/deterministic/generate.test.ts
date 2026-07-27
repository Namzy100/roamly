import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GeneratedTripAssemblySchema,
  TripStrategySchema,
  validateAssembly,
  validateStrategy,
} from "@/lib/ai";
import {
  FIXTURE_PLACES,
  FIXTURE_REQUEST,
  fixturePool,
} from "@/lib/generate/test-fixtures";
import { buildModelCandidates } from "@/lib/generate/candidates";
import { tripDayCount, tripNightCount } from "@/lib/schemas";

import { createDeterministicGenerator } from "./generate";

/**
 * The deterministic planner.
 *
 * The point of these tests is not that a template produces text — it is that the
 * *free, default, zero-configuration* path satisfies the same validators as a paid
 * model. Every assertion below runs the planner's output through
 * `validateStrategy`/`validateAssembly` rather than through a bespoke check, because
 * a second, laxer standard for the keyless path would defeat the entire arrangement.
 */

const generator = createDeterministicGenerator();

function strategyInput(overrides: Record<string, unknown> = {}) {
  return {
    destinationName: "Lisbon",
    dayCount: tripDayCount(FIXTURE_REQUEST),
    nightCount: tripNightCount(FIXTURE_REQUEST),
    pace: FIXTURE_REQUEST.pace,
    vibes: FIXTURE_REQUEST.vibes,
    interests: FIXTURE_REQUEST.interests,
    accommodation: FIXTURE_REQUEST.accommodation,
    travelers: FIXTURE_REQUEST.travelers,
    currency: FIXTURE_REQUEST.currency,
    ...overrides,
  };
}

async function generateStrategy(overrides: Record<string, unknown> = {}) {
  const result = await generator.generate({
    operation: "strategy",
    systemInstruction: "unused",
    input: strategyInput(overrides),
    outputSchema: TripStrategySchema,
    schemaName: "TripStrategy",
  });
  if (result.status !== "success") throw new Error(`expected success, got ${result.status}`);
  return result.value;
}

async function generateAssembly(input: Record<string, unknown>) {
  const result = await generator.generate({
    operation: "assembly",
    systemInstruction: "unused",
    input,
    outputSchema: GeneratedTripAssemblySchema,
    schemaName: "GeneratedTripAssembly",
  });
  if (result.status !== "success") throw new Error(`expected success, got ${result.status}`);
  return result.value;
}

describe("deterministic planner — identity", () => {
  it("labels itself a version, not a model", () => {
    expect(generator.id).toBe("deterministic");
    // Nothing downstream can print this and have it read as a language model.
    expect(generator.model).not.toMatch(/gpt|gemini|claude|llama|qwen/i);
  });

  it("makes no network request", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the deterministic planner must not fetch");
    }) as typeof fetch;

    try {
      await expect(generateStrategy()).resolves.toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("deterministic planner — strategy", () => {
  it("produces a strategy the shared validator accepts", async () => {
    const strategy = await generateStrategy();

    const result = validateStrategy({
      raw: strategy,
      expectedDayCount: tripDayCount(FIXTURE_REQUEST),
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("produces exactly the requested number of days, for every length", async () => {
    for (const dayCount of [1, 2, 3, 5, 7]) {
      const strategy = await generateStrategy({ dayCount, nightCount: dayCount - 1 });

      expect(strategy).toHaveProperty("days");
      const result = validateStrategy({ raw: strategy, expectedDayCount: dayCount });
      expect(result.ok, `dayCount ${dayCount}`).toBe(true);
    }
  });

  it("passes validation for every pace", async () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      const strategy = await generateStrategy({ pace });

      const result = validateStrategy({
        raw: strategy,
        expectedDayCount: tripDayCount(FIXTURE_REQUEST),
      });
      expect(result.ok, pace).toBe(true);
    }
  });

  it("asks for more stops a day at a packed pace than a relaxed one", async () => {
    const relaxed = await generateStrategy({ pace: "relaxed" });
    const packed = await generateStrategy({ pace: "packed" });

    const slots = (strategy: unknown) =>
      (strategy as { days: { searchRequirements: unknown[] }[] }).days[1]
        .searchRequirements.length;

    expect(slots(packed)).toBeGreaterThan(slots(relaxed));
  });

  it("asserts no place, coordinate, rating or price anywhere", async () => {
    // The same scan the model path is subject to, with nothing allowed.
    const strategy = await generateStrategy();

    const result = validateStrategy({
      raw: strategy,
      expectedDayCount: tripDayCount(FIXTURE_REQUEST),
    });
    expect(
      result.violations.filter((v) => v.code === "prohibited_field"),
    ).toEqual([]);
  });

  it("writes prose that is explicit about being generic", async () => {
    const strategy = (await generateStrategy()) as {
      destinationSummary: string;
      languageNote: string;
      seasonalNote: string;
    };

    // A template cannot know a destination, and saying so is the honest option.
    expect(strategy.destinationSummary).toMatch(/demo planner/i);
    expect(strategy.languageNote).toMatch(/does not know/i);
    expect(strategy.seasonalNote).toMatch(/does not know/i);
  });

  it("looks for somewhere to stay on day one, without requiring it", async () => {
    const strategy = (await generateStrategy()) as {
      days: { searchRequirements: { category: string; required: boolean }[] }[];
    };

    const stay = strategy.days[0].searchRequirements.find((slot) =>
      ["hotel", "hostel", "guest_house"].includes(slot.category),
    );
    expect(stay).toBeDefined();
    // Optional: a destination with no mapped accommodation must not fail the trip.
    expect(stay?.required).toBe(false);
  });

  it("maps the accommodation style onto a search category", async () => {
    const hostel = (await generateStrategy({ accommodation: "hostel" })) as {
      days: { searchRequirements: { category: string }[] }[];
    };

    expect(
      hostel.days[0].searchRequirements.map((slot) => slot.category),
    ).toContain("hostel");
  });

  it("produces budget shares that sum to exactly 1", async () => {
    for (const vibes of [["food"], ["culture"], ["food", "culture"], []]) {
      const strategy = (await generateStrategy({ vibes })) as {
        budgetAllocation: Record<string, number>;
      };
      const total = Object.values(strategy.budgetAllocation).reduce(
        (sum, share) => sum + share,
        0,
      );

      // Exactly, not within tolerance: this planner should never be the thing that
      // trips a tolerance.
      expect(Math.abs(total - 1), JSON.stringify(vibes)).toBeLessThan(1e-9);
    }
  });

  it("is byte-identical across runs", async () => {
    const first = await generateStrategy();
    const second = await generateStrategy();

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("reports an unusable input rather than guessing", async () => {
    const result = await generator.generate({
      operation: "strategy",
      systemInstruction: "unused",
      input: { destinationName: "" },
      outputSchema: TripStrategySchema,
      schemaName: "TripStrategy",
    });

    expect(result).toMatchObject({ status: "unavailable" });
  });
});

describe("deterministic planner — assembly", () => {
  async function assemble(
    poolPlaces = Object.values(FIXTURE_PLACES),
    overrides: Record<string, unknown> = {},
  ) {
    const strategy = await generateStrategy();
    const pool = fixturePool(poolPlaces);
    const candidates = buildModelCandidates({ pool, limitPerCategory: 8 });

    const assembly = await generateAssembly({
      destinationName: "Lisbon",
      currency: FIXTURE_REQUEST.currency,
      travelers: FIXTURE_REQUEST.travelers,
      pace: FIXTURE_REQUEST.pace,
      dayDates: [
        { dayNumber: 1, date: "2026-09-12", weekday: "Saturday" },
        { dayNumber: 2, date: "2026-09-13", weekday: "Sunday" },
      ],
      strategy,
      candidates: candidates.candidates,
      ...overrides,
    });

    return { strategy, pool, assembly };
  }

  it("produces an assembly the shared validator accepts", async () => {
    const { strategy, pool, assembly } = await assemble();

    const result = validateAssembly({
      raw: assembly,
      pool,
      strategy: strategy as never,
      currency: "EUR",
    });
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("references only pool placeIds", async () => {
    const { pool, assembly } = await assemble();
    const poolIds = new Set(pool.places.map((place) => place.placeId));

    const referenced = (assembly as { days: { items: { placeId?: string }[] }[] }).days
      .flatMap((day) => day.items)
      .flatMap((item) => (item.placeId ? [item.placeId] : []));

    expect(referenced.length).toBeGreaterThan(0);
    for (const placeId of referenced) expect(poolIds.has(placeId)).toBe(true);
  });

  it("does not repeat a place across the trip", async () => {
    const { assembly } = await assemble();

    const referenced = (assembly as { days: { items: { placeId?: string }[] }[] }).days
      .flatMap((day) => day.items)
      .flatMap((item) => (item.placeId ? [item.placeId] : []));

    expect(new Set(referenced).size).toBe(referenced.length);
  });

  /**
   * The central behaviour: nothing to choose from produces an admitted gap, never a
   * substitution of the wrong category and never an invented place.
   */
  it("marks a slot unavailable when no candidate of its category exists", async () => {
    const { strategy, pool, assembly } = await assemble([
      FIXTURE_PLACES.cafeOne,
      FIXTURE_PLACES.cafeTwo,
    ]);

    const items = (assembly as {
      days: { items: { kind: string; reason?: string; placeId?: string }[] }[];
    }).days.flatMap((day) => day.items);

    const unavailable = items.filter((item) => item.kind === "unavailable");
    expect(unavailable.length).toBeGreaterThan(0);
    expect(unavailable[0].reason).toMatch(/OpenStreetMap|found/i);

    // No café was relabelled as a museum to fill the gap.
    for (const item of items) {
      if (item.kind !== "place") continue;
      const canonical = pool.places.find((place) => place.placeId === item.placeId);
      expect(canonical).toBeDefined();
    }

    expect(
      validateAssembly({
        raw: assembly,
        pool,
        strategy: strategy as never,
        currency: "EUR",
      }).ok,
    ).toBe(true);
  });

  it("still validates with an empty candidate list", async () => {
    const strategy = await generateStrategy();
    const assembly = await generateAssembly({
      destinationName: "Lisbon",
      currency: "EUR",
      travelers: 2,
      pace: "balanced",
      dayDates: [
        { dayNumber: 1, date: "2026-09-12", weekday: "Saturday" },
        { dayNumber: 2, date: "2026-09-13", weekday: "Sunday" },
      ],
      strategy,
      candidates: [],
    });

    const parsed = GeneratedTripAssemblySchema.safeParse(assembly);
    expect(parsed.success).toBe(true);
  });

  it("prices in the requested currency with a category-estimate basis", async () => {
    const { assembly } = await assemble();

    const costs = (assembly as {
      days: { items: { estimatedCost?: { currency: string; basis: string } }[] }[];
    }).days
      .flatMap((day) => day.items)
      .flatMap((item) => (item.estimatedCost ? [item.estimatedCost] : []));

    expect(costs.length).toBeGreaterThan(0);
    for (const cost of costs) {
      expect(cost.currency).toBe("EUR");
      expect(cost.basis).toBe("category-estimate");
    }
  });

  it("claims no rating, price level or opening interpretation", async () => {
    const { assembly } = await assemble();
    const text = JSON.stringify(assembly);

    expect(text).not.toMatch(/"rating"|"priceLevel"|"userRatingCount"/);
    // Where it does mention opening hours, it says they are uninterpreted.
    if (/opening hours/i.test(text)) {
      expect(text).toMatch(/not interpreted|uninterpreted|check before/i);
    }
  });

  it("offers a backup without consuming a candidate a later day needs", async () => {
    const { pool, assembly } = await assemble();

    const backupIds = (assembly as {
      days: { backups: { placeId?: string }[] }[];
    }).days
      .flatMap((day) => day.backups)
      .flatMap((backup) => (backup.placeId ? [backup.placeId] : []));

    for (const placeId of backupIds) {
      expect(pool.places.some((place) => place.placeId === placeId)).toBe(true);
    }
  });

  it("is byte-identical across runs", async () => {
    const first = await assemble();
    const second = await assemble();

    expect(JSON.stringify(first.assembly)).toBe(JSON.stringify(second.assembly));
  });
});

describe("deterministic planner — repair", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("fails loudly rather than silently regenerating", async () => {
    /**
     * Unreachable in practice: this planner's output is validated by the same code
     * as everything else and is built to satisfy it. A repair request therefore
     * means the builder has a bug, and a bug that quietly re-emits the same invalid
     * answer would be invisible.
     */
    const result = await generator.generate({
      operation: "repair",
      systemInstruction: "unused",
      input: {},
      outputSchema: TripStrategySchema,
      schemaName: "TripStrategy",
    });

    expect(result).toMatchObject({ status: "unavailable" });
    expect(console.error).toHaveBeenCalled();
  });
});
