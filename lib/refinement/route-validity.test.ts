import { describe, expect, it, vi } from "vitest";

import {
  FIXTURE_PLACES,
  fixtureOsmPlace,
  fixturePool,
} from "@/lib/generate/test-fixtures";
import { fingerprintForLeg } from "@/lib/routing";
import type {
  ItineraryDay,
  TravelSegment,
  TripGenerationContext,
  TripPlan,
} from "@/lib/schemas";
import { applyStructuralCommand } from "@/lib/structural-edits";

import { rekeyPlanSegments } from "./invalidate-routes";
import {
  expectedLegsFor,
  fixtureRoutedPlan,
  FIXTURE_GENERATION,
  FIXTURE_POLICY,
} from "./test-fixtures";

/**
 * Route-input validity, end to end.
 *
 * ## The defect
 *
 * Leg identity is built from **item ids**. `applySelectAlternative` keeps the item id when it swaps a stop's place, so that
 * the card stays put instead of appearing to vanish. `rekeyDaySegments` decided which stored results survive by asking
 * whether their leg id is still expected — and after a swap it still is.
 *
 * The consequence: the leg *into* the swapped stop kept a routed distance, duration and drawn geometry measured to a
 * different building. Nothing in the plan disagreed, and the traveller was shown a walking time for a journey nobody had
 * measured. The outbound leg was fine only because the applier happens to null it explicitly.
 *
 * These tests prove the inbound leg is now invalidated, and — just as importantly — that the legs which *should* survive
 * still do. A fix that cleared everything would pass the first assertion and make the feature useless.
 */

/** The fixture pool plus an unused museum, so a museum stop has something to be swapped to. */
const SPARE_MUSEUM = fixtureOsmPlace(
  "2003",
  "Museu Nacional do Azulejo Anexo",
  "museum",
  38.7255,
  -9.1141,
);

function generationWithSpareMuseum(): TripGenerationContext {
  return {
    ...FIXTURE_GENERATION,
    placePool: fixturePool([...Object.values(FIXTURE_PLACES), SPARE_MUSEUM]),
  };
}

/**
 * The fixture routed plan, with every segment stamped as if it had been routed from the plan's own legs.
 *
 * `fixtureRoutedPlan` hand-builds its segments and so carries no fingerprints — which is the *legacy* case, tested
 * separately below. Stamping them here is what lets the modern path be tested at all.
 */
function withFingerprints(plan: TripPlan): TripPlan {
  const days: ItineraryDay[] = plan.days.map((day) => {
    const legById = new Map(
      expectedLegsFor(plan, day.dayNumber).map((leg) => [leg.id, leg]),
    );

    return {
      ...day,
      items: day.items.map((item) => {
        if (!item.travelToNext) return item;
        const leg = legById.get(item.travelToNext.id);
        if (!leg) return item;

        return {
          ...item,
          travelToNext: {
            ...item.travelToNext,
            inputFingerprint: fingerprintForLeg(leg, FIXTURE_POLICY),
          } as TravelSegment,
        };
      }),
    };
  });

  return { ...plan, days };
}

/** Every leg id that still carries a stored result. */
function segmentIds(plan: TripPlan): string[] {
  return plan.days
    .flatMap((day) => day.items)
    .flatMap((item) => (item.travelToNext ? [item.travelToNext.id] : []))
    .sort();
}

/** The segment stored on a named item, or null. */
function segmentOn(plan: TripPlan, itemId: string): TravelSegment | null {
  for (const day of plan.days) {
    const item = day.items.find((entry) => entry.id === itemId);
    if (item) return item.travelToNext;
  }
  return null;
}

describe("a place swap invalidates the leg into the swapped stop", () => {
  /**
   * The regression test for the defect, through the real applier.
   *
   * `museum-one` keeps its item id, so its inbound leg id — owned by `cafe-one` — is still expected. Before the fingerprint,
   * `cafe-one` kept a routed walk measured to the *old* museum.
   */
  it("clears the inbound routed leg even though the item id survived", () => {
    const plan = withFingerprints(fixtureRoutedPlan());
    const inboundBefore = segmentOn(plan, "cafe-one");
    expect(inboundBefore?.status).toBe("routed");

    const result = applyStructuralCommand({
      plan,
      generation: generationWithSpareMuseum(),
      revisionBefore: 3,
      timezone: "Europe/Lisbon",
      command: {
        type: "select-alternative",
        dayNumber: 1,
        itemId: "museum-one",
        alternativePlaceId: SPARE_MUSEUM.placeId,
      },
    });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") throw new Error(result.errors[0].message);

    /* The item id is unchanged — which is exactly why the leg id could not catch this. */
    const swapped = result.plan.days[0].items.find(
      (item) => item.id === "museum-one",
    );
    expect(swapped?.place?.placeId).toBe(SPARE_MUSEUM.placeId);

    /* The stale inbound measurement is gone. */
    expect(segmentOn(result.plan, "cafe-one")).toBeNull();

    /* And it was reported, not dropped quietly. */
    expect(inboundBefore).not.toBeNull();
    expect(result.summary.invalidatedLegIds).toContain(
      (inboundBefore as TravelSegment).id,
    );
  });

  /** Legs nowhere near the swap keep their measurements — a fix that cleared everything would be no fix. */
  it("leaves unaffected legs alone", () => {
    const plan = withFingerprints(fixtureRoutedPlan());
    const dayTwoBefore = segmentIds(plan).filter((id) => id.startsWith("day:2:"));

    const result = applyStructuralCommand({
      plan,
      generation: generationWithSpareMuseum(),
      revisionBefore: 3,
      timezone: "Europe/Lisbon",
      command: {
        type: "select-alternative",
        dayNumber: 1,
        itemId: "museum-one",
        alternativePlaceId: SPARE_MUSEUM.placeId,
      },
    });

    if (result.status === "failed") throw new Error(result.errors[0].message);

    expect(
      segmentIds(result.plan).filter((id) => id.startsWith("day:2:")),
    ).toEqual(dayTwoBefore);
  });
});

describe("re-keying decides validity from the inputs, not only the adjacency", () => {
  it("keeps every leg when nothing changed", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const rekeyed = rekeyPlanSegments({ plan, policy: FIXTURE_POLICY });

    expect(rekeyed.invalidatedLegIds).toEqual([]);
    expect(rekeyed.unverifiedLegIds).toEqual([]);
    expect(segmentIds(rekeyed.plan)).toEqual(segmentIds(plan));
  });

  /**
   * A time-only edit must not clear a route.
   *
   * No current routing policy depends on the time of day, so the router consumed nothing that changed. Invalidating here
   * would throw away real provider measurements every time somebody nudged a stop by five minutes.
   */
  it("does not invalidate on a time-only edit", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const retimed: TripPlan = {
      ...plan,
      days: plan.days.map((day) =>
        day.dayNumber === 1
          ? {
              ...day,
              items: day.items.map((item) =>
                item.id === "museum-one"
                  ? { ...item, startTime: "10:45", endTime: "12:45" }
                  : item,
              ),
            }
          : day,
      ),
    };

    expect(
      rekeyPlanSegments({ plan: retimed, policy: FIXTURE_POLICY })
        .invalidatedLegIds,
    ).toEqual([]);
  });

  /** A note or a title is editorial. Nothing a router read has changed. */
  it("does not invalidate on an unrelated textual edit", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const edited: TripPlan = {
      ...plan,
      days: plan.days.map((day) =>
        day.dayNumber === 1
          ? {
              ...day,
              items: day.items.map((item) =>
                item.id === "cafe-one"
                  ? {
                      ...item,
                      title: "A different title entirely",
                      rationale: "Rewritten.",
                      ...(item.travelToNext
                        ? {
                            travelToNext: {
                              ...item.travelToNext,
                              note: "Downhill most of the way.",
                            },
                          }
                        : {}),
                    }
                  : item,
              ),
            }
          : day,
      ),
    };

    expect(
      rekeyPlanSegments({ plan: edited, policy: FIXTURE_POLICY })
        .invalidatedLegIds,
    ).toEqual([]);
  });

  /** A policy change can change which mode a leg gets, so a route measured under the old policy cannot stand. */
  it("invalidates every leg when the routing policy changes", () => {
    const plan = withFingerprints(fixtureRoutedPlan());
    const before = segmentIds(plan);
    expect(before.length).toBeGreaterThan(0);

    const rekeyed = rekeyPlanSegments({
      plan,
      policy: { ...FIXTURE_POLICY, existingSegments: "refresh-all" },
    });

    expect(rekeyed.invalidatedLegIds.sort()).toEqual(before);
    expect(segmentIds(rekeyed.plan)).toEqual([]);
  });

  /** Reordering changes adjacencies, so the leg ids change and their results go with them. */
  it("still invalidates the right legs on a reorder", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const result = applyStructuralCommand({
      plan,
      generation: FIXTURE_GENERATION,
      revisionBefore: 3,
      timezone: "Europe/Lisbon",
      command: {
        type: "move-item",
        sourceDayNumber: 1,
        targetDayNumber: 1,
        itemId: "museum-one",
        /* Positions name a neighbour rather than an index, so a stale render cannot misplace a stop. */
        targetPosition: { kind: "before", itemId: "cafe-one" },
      },
    });

    if (result.status === "failed") throw new Error(result.errors[0].message);

    expect(result.summary.invalidatedLegIds.length).toBeGreaterThan(0);
    for (const legId of result.summary.invalidatedLegIds) {
      expect(legId.startsWith("day:1:")).toBe(true);
    }
  });

  /** Moving a stop to another day changes the day component of the leg id, and the days either side of it. */
  it("still invalidates the right legs across a day move", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const result = applyStructuralCommand({
      plan,
      generation: FIXTURE_GENERATION,
      revisionBefore: 3,
      timezone: "Europe/Lisbon",
      command: {
        type: "move-item",
        sourceDayNumber: 1,
        targetDayNumber: 2,
        itemId: "museum-one",
        targetPosition: { kind: "end" },
      },
    });

    if (result.status === "failed") throw new Error(result.errors[0].message);

    expect(result.summary.affectedDays).toEqual([1, 2]);
    expect(result.summary.invalidatedLegIds.length).toBeGreaterThan(0);
  });
});

describe("legacy records", () => {
  /**
   * A trip saved before fingerprints existed loads, keeps its routes, and says they cannot be proven.
   *
   * Clearing them would destroy real provider data to enforce a rule they predate; trusting them silently would keep exactly
   * the stale measurements this work exists to catch.
   */
  it("loads safely and reports its routes as unverified", () => {
    const legacy = fixtureRoutedPlan();
    expect(segmentIds(legacy).length).toBeGreaterThan(0);

    const rekeyed = rekeyPlanSegments({ plan: legacy, policy: FIXTURE_POLICY });

    expect(rekeyed.invalidatedLegIds).toEqual([]);
    expect(rekeyed.unverifiedLegIds.sort()).toEqual(segmentIds(legacy));
    expect(segmentIds(rekeyed.plan)).toEqual(segmentIds(legacy));
  });

  /** Even without a fingerprint, the swap is caught — place ids are on every segment ever written. */
  it("still invalidates a legacy leg whose place changed", () => {
    const result = applyStructuralCommand({
      plan: fixtureRoutedPlan(),
      generation: generationWithSpareMuseum(),
      revisionBefore: 3,
      timezone: "Europe/Lisbon",
      command: {
        type: "select-alternative",
        dayNumber: 1,
        itemId: "museum-one",
        alternativePlaceId: SPARE_MUSEUM.placeId,
      },
    });

    if (result.status === "failed") throw new Error(result.errors[0].message);

    expect(segmentOn(result.plan, "cafe-one")).toBeNull();
  });
});

describe("validation costs nothing", () => {
  /**
   * No provider call during validation.
   *
   * A validity check that costs a round trip is one nobody runs on every render — so this asserts the absence directly rather
   * than trusting the comment. `fetch` is stubbed to throw; a call would fail the test.
   */
  it("makes no network request", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const stub = vi.fn(() => {
      throw new Error("validation must not reach the network");
    });
    const original = globalThis.fetch;
    globalThis.fetch = stub as unknown as typeof fetch;

    try {
      rekeyPlanSegments({ plan, policy: FIXTURE_POLICY });
    } finally {
      globalThis.fetch = original;
    }

    expect(stub).not.toHaveBeenCalled();
  });

  /**
   * Undo and redo restore the exact route state.
   *
   * History stores whole plans, so this is a property of the data rather than of a replay: the fingerprints ride along inside
   * the stored plan, and a restored plan re-validates to exactly what it validated to before. The JSON round-trip stands in
   * for the `localStorage` one, which is where float precision could otherwise drift.
   */
  it("re-validates a restored plan identically", () => {
    const plan = withFingerprints(fixtureRoutedPlan());

    const first = rekeyPlanSegments({ plan, policy: FIXTURE_POLICY });
    const restored = JSON.parse(JSON.stringify(plan)) as TripPlan;
    const second = rekeyPlanSegments({ plan: restored, policy: FIXTURE_POLICY });

    expect(second.invalidatedLegIds).toEqual(first.invalidatedLegIds);
    expect(second.unverifiedLegIds).toEqual(first.unverifiedLegIds);
    expect(segmentIds(second.plan)).toEqual(segmentIds(first.plan));
  });
});
