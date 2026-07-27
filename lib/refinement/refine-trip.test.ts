import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { refused, unavailable } from "@/lib/ai";
import {
  FIXTURE_PLACES,
  cost,
  fixtureAssembly,
  fixtureOsmPlace,
  fixturePool,
  fixtureStrategy,
  scriptedGenerator,
  successResult,
} from "@/lib/generate/test-fixtures";
import { isRoutedSegment } from "@/lib/schemas";

import { refineTrip } from "./refine-trip";
import {
  FIXTURE_DEMO_GENERATION,
  FIXTURE_GENERATION,
  expectedLegsFor,
  fixtureRoutedPlan,
  fixtureSavedPlan,
} from "./test-fixtures";

/**
 * The orchestrator, with the planner scripted and every provider mocked.
 *
 * The assertions that matter most are negative: **no routing call**, **no discovery
 * call**, **exactly one model call**, and — above all — that a rejected refinement
 * returns no plan at all. That last one is the rollback guarantee: there is nothing to
 * restore because nothing was ever produced.
 */

const discoverPlaces = vi.hoisted(() => vi.fn());
const routeTripPlan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers/osm", () => ({ discoverPlaces }));
vi.mock("@/lib/providers/routing", () => ({ routeTripPlan }));

beforeEach(() => {
  discoverPlaces.mockReset();
  routeTripPlan.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

function run(
  generator: ReturnType<typeof scriptedGenerator>,
  command: Parameters<typeof refineTrip>[0]["command"],
  overrides: Partial<Parameters<typeof refineTrip>[0]> = {},
) {
  return refineTrip({
    plan: fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    command,
    revisionBefore: 3,
    generator,
    now: () => "2026-07-27T12:00:00.000Z",
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* replace-item                                                              */
/* -------------------------------------------------------------------------- */

describe("refineTrip — replace-item", () => {
  const selection = successResult({
    status: "selected",
    placeId: FIXTURE_PLACES.cafeTwo.placeId,
    description:
      "A short walk from the rest of the day and open at the same hour, so the schedule does not move.",
    estimatedCost: cost(16),
    reservationRecommended: false,
  });

  it("replaces the stop, attaches the canonical place, and summarises", async () => {
    const plan = fixtureSavedPlan();
    const target = plan.days[0].items[0];
    const generator = scriptedGenerator([selection]);

    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: target.id,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    const replaced = result.plan.days[0].items[0];
    expect(replaced.place).toEqual(FIXTURE_PLACES.cafeTwo);
    expect(result.summary.action).toBe("replace-item");
    expect(result.summary.removedItemIds).toEqual([target.id]);
    expect(result.summary.addedItemIds).toEqual([`${target.id}-r1`]);
    expect(result.summary.affectedDays).toEqual([1]);
    expect(result.summary.revisionBefore).toBe(3);
  });

  it("makes exactly one model call and no provider call", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([selection]);

    await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
    });

    expect(generator.calls.map((call) => call.operation)).toEqual(["refinement"]);
    // A refinement never routes and never searches.
    expect(routeTripPlan).not.toHaveBeenCalled();
    expect(discoverPlaces).not.toHaveBeenCalled();
  });

  it("offers only eligible candidates, excluding the current place and the day's others", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([selection]);

    await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
    });

    const input = generator.calls[0].input as {
      candidates: { placeId: string; category: string }[];
    };
    const offered = input.candidates.map((candidate) => candidate.placeId);

    expect(offered).not.toContain(FIXTURE_PLACES.cafeOne.placeId);
    expect(offered).toContain(FIXTURE_PLACES.cafeTwo.placeId);
    // Category is preserved: a café slot is not offered a museum.
    expect(
      input.candidates.every((candidate) => candidate.category === "cafe"),
    ).toBe(true);
  });

  it("invalidates the legs either side and reports them", async () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];
    const generator = scriptedGenerator([selection]);

    const result = await run(
      generator,
      { type: "replace-item", dayNumber: 1, itemId: leg.fromItemId },
      { plan },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.summary.invalidatedLegIds).toContain(leg.id);
    const anyGeometry = result.plan.days[0].items.some(
      (item) => item.travelToNext && isRoutedSegment(item.travelToNext),
    );
    expect(anyGeometry).toBe(false);
  });

  it("leaves an unaffected routed leg intact", async () => {
    const plan = fixtureRoutedPlan();
    const legs = expectedLegsFor(plan, 1);
    const routedLeg = legs[0];
    // Replace a stop on the *other* day, so day one's routed leg is untouched.
    const generator = scriptedGenerator([
      successResult({
        status: "selected",
        placeId: FIXTURE_PLACES.cafeOne.placeId,
        description:
          "The other café from the same search, a short walk from the day's stops.",
        estimatedCost: cost(14),
        reservationRecommended: false,
      }),
    ]);

    const result = await run(
      generator,
      { type: "replace-item", dayNumber: 2, itemId: plan.days[1].items[0].id },
      { plan },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.summary.invalidatedLegIds).not.toContain(routedLeg.id);
    const survivor = result.plan.days[0].items.find(
      (item) => item.travelToNext?.id === routedLeg.id,
    );
    expect(survivor).toBeDefined();
    expect(isRoutedSegment(survivor!.travelToNext!)).toBe(true);
  });

  /**
   * The unrepairable case. The model was handed the complete eligible list, so an id
   * outside it is a fabrication — and the trip is left exactly as it was.
   */
  it("fails without a plan when the model names an ineligible place", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([
      successResult({
        status: "selected",
        placeId: "osm:node:999999",
        description:
          "A place that was never in the candidate list handed to the planner.",
        estimatedCost: cost(20),
        reservationRecommended: false,
      }),
    ]);

    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain("place_outside_pool");
    expect(result).not.toHaveProperty("plan");
  });

  it("fails without a plan when the model attaches a provider fact", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([
      successResult({
        status: "selected",
        placeId: FIXTURE_PLACES.cafeTwo.placeId,
        description: "A café with a rating the planner has no way of knowing.",
        estimatedCost: cost(16),
        reservationRecommended: false,
        rating: 4.6,
      }),
    ]);

    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toEqual(["prohibited_field"]);
  });

  it("marks the slot unavailable when nothing eligible fits", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([
      successResult({
        status: "unavailable",
        reason:
          "The other café in the search is on the far side of the city from this day's stops.",
      }),
    ]);

    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
    });

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.plan.days[0].items[0].status).toBe("unavailable");
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "replacement_unavailable",
    );
  });

  it("verifies a cheaper request rather than trusting it", async () => {
    const plan = fixtureSavedPlan();
    const current = plan.days[0].items[0];
    const generator = scriptedGenerator([
      successResult({
        status: "selected",
        placeId: FIXTURE_PLACES.cafeTwo.placeId,
        description: "A café the planner claims is cheaper while pricing it higher.",
        estimatedCost: cost(current.estimatedCost + 50),
        reservationRecommended: false,
      }),
    ]);

    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: current.id,
      preferences: { cheaper: true },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain(
      "action_not_honoured",
    );
  });

  it("refuses to replace an unavailable slot or a placeless block", async () => {
    const plan = fixtureSavedPlan();
    const freeTime = plan.days[1].items.find((item) => item.place === null);
    expect(freeTime).toBeDefined();

    const generator = scriptedGenerator([]);
    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 2,
      itemId: freeTime!.id,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("item_not_replaceable");
    // Rejected before the model was consulted.
    expect(generator.calls).toHaveLength(0);
  });

  it("fails cleanly when nothing is eligible, without calling the planner", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([]);

    // Day one's museum has one alternative — which is already this day's backup, so
    // it is excluded and nothing remains.
    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[1].id,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("no_eligible_candidates");
    expect(generator.calls).toHaveLength(0);
  });

  it("records the refinement provider in the generation context", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([selection], {
      id: "gemini",
      model: "gemini-test",
    });

    const result = await run(generator, {
      type: "replace-item",
      dayNumber: 1,
      itemId: plan.days[0].items[0].id,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.generationContext.latestRefinement).toEqual({
      provider: "gemini",
      model: "gemini-test",
      action: "replace-item",
      refinedAt: "2026-07-27T12:00:00.000Z",
    });
    // The original generation provenance is not overwritten.
    expect(result.generationContext.provider).toBe("gemini");
    expect(result.generationContext.placePool).toEqual(
      FIXTURE_GENERATION.placePool,
    );
  });

  it("does not record a deterministic refinement as an AI one", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([selection], {
      id: "deterministic",
      model: "demo-planner-1",
    });

    const result = await run(
      generator,
      { type: "replace-item", dayNumber: 1, itemId: plan.days[0].items[0].id },
      { generation: FIXTURE_DEMO_GENERATION },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    // There is no model to attribute, and recording one would imply otherwise.
    expect(result.generationContext.latestRefinement).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* replace-backup                                                            */
/* -------------------------------------------------------------------------- */

describe("refineTrip — replace-backup", () => {
  /**
   * A pool with a third museum.
   *
   * The base fixture has exactly two, and both are already scheduled — one as day
   * one's stop and one as day two's — so nothing is eligible and the honest answer is
   * "no alternative". That is a real outcome and it has its own test; these need
   * something to actually choose.
   */
  const THIRD_MUSEUM = fixtureOsmPlace(
    "2003",
    "Museu de Marinha",
    "museum",
    38.6975,
    -9.2065,
  );
  const EXTENDED_GENERATION = {
    ...FIXTURE_GENERATION,
    placePool: fixturePool([...Object.values(FIXTURE_PLACES), THIRD_MUSEUM]),
  };

  it("replaces the backup and touches no route", async () => {
    const plan = fixtureRoutedPlan();
    const leg = expectedLegsFor(plan, 1)[0];
    const generator = scriptedGenerator([
      successResult({
        status: "selected",
        placeId: THIRD_MUSEUM.placeId,
        reason: "Indoors and closer to the day's other stops if the first is closed.",
      }),
    ]);

    const result = await run(
      generator,
      {
        type: "replace-backup",
        dayNumber: 1,
        backupId: plan.days[0].backups[0].id,
      },
      { plan, generation: EXTENDED_GENERATION },
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.plan.days[0].backups[0].place).toEqual(THIRD_MUSEUM);
    // A backup has no adjacency, so nothing was invalidated.
    expect(result.summary.invalidatedLegIds).toEqual([]);
    const survivor = result.plan.days[0].items.find(
      (item) => item.travelToNext?.id === leg.id,
    );
    expect(isRoutedSegment(survivor!.travelToNext!)).toBe(true);
  });

  it("rejects a backup outside the pool", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([
      successResult({
        status: "selected",
        placeId: "osm:node:424242",
        reason: "A place that was never offered as a candidate for this backup.",
      }),
    ]);

    const result = await run(
      generator,
      {
        type: "replace-backup",
        dayNumber: 1,
        backupId: plan.days[0].backups[0].id,
      },
      { generation: EXTENDED_GENERATION },
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain("place_outside_pool");
  });

  it("drops the card when no alternative exists", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([
      successResult({
        status: "unavailable",
        reason: "The search returned no other museum near this day's stops.",
      }),
    ]);

    const result = await run(
      generator,
      {
        type: "replace-backup",
        dayNumber: 1,
        backupId: plan.days[0].backups[0].id,
      },
      { generation: EXTENDED_GENERATION },
    );

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.plan.days[0].backups).toHaveLength(0);
  });

  it("reports no alternative when every place of that kind is already scheduled", async () => {
    const plan = fixtureSavedPlan();
    const generator = scriptedGenerator([]);

    // The base pool's two museums are both in the itinerary already.
    const result = await run(generator, {
      type: "replace-backup",
      dayNumber: 1,
      backupId: plan.days[0].backups[0].id,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("no_eligible_candidates");
    expect(generator.calls).toHaveLength(0);
  });

  it("fails for a backup that is not there", async () => {
    const generator = scriptedGenerator([]);

    const result = await run(generator, {
      type: "replace-backup",
      dayNumber: 1,
      backupId: "not-a-backup",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("backup_not_found");
  });
});

/* -------------------------------------------------------------------------- */
/* adjust-day                                                                */
/* -------------------------------------------------------------------------- */

describe("refineTrip — adjust-day", () => {
  function dayItems(plan: ReturnType<typeof fixtureSavedPlan>, dayNumber: number) {
    return plan.days.find((day) => day.dayNumber === dayNumber)!.items;
  }

  /** The day as the model would return it, keeping ids so nothing looks moved. */
  function echoDay(
    plan: ReturnType<typeof fixtureSavedPlan>,
    dayNumber: number,
    options: { drop?: string[] } = {},
  ) {
    const dropped = new Set(options.drop ?? []);
    return {
      status: "adjusted",
      dayNumber,
      summary:
        "The same day with one paid stop removed, keeping both meals where they were.",
      items: dayItems(plan, dayNumber)
        .filter((item) => !dropped.has(item.id))
        .map((item) =>
          item.place
            ? {
                kind: "place",
                itemId: item.id,
                placeId: item.place.placeId,
                category: item.place.category,
                mealType: item.mealType,
                startTime: item.startTime,
                endTime: item.endTime,
                title: item.title,
                description: item.rationale,
                estimatedCost: cost(item.estimatedCost),
                reservationRecommended: item.bookingRequired,
              }
            : {
                kind: "non-place",
                itemId: item.id,
                category: "free-time",
                startTime: item.startTime,
                endTime: item.endTime,
                title: item.title,
                description: item.rationale,
                estimatedCost: cost(0),
              },
        ),
      backups: [],
    };
  }

  it("makes a day cheaper and verifies that it did", async () => {
    const plan = fixtureSavedPlan();
    const museum = dayItems(plan, 1)[1];
    const generator = scriptedGenerator([
      successResult(echoDay(plan, 1, { drop: [museum.id] })),
    ]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.plan.days[0].dayTotal).toBeLessThan(plan.days[0].dayTotal);
    expect(result.summary.newEstimatedTotal).toBeLessThan(
      result.summary.previousEstimatedTotal,
    );
  });

  /**
   * The action's own promise, checked. A model can return a perfectly valid day that
   * costs more, and a button that says "cheaper" must not produce one.
   */
  it("rejects a cheaper day that got more expensive", async () => {
    const plan = fixtureSavedPlan();
    const echoed = echoDay(plan, 1);
    echoed.items = echoed.items.map((item) =>
      "estimatedCost" in item ? { ...item, estimatedCost: cost(200) } : item,
    );
    const generator = scriptedGenerator([successResult(echoed)]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain(
      "action_not_honoured",
    );
  });

  it("rejects a relaxed day that gained stops", async () => {
    const plan = fixtureSavedPlan();
    const echoed = echoDay(plan, 1);
    echoed.items = [
      ...echoed.items,
      {
        kind: "place",
        // The hotel is in the pool but is not scheduled on either day, so it is
        // genuinely eligible — the point of the test is the *count*, not membership.
        itemId: "extra-stop",
        placeId: FIXTURE_PLACES.hotel.placeId,
        category: "hotel",
        mealType: null,
        startTime: "15:00",
        endTime: "16:00",
        title: "One more stop",
        description: "An extra stop nobody asked for on a day meant to be quieter.",
        estimatedCost: cost(20),
        reservationRecommended: false,
      },
    ] as never;
    const generator = scriptedGenerator([successResult(echoed)]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "more-relaxed",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain(
      "action_not_honoured",
    );
  });

  it("rejects a packed day that exceeds the pace cap", async () => {
    const plan = fixtureSavedPlan();
    const echoed = echoDay(plan, 1);
    // Balanced allows five stops; ask for seven.
    echoed.items = [
      ...echoed.items,
      ...["museumTwo", "restaurantTwo", "cafeTwo", "hotel"].map((key, index) => ({
        kind: "place" as const,
        itemId: `extra-${index}`,
        placeId: (FIXTURE_PLACES as Record<string, { placeId: string; category: string }>)[key]
          .placeId,
        category: (FIXTURE_PLACES as Record<string, { category: string }>)[key]
          .category,
        mealType: null,
        startTime: `1${index}:00`,
        endTime: `1${index}:30`,
        title: `Extra ${index}`,
        description: "One of several stops crammed in beyond what the pace allows.",
        estimatedCost: cost(10),
        reservationRecommended: false,
      })),
    ] as never;
    const generator = scriptedGenerator([successResult(echoed)]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "more-packed",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(
      result.errors.some((error) =>
        ["stop_cap_exceeded", "schedule_invalid", "place_outside_pool"].includes(
          error.code,
        ),
      ),
    ).toBe(true);
  });

  it("rejects a day that lost a meal", async () => {
    const plan = fixtureSavedPlan();
    const breakfast = dayItems(plan, 1)[0];
    const generator = scriptedGenerator([
      successResult(echoDay(plan, 1, { drop: [breakfast.id] })),
    ]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain(
      "meal_coverage_lost",
    );
  });

  it("rejects overlapping times", async () => {
    const plan = fixtureSavedPlan();
    const echoed = echoDay(plan, 1);
    echoed.items = echoed.items.map((item, index) =>
      index === 1 ? { ...item, startTime: "09:30" } : item,
    ) as never;
    const generator = scriptedGenerator([successResult(echoed)]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain("schedule_invalid");
  });

  it("passes the day and eligible places, and keeps the currency", async () => {
    const plan = fixtureSavedPlan();
    const museum = dayItems(plan, 1)[1];
    const generator = scriptedGenerator([
      successResult(echoDay(plan, 1, { drop: [museum.id] })),
    ]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    const input = generator.calls[0].input as {
      currency: string;
      stopCap: number;
      items: unknown[];
      candidates: unknown[];
    };
    expect(input.currency).toBe("EUR");
    expect(input.stopCap).toBeGreaterThan(0);
    expect(input.items.length).toBe(dayItems(plan, 1).length);

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.plan.budget.currency).toBe("EUR");
  });

  it("reports an unfulfillable adjustment without changing anything", async () => {
    const generator = scriptedGenerator([
      successResult({
        status: "unavailable",
        reason:
          "This day is only meals and free time, so there is no paid activity to drop.",
      }),
    ]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.userMessage).toContain("only meals");
    expect(result).not.toHaveProperty("plan");
  });

  it("leaves the other day untouched", async () => {
    const plan = fixtureSavedPlan();
    const museum = dayItems(plan, 1)[1];
    const generator = scriptedGenerator([
      successResult(echoDay(plan, 1, { drop: [museum.id] })),
    ]);

    const result = await run(generator, {
      type: "adjust-day",
      dayNumber: 1,
      adjustment: "cheaper",
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.plan.days[1]).toEqual(plan.days[1]);
  });
});

/* -------------------------------------------------------------------------- */
/* regenerate-trip                                                           */
/* -------------------------------------------------------------------------- */

describe("refineTrip — regenerate-trip", () => {
  function regenerationScript() {
    return scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult(fixtureAssembly()),
    ]);
  }

  it("regenerates from the saved pool without any discovery", async () => {
    const generator = regenerationScript();

    const result = await run(generator, { type: "regenerate-trip" });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    // Pool-stable: no Overpass request, and the universe of allowed places is the
    // saved one.
    expect(discoverPlaces).not.toHaveBeenCalled();
    expect(result.generationContext.placePool).toEqual(
      FIXTURE_GENERATION.placePool,
    );
    expect(generator.calls.map((call) => call.operation)).toEqual([
      "strategy",
      "assembly",
    ]);
  });

  it("tells the strategy which categories the saved pool actually has", async () => {
    const generator = regenerationScript();

    await run(generator, { type: "regenerate-trip" });

    const input = generator.calls[0].input as { availableCategories?: string[] };
    expect(input.availableCategories).toEqual([
      "cafe",
      "hotel",
      "museum",
      "restaurant",
    ]);
  });

  it("preserves the destination, dates, party and currency", async () => {
    const plan = fixtureSavedPlan();
    const generator = regenerationScript();

    const result = await run(generator, { type: "regenerate-trip" });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.plan.id).toBe(plan.id);
    expect(result.plan.createdAt).toBe(plan.createdAt);
    expect(result.plan.destination.city).toBe(plan.destination.city);
    expect(result.plan.days.map((day) => day.date)).toEqual(
      plan.days.map((day) => day.date),
    );
    expect(result.plan.request).toEqual(plan.request);
  });

  it("clears every route and the routing state", async () => {
    const plan = fixtureRoutedPlan();
    const generator = regenerationScript();

    const result = await run(generator, { type: "regenerate-trip" }, { plan });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;

    expect(result.plan.routing).toBeNull();
    for (const day of result.plan.days) {
      for (const item of day.items) expect(item.travelToNext).toBeNull();
    }
    expect(result.summary.invalidatedLegIds.length).toBeGreaterThan(0);
  });

  it("passes preserve constraints to the planner and verifies them", async () => {
    const generator = regenerationScript();

    const result = await run(generator, {
      type: "regenerate-trip",
      preserve: { placeIds: [FIXTURE_PLACES.cafeOne.placeId] },
    });

    const assemblyInput = generator.calls[1].input as {
      preserve?: { placeIds?: string[] };
    };
    expect(assemblyInput.preserve?.placeIds).toEqual([
      FIXTURE_PLACES.cafeOne.placeId,
    ]);
    expect(result.status).toBe("success");
  });

  it("fails when a preserved place did not survive", async () => {
    const generator = regenerationScript();

    const result = await run(generator, {
      type: "regenerate-trip",
      // The fixture assembly does not include the hotel as a stop.
      preserve: { placeIds: [FIXTURE_PLACES.hotel.placeId] },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors.map((error) => error.code)).toContain(
      "preserve_violated",
    );
    expect(result).not.toHaveProperty("plan");
  });

  it("passes a refusal through and changes nothing", async () => {
    const generator = scriptedGenerator([refused()]);

    const result = await run(generator, { type: "regenerate-trip" });

    expect(result.status).toBe("refused");
    expect(result).not.toHaveProperty("plan");
  });

  it("passes an unavailable reason through", async () => {
    const generator = scriptedGenerator([unavailable("rate_limited")]);

    const result = await run(generator, { type: "regenerate-trip" });

    expect(result).toMatchObject({ status: "unavailable", reason: "rate_limited" });
  });

  it("fails when the regenerated itinerary is invalid", async () => {
    const generator = scriptedGenerator([
      successResult(fixtureStrategy()),
      successResult({ nonsense: true }),
      successResult({ still: "nonsense" }),
    ]);

    const result = await run(generator, { type: "regenerate-trip" });

    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("plan");
  });

  it("makes no routing call", async () => {
    const generator = regenerationScript();

    await run(generator, { type: "regenerate-trip" });

    expect(routeTripPlan).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* cancellation                                                              */
/* -------------------------------------------------------------------------- */

describe("refineTrip — cancellation and timeout", () => {
  it("reports a timeout and returns no plan", async () => {
    const plan = fixtureSavedPlan();
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

    const result = await refineTrip({
      plan,
      generation: FIXTURE_GENERATION,
      command: {
        type: "replace-item",
        dayNumber: 1,
        itemId: plan.days[0].items[0].id,
      },
      revisionBefore: 1,
      generator,
      budgetMs: 5,
    });

    expect(result).toMatchObject({ status: "unavailable", reason: "timeout" });
    expect(result).not.toHaveProperty("plan");
  });
});
