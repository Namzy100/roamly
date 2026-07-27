import { describe, expect, it } from "vitest";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";

import {
  deriveVisibleMapPlaces,
  isAccommodationSelection,
  reconcileSelection,
} from "./derive";
import {
  MOCK_STAY_PLACE_ID,
  testDay,
  testItem,
  testPlace,
  testPlan,
} from "./test-fixtures";

describe("deriveVisibleMapPlaces", () => {
  it("derives one marker per confirmed, placed stop plus the accommodation", () => {
    const plan = testPlan([
      testDay(1, [
        testItem({ id: "a", place: testPlace({ placeId: "pa" }) }),
        testItem({ id: "b", place: testPlace({ placeId: "pb" }) }),
      ]),
    ]);

    const places = deriveVisibleMapPlaces(plan, 1);

    expect(places).toHaveLength(3);
    expect(places.filter((place) => place.kind === "stop")).toHaveLength(2);
    expect(places.filter((place) => place.kind === "accommodation")).toHaveLength(
      1,
    );
  });

  it("excludes unavailable items", () => {
    const plan = testPlan([
      testDay(1, [
        testItem({ id: "a" }),
        testItem({ id: "b", status: "unavailable" }),
        testItem({ id: "c" }),
      ]),
    ]);

    const stops = deriveVisibleMapPlaces(plan, 1).filter(
      (place) => place.kind === "stop",
    );

    expect(stops.map((place) => place.itemId)).toEqual(["a", "c"]);
  });

  it("excludes items with no place", () => {
    const plan = testPlan([
      testDay(1, [
        testItem({ id: "a" }),
        testItem({ id: "rest", kind: "rest", place: null }),
      ]),
    ]);

    const stops = deriveVisibleMapPlaces(plan, 1).filter(
      (place) => place.kind === "stop",
    );

    expect(stops.map((place) => place.itemId)).toEqual(["a"]);
  });

  it("keeps the itinerary's numbering, leaving gaps where items are excluded", () => {
    const plan = testPlan([
      testDay(1, [
        testItem({ id: "a" }),
        testItem({ id: "b", status: "unavailable" }),
        testItem({ id: "c" }),
        testItem({ id: "d", place: null }),
        testItem({ id: "e" }),
      ]),
    ]);

    const stops = deriveVisibleMapPlaces(plan, 1).filter(
      (place) => place.kind === "stop",
    );

    // Cards are numbered 1..5; markers 2 and 4 are absent rather than renumbered,
    // so every marker still matches the card bearing the same number.
    expect(stops.map((place) => place.sequenceNumber)).toEqual([1, 3, 5]);
  });

  it("marks the accommodation distinctly and gives it no day", () => {
    const plan = testPlan([testDay(1, [testItem({ id: "a" })])]);

    const stay = deriveVisibleMapPlaces(plan, 1).find(
      (place) => place.kind === "accommodation",
    );

    expect(stay).toBeDefined();
    expect(stay?.dayNumber).toBeNull();
    expect(stay?.placeId).toBe(MOCK_STAY_PLACE_ID);
    // Namespaced so a marker click can never select a real itinerary card.
    expect(stay?.itemId.startsWith("accommodation:")).toBe(true);
  });

  it("omits the accommodation when asked", () => {
    const plan = testPlan([testDay(1, [testItem({ id: "a" })])]);

    const places = deriveVisibleMapPlaces(plan, 1, {
      includeAccommodation: false,
    });

    expect(places.every((place) => place.kind === "stop")).toBe(true);
  });

  it("filters to the active day", () => {
    const plan = testPlan([
      testDay(1, [testItem({ id: "d1a" }), testItem({ id: "d1b" })]),
      testDay(2, [testItem({ id: "d2a" })]),
    ]);

    const day2 = deriveVisibleMapPlaces(plan, 2).filter(
      (place) => place.kind === "stop",
    );

    expect(day2.map((place) => place.itemId)).toEqual(["d2a"]);
    expect(day2[0].dayNumber).toBe(2);
    // A single day numbers from 1, regardless of its position in the trip.
    expect(day2[0].sequenceNumber).toBe(1);
  });

  it("includes every day, numbered continuously, in the All Days view", () => {
    const plan = testPlan([
      testDay(1, [testItem({ id: "d1a" }), testItem({ id: "d1b" })]),
      testDay(2, [testItem({ id: "d2a" })]),
    ]);

    const stops = deriveVisibleMapPlaces(plan, "all").filter(
      (place) => place.kind === "stop",
    );

    expect(stops.map((place) => place.sequenceNumber)).toEqual([1, 2, 3]);
    expect(stops.map((place) => place.dayNumber)).toEqual([1, 1, 2]);
  });

  it("keeps both markers when two stops share one place", () => {
    // A market visited twice is two cards and must be two selectable markers.
    const shared = testPlace({ placeId: "same" });
    const plan = testPlan([
      testDay(1, [
        testItem({ id: "first", place: shared }),
        testItem({ id: "second", place: shared }),
      ]),
    ]);

    const stops = deriveVisibleMapPlaces(plan, 1).filter(
      (place) => place.kind === "stop",
    );

    expect(stops).toHaveLength(2);
    expect(stops.map((place) => place.placeId)).toEqual(["same", "same"]);
    expect(stops.map((place) => place.itemId)).toEqual(["first", "second"]);
  });

  it("derives the real Lisbon mock with 23 stops plus the stay", () => {
    const all = deriveVisibleMapPlaces(mockTripPlan, "all");
    expect(all.filter((place) => place.kind === "stop")).toHaveLength(23);
    expect(all).toHaveLength(24);
  });
});

describe("reconcileSelection", () => {
  it("keeps a selection that is still on the map", () => {
    const plan = testPlan([testDay(1, [testItem({ id: "a" })])]);
    const places = deriveVisibleMapPlaces(plan, 1);

    expect(reconcileSelection("a", places)).toBe("a");
  });

  it("drops a selection filtered away by a day change", () => {
    const plan = testPlan([
      testDay(1, [testItem({ id: "d1a" })]),
      testDay(2, [testItem({ id: "d2a" })]),
    ]);

    const day2Places = deriveVisibleMapPlaces(plan, 2);

    expect(reconcileSelection("d1a", day2Places)).toBeNull();
  });

  it("drops a selection pointing at an unavailable item", () => {
    const plan = testPlan([
      testDay(1, [testItem({ id: "a" }), testItem({ id: "b", status: "unavailable" })]),
    ]);

    const places = deriveVisibleMapPlaces(plan, 1);

    expect(reconcileSelection("b", places)).toBeNull();
  });

  it("keeps the accommodation selected across day changes", () => {
    const plan = testPlan([
      testDay(1, [testItem({ id: "d1a" })]),
      testDay(2, [testItem({ id: "d2a" })]),
    ]);

    const stayId = deriveVisibleMapPlaces(plan, 1).find(
      (place) => place.kind === "accommodation",
    )!.itemId;

    expect(reconcileSelection(stayId, deriveVisibleMapPlaces(plan, 2))).toBe(
      stayId,
    );
  });

  it("passes a null selection through", () => {
    expect(reconcileSelection(null, [])).toBeNull();
  });
});

describe("isAccommodationSelection", () => {
  it("recognises the namespaced accommodation id", () => {
    expect(isAccommodationSelection("accommodation:mock_hotel")).toBe(true);
  });

  it("rejects itinerary item ids and null", () => {
    expect(isAccommodationSelection("d1_i1_mock_place")).toBe(false);
    expect(isAccommodationSelection(null)).toBe(false);
  });
});
