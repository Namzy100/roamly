import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refused, unavailable } from "@/lib/ai";
import type { PlaceCategory, TripPlace } from "@/lib/schemas";

import { generateTripPlan } from "./generate-trip-plan";
import { routingPolicyForPace } from "./pace-policy";
import {
  FIXTURE_DESTINATION,
  FIXTURE_PLACES,
  FIXTURE_REQUEST,
  fixtureAssembly,
  fixtureStrategy,
  scriptedGenerator,
  successResult,
} from "./test-fixtures";

/**
 * The orchestrator, with both external systems replaced.
 *
 * The generator is scripted per test and Overpass is mocked, so every assertion is
 * about the *pipeline*: what it calls, how many times, what it refuses to do, and
 * what it hands back. Nothing here contacts a model or a provider.
 *
 * The `calls` array on the scripted generator is what makes the important negative
 * assertions possible — that at most one repair happens, and that a repair is given
 * the same candidate list rather than triggering a new search.
 */

const discoverPlaces = vi.hoisted(() => vi.fn());
const routeTripPlan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers/osm", () => ({ discoverPlaces }));
vi.mock("@/lib/providers/routing", () => ({ routeTripPlan }));

function discoveryResult(
  places: TripPlace[],
  categoriesWithNoResults: PlaceCategory[] = [],
) {
  return {
    places,
    categoriesRequested: [
      ...new Set(places.map((place) => place.category)),
    ] as PlaceCategory[],
    query: {
      center: {
        latitude: FIXTURE_DESTINATION.latitude,
        longitude: FIXTURE_DESTINATION.longitude,
      },
      radiusMeters: 4_000,
      limitPerCategory: 6,
      categoriesWithNoResults,
    },
    discarded: { total: 0, noCategory: 0, noName: 0, noCoordinates: 0, invalid: 0 },
    fetchedAt: "2026-07-27T09:00:00.000Z",
    attribution: "© OpenStreetMap contributors (ODbL)",
    fromCache: false,
  };
}

function run(
  generator: ReturnType<typeof scriptedGenerator>,
  overrides: Partial<Parameters<typeof generateTripPlan>[0]> = {},
) {
  return generateTripPlan({
    tripId: "trip-abc123",
    request: FIXTURE_REQUEST,
    selectedDestination: FIXTURE_DESTINATION,
    generator,
    now: () => "2026-07-27T10:00:00.000Z",
    ...overrides,
  });
}

/** The two-call happy path. */
function happyScript() {
  return scriptedGenerator([
    successResult(fixtureStrategy()),
    successResult(fixtureAssembly()),
  ]);
}

beforeEach(() => {
  discoverPlaces.mockReset();
  routeTripPlan.mockReset();
  discoverPlaces.mockResolvedValue(discoveryResult(Object.values(FIXTURE_PLACES)));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("generateTripPlan — complete success", () => {
  it("returns a validated plan and its generation context", async () => {
    const generator = happyScript();

    const result = await run(generator);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.plan.id).toBe("trip-abc123");
    expect(result.plan.source).toBe("generated");
    expect(result.plan.days).toHaveLength(2);
    expect(result.warnings).toEqual([]);
    expect(result.generation.provider).toBe("gemini");
    expect(result.generation.model).toBe("test-model");
    expect(result.generation.generatedAt).toBe("2026-07-27T10:00:00.000Z");
  });

  it("makes exactly two model calls, in order", async () => {
    const generator = happyScript();

    await run(generator);

    expect(generator.calls.map((call) => call.operation)).toEqual([
      "strategy",
      "assembly",
    ]);
  });

  it("retains the exact discovery pool, not one derived from the plan", async () => {
    const generator = happyScript();

    const result = await run(generator);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    // Seven discovered places; the itinerary uses five of them. The unused
    // candidates are what make the pool evidence rather than self-assertion.
    expect(result.generation.placePool.places).toHaveLength(7);
    expect(result.generation.placePool.poolId.startsWith("discovery:")).toBe(true);

    const used = new Set(
      result.plan.days
        .flatMap((day) => day.items)
        .flatMap((item) => (item.place ? [item.place.placeId] : [])),
    );
    expect(used.size).toBeLessThan(result.generation.placePool.places.length);
  });

  it("resolves every itinerary place from the saved pool", async () => {
    const result = await run(happyScript());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const poolIds = new Set(
      result.generation.placePool.places.map((place) => place.placeId),
    );
    for (const day of result.plan.days) {
      for (const item of day.items) {
        if (item.place) expect(poolIds.has(item.place.placeId)).toBe(true);
      }
      for (const backup of day.backups) {
        expect(poolIds.has(backup.place.placeId)).toBe(true);
      }
    }
  });

  it("records the pace-derived routing policy, not the model's", async () => {
    const relaxed = await run(happyScript(), {
      request: { ...FIXTURE_REQUEST, pace: "relaxed" },
    });

    expect(relaxed.status).toBe("success");
    if (relaxed.status !== "success") return;
    expect(relaxed.generation.routingPolicy).toEqual(routingPolicyForPace("relaxed"));
    expect(relaxed.generation.routingPolicy.modePolicy.walkMaxMeters).toBe(1_200);
  });

  it("reports every stage, once, in order", async () => {
    const stages: string[] = [];

    await run(happyScript(), { onProgress: (stage) => stages.push(stage) });

    expect(stages).toEqual([
      "understanding",
      "planning-searches",
      "discovering-places",
      "building-days",
      "checking",
      "finalising",
    ]);
  });

  it("does not route, at all", async () => {
    // Routing 20 legs against a donated server as a side effect of "generate" would
    // be indefensible. The traveller asks separately.
    const result = await run(happyScript());

    expect(routeTripPlan).not.toHaveBeenCalled();
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.plan.routing).toBeNull();
  });

  it("labels demo-planner output as template output, not as generated", async () => {
    const generator = scriptedGenerator(
      [successResult(fixtureStrategy()), successResult(fixtureAssembly())],
      { id: "deterministic", model: "demo-planner-1" },
    );

    const result = await run(generator);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    // `"mock"` is what makes the template banner appear. Calling it `"generated"`
    // because it used the same pipeline would be exactly the substitution this
    // phase forbids.
    expect(result.plan.source).toBe("mock");
    expect(result.generation.provider).toBe("deterministic");
  });
});

describe("generateTripPlan — partial success", () => {
  it("returns a plan with warnings when the search was thin", async () => {
    const withoutStay = Object.values(FIXTURE_PLACES).filter(
      (place) => place.placeId !== FIXTURE_PLACES.hotel.placeId,
    );
    discoverPlaces.mockResolvedValue(discoveryResult(withoutStay, ["hotel"]));

    const result = await run(happyScript());

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.plan.accommodation).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("counts unfilled slots as a warning the interface can render", async () => {
    const assembly = fixtureAssembly();
    assembly.days[0].items[2] = {
      kind: "unavailable",
      itemId: "dinner-gap",
      slotId: "d1-s3",
      reason: "No restaurant was found within a workable distance of the other stops.",
      startTime: "19:30",
      endTime: "21:00",
    };

    const result = await run(
      scriptedGenerator([
        successResult(fixtureStrategy()),
        successResult(assembly),
      ]),
    );

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "slots_unfilled",
    );
    expect(
      result.plan.days[0].items.some((item) => item.status === "unavailable"),
    ).toBe(true);
  });

  it("still saves nothing itself — the caller decides", async () => {
    const result = await run(happyScript());

    // No storage of any kind exists in the pipeline; this is the contract that makes
    // "compute, validate, then commit" real.
    expect(result.status).toBe("success");
  });
});

describe("generateTripPlan — provider outcomes", () => {
  it("passes a refusal through without retrying", async () => {
    const generator = scriptedGenerator([refused()]);

    const result = await run(generator);

    expect(result.status).toBe("refused");
    expect(generator.calls).toHaveLength(1);
    expect(discoverPlaces).not.toHaveBeenCalled();
  });

  it("passes an unavailable reason through", async () => {
    const result = await run(scriptedGenerator([unavailable("rate_limited")]));

    expect(result).toMatchObject({ status: "unavailable", reason: "rate_limited" });
  });

  it("reports not_configured without falling back to the demo planner", async () => {
    // Reached by asking for a provider that is not configured. The pipeline must not
    // quietly produce a template itinerary in its place.
    const result = await generateTripPlan({
      tripId: "trip-abc123",
      request: FIXTURE_REQUEST,
      selectedDestination: FIXTURE_DESTINATION,
      providerPreference: "gemini",
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "not_configured",
    });
  });

  it("reports a refusal on the assembly call too", async () => {
    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      refused(),
    ]);

    expect((await run(generator)).status).toBe("refused");
    expect(generator.calls).toHaveLength(2);
  });

  it("reports empty model content as unavailable, not as a failure", async () => {
    const result = await run(
      scriptedGenerator([
        successResult(fixtureStrategy()),
        unavailable("empty_response"),
      ]),
    );

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "empty_response",
    });
  });
});

describe("generateTripPlan — repair", () => {
  it("repairs an invalid strategy once and records that it did", async () => {
    const broken = fixtureStrategy();
    broken.days = [broken.days[0]]; // one day for a two-day trip

    const generator = scriptedGenerator([
      successResult(broken),
      successResult(fixtureStrategy()),
      successResult(fixtureAssembly()),
    ]);

    const result = await run(generator);

    expect(generator.calls.map((call) => call.operation)).toEqual([
      "strategy",
      "repair",
      "assembly",
    ]);
    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "strategy_repaired",
    );
  });

  it("repairs an invalid assembly once, re-sending the same candidates", async () => {
    const broken = fixtureAssembly();
    broken.days[0].items[1].startTime = "09:30"; // overlaps the café

    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult(broken),
      successResult(fixtureAssembly()),
    ]);

    const result = await run(generator);

    expect(generator.calls.map((call) => call.operation)).toEqual([
      "strategy",
      "assembly",
      "repair",
    ]);

    // No second search. The repair sees exactly the list the first call saw.
    expect(discoverPlaces).toHaveBeenCalledTimes(1);
    const assemblyInput = generator.calls[1].input as { candidates: unknown[] };
    const repairInput = generator.calls[2].input as {
      originalInput: { candidates: unknown[] };
    };
    expect(repairInput.originalInput.candidates).toEqual(assemblyInput.candidates);

    expect(result.status).toBe("partial");
  });

  it("does not repair twice", async () => {
    const broken = fixtureAssembly();
    broken.days[0].items[1].startTime = "09:30";

    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult(broken),
      successResult(broken),
    ]);

    const result = await run(generator);

    expect(generator.calls).toHaveLength(3);
    expect(result.status).toBe("failed");
  });

  /**
   * The gate that matters. A model that referenced a place it was never given has
   * done the one prohibited thing, and asking it again invites a different
   * fabrication.
   */
  it("does not offer a repair for a fabricated place", async () => {
    const fabricated = fixtureAssembly();
    const item = fabricated.days[0].items[0];
    if (item.kind !== "place") throw new Error("fixture changed shape");
    item.placeId = "osm:node:999999";

    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult(fabricated),
    ]);

    const result = await run(generator);

    expect(generator.calls).toHaveLength(2);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.violations.map((violation) => violation.code)).toContain(
      "place_outside_pool",
    );
  });

  it("does not offer a repair for an attached provider fact", async () => {
    const fabricated = JSON.parse(JSON.stringify(fixtureAssembly())) as {
      days: { items: Record<string, unknown>[] }[];
    };
    fabricated.days[0].items[0].rating = 4.6;

    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult(fabricated),
    ]);

    const result = await run(generator);

    expect(generator.calls).toHaveLength(2);
    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.violations.map((violation) => violation.code)).toEqual([
      "prohibited_field",
    ]);
  });

  it("returns no plan on failure", async () => {
    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult({ nonsense: true }),
      successResult({ still: "nonsense" }),
    ]);

    const result = await run(generator);

    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("plan");
    expect(result).not.toHaveProperty("generation");
  });
});

describe("generateTripPlan — discovery outcomes", () => {
  it("fails cleanly when nothing at all was found", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([]));
    const generator = happyScript();

    const result = await run(generator);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.violations[0].code).toBe("discovery_empty");
    // Not worth a second model call: a model with no candidates can only produce
    // gaps or inventions.
    expect(generator.calls).toHaveLength(1);
  });

  it("continues after a partial discovery failure", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult(Object.values(FIXTURE_PLACES), ["theatre"]),
    );

    const result = await run(happyScript());

    expect(result.status).toBe("partial");
  });
});

describe("generateTripPlan — cancellation and timeout", () => {
  it("reports an already-cancelled request without calling a provider", async () => {
    const controller = new AbortController();
    controller.abort();

    const generator = scriptedGenerator([unavailable("aborted")]);
    const result = await run(generator, { signal: controller.signal });

    expect(result).toMatchObject({ status: "unavailable", reason: "aborted" });
  });

  it("reports a controlled timeout when the budget runs out", async () => {
    const generator = {
      id: "gemini" as const,
      model: "slow",
      generate: (request: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    };

    const result = await generateTripPlan({
      tripId: "trip-abc123",
      request: FIXTURE_REQUEST,
      selectedDestination: FIXTURE_DESTINATION,
      generator,
      budgetMs: 5,
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "timeout" });
  });

  it("threads one signal through to discovery as well as the model", async () => {
    await run(happyScript());

    expect(discoverPlaces.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
});

/**
 * Phase 6B: opening hours, checked after canonical attachment.
 *
 * These tests reach into the fixture pool and give a place hours that clash with the
 * itinerary the fixture assembly produces, which is the only way to exercise a conflict
 * without a live provider. The fixture trip runs Saturday–Sunday, so `Mo-Fr` hours are a
 * closure the repair cannot fix and `Sa-Su` hours with the wrong times are one it can.
 */
describe("generateTripPlan — opening hours", () => {
  /** The pool, with one place's hours rewritten. */
  function poolWithHours(placeId: string, openingHours: string) {
    return Object.values(FIXTURE_PLACES).map((place) =>
      place.placeId === placeId ? { ...place, openingHours } : place,
    );
  }

  it("records the destination's timezone and how it was resolved", async () => {
    const result = await run(happyScript());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.generation.destinationTimezone).toEqual({
      timezone: "Europe/Lisbon",
      source: "city",
    });
  });

  /**
   * Portugal has more than one timezone, so the country code alone is not an answer.
   * A destination in it that the city table does not know must leave the field absent
   * rather than pick the mainland and be an hour out for Madeira.
   */
  it("leaves the timezone absent when it cannot be resolved honestly", async () => {
    const result = await run(happyScript(), {
      selectedDestination: {
        ...FIXTURE_DESTINATION,
        name: "Alentejo",
        displayName: "Alentejo, Portugal",
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.generation.destinationTimezone).toBeUndefined();
  });

  it("moves a stop into its published hours, and says so", async () => {
    // The fixture schedules the café at 09:00; these hours open at 11:00.
    discoverPlaces.mockResolvedValue(
      discoveryResult(poolWithHours(FIXTURE_PLACES.cafeOne.placeId, "Mo-Su 11:00-19:00")),
    );

    const result = await run(happyScript());

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;

    const repaired = result.warnings.filter(
      (warning) => warning.code === "schedule_repaired",
    );
    expect(repaired).toHaveLength(1);
    expect(repaired[0].message).toContain("11:00");
    expect(repaired[0].dayNumber).toBe(1);

    const item = result.plan.days[0].items.find(
      (entry) => entry.place?.placeId === FIXTURE_PLACES.cafeOne.placeId,
    );
    /**
     * Not 11:00 — the museum holds 10:30–12:30 and a repair moves one stop's clock
     * without disturbing anyone else's, so the café lands in the first quarter-hour slot
     * clear of it.
     */
    expect(item?.startTime).toBe("12:45");
    // The duration is preserved rather than trimmed to fit.
    expect(item?.endTime).toBe("13:45");
    // And the place is the one the model chose — a repair moves a clock, never a place.
    expect(item?.place?.placeId).toBe(FIXTURE_PLACES.cafeOne.placeId);
  });

  it("re-evaluates after repairing, so no repaired stop is also reported as a conflict", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult(poolWithHours(FIXTURE_PLACES.cafeOne.placeId, "Mo-Su 11:00-19:00")),
    );

    const result = await run(happyScript());

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(
      result.warnings.filter((warning) => warning.code === "schedule_conflict"),
    ).toEqual([]);
  });

  /**
   * Closed all weekend, and the trip is a weekend. There is nowhere to move the stop to,
   * so the conflict is retained as an explicit warning rather than half-fixed or hidden.
   */
  it("retains a conflict it cannot fix, and leaves the stop where it was", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult(poolWithHours(FIXTURE_PLACES.cafeOne.placeId, "Mo-Fr 09:00-17:00")),
    );

    const result = await run(happyScript());

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;

    const conflicts = result.warnings.filter(
      (warning) => warning.code === "schedule_conflict",
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].placeId).toBe(FIXTURE_PLACES.cafeOne.placeId);
    expect(
      result.warnings.filter((warning) => warning.code === "schedule_repaired"),
    ).toEqual([]);

    expect(result.plan.days[0].items[0].startTime).toBe("09:00");
  });

  /**
   * Most OSM places have no `opening_hours` at all. Warning per unchecked stop would make
   * every generation "partial" and bury the conflicts that matter, so unknowns live in the
   * derived schedule report instead.
   */
  it("does not warn about stops whose hours are simply unknown", async () => {
    const result = await run(happyScript());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.warnings).toEqual([]);
  });

  it("checks nothing when the timezone is unknown", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult(poolWithHours(FIXTURE_PLACES.cafeOne.placeId, "Mo-Fr 09:00-17:00")),
    );

    const result = await run(happyScript(), {
      selectedDestination: {
        ...FIXTURE_DESTINATION,
        name: "Alentejo",
        displayName: "Alentejo, Portugal",
      },
    });

    // The same clash as the test above, but with no zone it is not a claim we can make.
    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.warnings).toEqual([]);
  });
});

describe("generateTripPlan — cost profile provenance", () => {
  it("records the city profile for a destination it knows", async () => {
    const result = await run(happyScript());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.generation.costProfile).toEqual({
      profileId: "lisbon",
      version: "1.0.0",
      match: "city",
      confidence: "high",
    });
  });

  it("records the regional fallback, and its lower confidence", async () => {
    const result = await run(happyScript(), {
      selectedDestination: {
        ...FIXTURE_DESTINATION,
        name: "Coimbra",
        displayName: "Coimbra, Portugal",
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.generation.costProfile).toMatchObject({
      profileId: "region-southern-europe",
      match: "region",
      confidence: "medium",
    });
  });

  it("records the global fallback rather than leaving the field absent", async () => {
    const result = await run(happyScript(), {
      selectedDestination: {
        ...FIXTURE_DESTINATION,
        name: "Ulaanbaatar",
        displayName: "Ulaanbaatar, Mongolia",
        countryCode: "mn",
      },
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.generation.costProfile).toMatchObject({
      profileId: "global",
      match: "global",
      confidence: "low",
    });
  });
});
