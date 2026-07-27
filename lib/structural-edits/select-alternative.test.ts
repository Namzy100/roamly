import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_SPARE_CAFE,
  fixtureRoutedPlan,
  fixtureSavedPlan,
  generationWithSpare,
} from "@/lib/refinement/test-fixtures";
import type {
  ItineraryItem,
  TripGenerationContext,
  TripPlace,
  TripPlan,
} from "@/lib/schemas";

import {
  alternativeIsSelectable,
  applySelectAlternative,
} from "./select-alternative";
import type { StructuralEditResult } from "./types";
import { validatePlanMembership } from "./validate";

/**
 * The pool holds `osm:node:1001`/`1002` (cafés), `2001`/`2002` (museums), `3001`/`3002`
 * (restaurants) and `4001` (a hotel), and every one of them is already used by the itinerary or the
 * accommodation. `generationWithSpare()` adds `osm:node:1003`, a café nothing uses — which makes it
 * the only genuinely free swap target, and every other candidate a test of a refusal.
 */

const TIMEZONE = "Europe/Lisbon";
const SPARE = FIXTURE_SPARE_CAFE.placeId;

function poolPlace(generation: TripGenerationContext, placeId: string): TripPlace {
  const place = generation.placePool.places.find(
    (candidate) => candidate.placeId === placeId,
  );
  if (!place) throw new Error(`fixture pool has no ${placeId}`);
  return place;
}

function swap(input: {
  plan?: TripPlan;
  generation?: TripGenerationContext;
  dayNumber?: number;
  itemId: string;
  alternativePlaceId: string;
}): StructuralEditResult {
  return applySelectAlternative({
    plan: input.plan ?? fixtureSavedPlan(),
    generation: input.generation ?? generationWithSpare(),
    revisionBefore: 3,
    timezone: TIMEZONE,
    command: {
      type: "select-alternative",
      dayNumber: input.dayNumber ?? 1,
      itemId: input.itemId,
      alternativePlaceId: input.alternativePlaceId,
    },
  });
}

function planWith(itemId: string, patch: Partial<ItineraryItem>): TripPlan {
  const plan = fixtureSavedPlan();
  return {
    ...plan,
    days: plan.days.map((day) => ({
      ...day,
      items: day.items.map((item) =>
        item.id === itemId ? { ...item, ...patch } : item,
      ),
    })),
  };
}

function itemIn(result: StructuralEditResult, itemId: string): ItineraryItem {
  if (result.status === "failed") throw new Error("expected the edit to succeed");
  const found = result.plan.days
    .flatMap((day) => day.items)
    .find((item) => item.id === itemId);
  if (!found) throw new Error(`no item ${itemId}`);
  return found;
}

describe("applySelectAlternative", () => {
  it("attaches the pool's record, unchanged", () => {
    expect(
      itemIn(swap({ itemId: "cafe-one", alternativePlaceId: SPARE }), "cafe-one").place,
    ).toEqual(FIXTURE_SPARE_CAFE);
  });

  /**
   * The id survives the swap, unlike the refinement path's replacement. `commitStructuralEdit`
   * re-keys legs by *place* id and measures invalidation by diffing, so an item id carries no routing
   * meaning here — and keeping it means the card stays put and the summary reports one changed stop
   * rather than one vanishing and another appearing.
   */
  it("keeps the item id, and reports one changed stop", () => {
    const result = swap({ itemId: "cafe-one", alternativePlaceId: SPARE });
    if (result.status === "failed") throw new Error("expected success");

    expect(result.summary.action).toBe("select-alternative");
    expect(result.summary.changedItemIds).toEqual(["cafe-one"]);
    expect(result.summary.addedItemIds).toEqual([]);
    expect(result.summary.removedItemIds).toEqual([]);
  });

  it("keeps a meal's title and takes the place's name otherwise", () => {
    // `cafe-one` is breakfast, so its title names the occasion and stays.
    expect(
      itemIn(swap({ itemId: "cafe-one", alternativePlaceId: SPARE }), "cafe-one").title,
    ).toBe(fixtureSavedPlan().days[0].items[0].title);

    // An attraction's title *was* the old venue, so it becomes the new one's name.
    expect(
      itemIn(
        swap({
          plan: planWith("museum-one", { mealType: null }),
          itemId: "museum-one",
          alternativePlaceId: SPARE,
        }),
        "museum-one",
      ).title,
    ).toBe(FIXTURE_SPARE_CAFE.name);
  });

  it("keeps the times, and clears only the leg leaving the stop", () => {
    const result = swap({
      plan: fixtureRoutedPlan(),
      itemId: "cafe-one",
      alternativePlaceId: SPARE,
    });
    if (result.status === "failed") throw new Error("expected success");

    const item = itemIn(result, "cafe-one");
    expect(item.startTime).toBe("09:00");
    expect(item.endTime).toBe("10:00");
    expect(item.travelToNext).toBeNull();
    // The fixture's one routed leg started at this stop, so exactly one is invalidated.
    expect(result.summary.invalidatedLegIds).toHaveLength(1);
  });

  it("says nothing in the rationale beyond where the place came from", () => {
    const item = itemIn(
      swap({ itemId: "cafe-one", alternativePlaceId: SPARE }),
      "cafe-one",
    );

    expect(item.rationale).toContain("own search results");
    // No derived comparison is frozen into the saved plan, where it could go stale unnoticed.
    expect(item.rationale).not.toContain("closer");
    expect(item.rationale).not.toContain("cheaper");
  });

  /* -- the refusals, which are the point ---------------------------------- */

  it("refuses a place that is not in the active pool", () => {
    expect(
      swap({
        // The spare exists only in `generationWithSpare()`.
        generation: FIXTURE_GENERATION,
        itemId: "cafe-one",
        alternativePlaceId: SPARE,
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "place_outside_pool" }] });
  });

  it("refuses an invented place id outright, with no fallback lookup", () => {
    expect(
      swap({ itemId: "cafe-one", alternativePlaceId: "osm:node:999999" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "place_outside_pool" }] });
  });

  /**
   * The narrow half of the widened invariant: a retained place vouches only for the stops already
   * using it, and may never become a *new* selection.
   */
  it("refuses a retained place, with its own message", () => {
    const base = generationWithSpare();
    const retained: TripGenerationContext = {
      ...base,
      placePool: {
        ...base.placePool,
        places: base.placePool.places.filter((place) => place.placeId !== SPARE),
      },
      retainedPlaces: [
        {
          place: FIXTURE_SPARE_CAFE,
          retainedAt: "2026-07-01T00:00:00.000Z",
          reason: "missing-after-refresh",
        },
      ],
    };

    const result = swap({
      generation: retained,
      itemId: "cafe-one",
      alternativePlaceId: SPARE,
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("place_is_retained");
    expect(result.errors[0].message).toContain("no longer returns");
  });

  it("refuses a place the trip already uses somewhere else", () => {
    // `osm:node:2002` is `museum-two` on day two.
    expect(
      swap({ itemId: "museum-one", alternativePlaceId: "osm:node:2002" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "place_already_used" }] });
  });

  it("refuses the accommodation's own place", () => {
    const plan = fixtureSavedPlan();
    // Only meaningful if the fixture actually recommends somewhere to stay.
    expect(plan.accommodation).not.toBeNull();
    if (!plan.accommodation) return;

    expect(
      swap({
        itemId: "cafe-one",
        alternativePlaceId: plan.accommodation.place.placeId,
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "place_already_used" }] });
  });

  it("refuses the place already attached", () => {
    expect(
      swap({ itemId: "cafe-one", alternativePlaceId: "osm:node:1001" }),
    ).toMatchObject({ status: "failed", errors: [{ code: "no_change" }] });
  });

  it("refuses a stop with no place to swap", () => {
    expect(
      swap({ dayNumber: 2, itemId: "afternoon-open", alternativePlaceId: SPARE }),
    ).toMatchObject({ status: "failed", errors: [{ code: "item_has_no_place" }] });
  });

  it("refuses a locked stop, and a date-fixed one", () => {
    expect(
      swap({
        plan: planWith("cafe-one", { locked: true }),
        itemId: "cafe-one",
        alternativePlaceId: SPARE,
      }),
    ).toMatchObject({ status: "failed", errors: [{ code: "item_locked" }] });

    expect(
      swap({
        plan: planWith("cafe-one", { kind: "transport" }),
        itemId: "cafe-one",
        alternativePlaceId: SPARE,
      }),
    ).toMatchObject({
      status: "failed",
      errors: [{ code: "item_structurally_locked" }],
    });
  });

  it("refuses a day or a stop that is not part of the trip", () => {
    expect(
      swap({ dayNumber: 9, itemId: "cafe-one", alternativePlaceId: SPARE }),
    ).toMatchObject({ status: "failed", errors: [{ code: "day_not_found" }] });

    expect(swap({ itemId: "ghost", alternativePlaceId: SPARE })).toMatchObject({
      status: "failed",
      errors: [{ code: "item_not_found" }],
    });
  });

  /* -- money -------------------------------------------------------------- */

  /**
   * An estimate is a function of the destination profile and the *cost class*, never of the venue.
   * Both places here are cafés, so the class is unchanged and the figure must be too — anything else
   * would be money moving for a reason the traveller did not ask about.
   */
  it("leaves the estimate alone when the cost class does not change", () => {
    const before = fixtureSavedPlan().days[0].items[0];
    expect(
      itemIn(swap({ itemId: "cafe-one", alternativePlaceId: SPARE }), "cafe-one")
        .estimatedCost,
    ).toBe(before.estimatedCost);
  });

  it("keeps the day total consistent with its items", () => {
    const result = swap({ itemId: "cafe-one", alternativePlaceId: SPARE });
    if (result.status === "failed") throw new Error("expected success");

    const day = result.plan.days[0];
    expect(day.dayTotal).toBe(
      day.items.reduce((total, item) => total + item.estimatedCost, 0),
    );
  });

  /* -- the gate ----------------------------------------------------------- */

  it("produces a plan that still passes the membership check", () => {
    const result = swap({ itemId: "cafe-one", alternativePlaceId: SPARE });
    if (result.status === "failed") throw new Error("expected success");

    expect(
      validatePlanMembership({
        plan: result.plan,
        generation: result.generationContext,
      }),
    ).toEqual([]);
  });

  it("does not mutate the plan it was given", () => {
    const plan = fixtureSavedPlan();
    swap({ plan, itemId: "cafe-one", alternativePlaceId: SPARE });
    expect(plan.days[0].items[0].place?.placeId).toBe("osm:node:1001");
  });
});

/**
 * The predicate the alternatives list filters on. It must refuse exactly what the applier refuses,
 * or a card offers an option that fails when pressed.
 */
describe("alternativeIsSelectable", () => {
  const plan = fixtureSavedPlan();
  const generation = generationWithSpare();
  const item = plan.days[0].items[0];
  const spare = poolPlace(generation, SPARE);

  it("accepts a free pool member", () => {
    expect(alternativeIsSelectable({ plan, generation, item, place: spare })).toBe(
      true,
    );
  });

  it("refuses the place already attached", () => {
    expect(
      alternativeIsSelectable({
        plan,
        generation,
        item,
        place: poolPlace(generation, "osm:node:1001"),
      }),
    ).toBe(false);
  });

  it("refuses a place the trip already uses", () => {
    expect(
      alternativeIsSelectable({
        plan,
        generation,
        item,
        place: poolPlace(generation, "osm:node:2002"),
      }),
    ).toBe(false);
  });

  it("refuses both locks, and a place-less stop", () => {
    for (const patch of [
      { locked: true },
      { kind: "transport" as const },
      { place: null },
    ]) {
      expect(
        alternativeIsSelectable({
          plan,
          generation,
          item: { ...item, ...patch },
          place: spare,
        }),
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it("refuses a place outside the pool", () => {
    expect(
      alternativeIsSelectable({
        plan,
        generation: FIXTURE_GENERATION,
        item,
        place: FIXTURE_SPARE_CAFE,
      }),
    ).toBe(false);
  });
});
