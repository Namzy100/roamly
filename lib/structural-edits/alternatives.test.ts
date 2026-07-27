import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_SPARE_CAFE,
  fixtureSavedPlan,
  generationWithSpare,
} from "@/lib/refinement/test-fixtures";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";

import { alternativesForItem } from "./alternatives";
import { applyStructuralCommand } from "./dispatch";

/**
 * What the swap picker is allowed to offer.
 *
 * The property worth pinning down is the one that makes a picker trustworthy: **every option it
 * lists can actually be selected**. A picker showing something the applier refuses is worse than a
 * picker showing nothing, because the traveller only finds out after committing to a choice.
 *
 * The fixture pool holds exactly seven places and the fixture itinerary uses all seven, so the
 * default pool offers nothing — `generationWithSpare()` adds one unused café, which is the
 * alternative `cafe-one` should be offered.
 */

const TIMEZONE = "Europe/Lisbon";

function alternativesFor(
  itemId: string,
  options: { plan?: TripPlan; generation?: TripGenerationContext } = {},
) {
  return alternativesForItem({
    plan: options.plan ?? fixtureSavedPlan(),
    generation: options.generation ?? generationWithSpare(),
    dayNumber: 1,
    itemId,
    timezone: TIMEZONE,
  });
}

describe("alternativesForItem", () => {
  it("offers an unused place of the same category", () => {
    expect(alternativesFor("cafe-one").map((place) => place.placeId)).toEqual([
      FIXTURE_SPARE_CAFE.placeId,
    ]);
  });

  /**
   * The pool is evidence, not a menu.
   *
   * Every place in the default fixture pool is already in the itinerary, so there is nothing free
   * to swap to — and an empty list is the honest answer rather than a reason to relax the filter.
   */
  it("offers nothing when the plan already uses every place in the pool", () => {
    expect(
      alternativesFor("cafe-one", { generation: FIXTURE_GENERATION }),
    ).toEqual([]);
  });

  /** A café is not an alternative to a museum. A swap replaces like with like. */
  it("never crosses category", () => {
    for (const place of alternativesFor("museum-one")) {
      expect(place.category).toBe("museum");
    }
    expect(alternativesFor("museum-one")).toEqual([]);
  });

  /** A stop with no place has no category, so there is nothing it could be swapped to. */
  it("offers nothing for a stop with no place", () => {
    const plan = fixtureSavedPlan();
    const placeless: TripPlan = {
      ...plan,
      days: plan.days.map((day) =>
        day.dayNumber === 1
          ? {
              ...day,
              items: day.items.map((item) =>
                item.id === "cafe-one" ? { ...item, place: null } : item,
              ),
            }
          : day,
      ),
    };

    expect(alternativesFor("cafe-one", { plan: placeless })).toEqual([]);
  });

  /** A locked stop is not editable, so it has no alternatives to offer. */
  it("offers nothing for a locked stop", () => {
    const plan = fixtureSavedPlan();
    const locked: TripPlan = {
      ...plan,
      days: plan.days.map((day) =>
        day.dayNumber === 1
          ? {
              ...day,
              items: day.items.map((item) =>
                item.id === "cafe-one" ? { ...item, locked: true } : item,
              ),
            }
          : day,
      ),
    };

    expect(alternativesFor("cafe-one", { plan: locked })).toEqual([]);
  });

  it("offers nothing for a trip with no generation context", () => {
    expect(
      alternativesForItem({
        plan: fixtureSavedPlan(),
        generation: null,
        dayNumber: 1,
        itemId: "cafe-one",
      }),
    ).toEqual([]);
  });

  it("offers nothing for an item that is not on the day", () => {
    expect(alternativesFor("no-such-item")).toEqual([]);
  });

  it("honours the limit", () => {
    expect(
      alternativesForItem({
        plan: fixtureSavedPlan(),
        generation: generationWithSpare(),
        dayNumber: 1,
        itemId: "cafe-one",
        timezone: TIMEZONE,
        limit: 0,
      }),
    ).toEqual([]);
  });

  /**
   * The contract that makes the picker honest.
   *
   * Every listed option is run through the real applier, and none may be refused. This is the test
   * that would fail if the derivation and `alternativeIsSelectable` ever drifted apart.
   */
  it("offers only places the applier accepts", () => {
    const plan = fixtureSavedPlan();
    const generation = generationWithSpare();
    const offered = alternativesFor("cafe-one", { plan, generation });

    expect(offered.length).toBeGreaterThan(0);

    for (const place of offered) {
      const result = applyStructuralCommand({
        plan,
        generation,
        revisionBefore: 3,
        timezone: TIMEZONE,
        command: {
          type: "select-alternative",
          dayNumber: 1,
          itemId: "cafe-one",
          alternativePlaceId: place.placeId,
        },
      });

      expect(result.status, `${place.placeId} was offered but refused`).not.toBe(
        "failed",
      );
    }
  });

  /**
   * A place the hours say is shut is ordered last rather than hidden.
   *
   * Deliberately unlike `hoursConflictCandidates`, which excludes it: there the point is escaping a
   * closure, here the traveller is choosing freely and may mean to move the stop afterwards.
   */
  it("keeps a closed place in the list", () => {
    const closed = generationWithSpare({ openingHours: "Mo-Su 20:00-23:00" });
    const offered = alternativesFor("cafe-one", { generation: closed });

    expect(offered.map((place) => place.placeId)).toContain(
      FIXTURE_SPARE_CAFE.placeId,
    );
  });
});
