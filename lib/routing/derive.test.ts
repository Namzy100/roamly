import { describe, expect, it } from "vitest";

import type { ItineraryItem, TripPlace } from "@/lib/schemas";

import { deriveDayLegs, deriveLegsFromPlaces } from "./derive";
import { DEFAULT_MODE_POLICY } from "./mode-policy";

/**
 * Itinerary → legs, without a network.
 *
 * These are the rules that decide what we ask a donated server for, so they are
 * worth pinning precisely: what is skipped, what stays adjacent after skipping,
 * and that nothing here reorders, invents or mutates.
 */

function place(slug: string, lat: number, lng: number): TripPlace {
  return {
    placeId: `mock_${slug}`,
    name: slug,
    category: "attraction",
    coordinates: { lat, lng },
    source: {
      provider: "mock",
      canonicalId: `mock_${slug}`,
      attribution: "Sample data",
    },
  };
}

/** Four points in Baixa, each ~250 m from the last — comfortably walkable. */
const A = place("a", 38.7100, -9.1400);
const B = place("b", 38.7120, -9.1380);
const C = place("c", 38.7140, -9.1360);
const D = place("d", 38.7160, -9.1340);
/** Sintra — ~25 km out, so the mode policy will not walk to it. */
const FAR = place("far", 38.7979, -9.3907);

const STAY = place("stay", 38.7090, -9.1410);

function item(
  id: string,
  tripPlace: TripPlace | null,
  status: ItineraryItem["status"] = "confirmed",
): ItineraryItem {
  return {
    locked: false,
    id,
    order: 0,
    kind: "attraction",
    mealType: null,
    title: id,
    rationale: "because",
    status,
    place: tripPlace,
    startTime: "10:00",
    endTime: "11:00",
    estimatedCost: 0,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
  };
}

describe("deriveDayLegs", () => {
  it("produces one leg per consecutive pair", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", B), item("3", C)],
    });

    expect(legs).toHaveLength(2);
    expect(legs[0].fromPlaceId).toBe(A.placeId);
    expect(legs[0].toPlaceId).toBe(B.placeId);
    expect(legs[1].fromPlaceId).toBe(B.placeId);
    expect(legs[1].toPlaceId).toBe(C.placeId);
  });

  it("creates no leg for a single-stop day", () => {
    expect(deriveDayLegs({ dayNumber: 1, items: [item("1", A)] })).toEqual([]);
  });

  it("creates no leg for an empty day", () => {
    expect(deriveDayLegs({ dayNumber: 1, items: [] })).toEqual([]);
  });

  it("skips unavailable items and joins across them", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", B, "unavailable"), item("3", C)],
    });

    // A→C, not A→B→C. Stop 2 is not happening, so the traveller really does go
    // straight from 1 to 3.
    expect(legs).toHaveLength(1);
    expect(legs[0].fromPlaceId).toBe(A.placeId);
    expect(legs[0].toPlaceId).toBe(C.placeId);
  });

  it("skips placeless blocks", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", null), item("3", C)],
    });

    expect(legs).toHaveLength(1);
    expect(legs[0].toPlaceId).toBe(C.placeId);
  });

  it("never fabricates a coordinate for a skipped item", () => {
    const legs = deriveDayLegs({ dayNumber: 1, items: [item("1", null), item("2", null)] });
    expect(legs).toEqual([]);
  });

  it("preserves stop order exactly", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", C), item("2", A), item("3", B)],
    });

    // Deliberately out of geographic order. Nothing here optimises a route.
    expect(legs.map((leg) => leg.fromPlaceId)).toEqual([C.placeId, A.placeId]);
  });

  it("does not mutate the items it was given", () => {
    const items = [item("1", A), item("2", B)];
    const snapshot = JSON.parse(JSON.stringify(items));

    deriveDayLegs({ dayNumber: 1, items });

    expect(items).toEqual(snapshot);
  });

  it("excludes the accommodation by default", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", B)],
      accommodation: STAY,
    });

    expect(legs).toHaveLength(1);
    expect(legs[0].fromPlaceId).toBe(A.placeId);
  });

  it("brackets the day with the accommodation when asked", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", B)],
      accommodation: STAY,
      includeAccommodation: true,
    });

    // stay → A → B → stay
    expect(legs).toHaveLength(3);
    expect(legs[0].fromPlaceId).toBe(STAY.placeId);
    expect(legs[2].toPlaceId).toBe(STAY.placeId);
    // The outbound and return legs must have distinct ids.
    expect(new Set(legs.map((leg) => leg.id)).size).toBe(3);
  });

  it("assigns a walk mode to short hops", () => {
    const legs = deriveDayLegs({ dayNumber: 1, items: [item("1", A), item("2", B)] });
    expect(legs[0].mode).toBe("walk");
  });

  it("drops a leg the policy declines to choose a mode for", () => {
    // A 25 km hop with driving disallowed in the middle band still exceeds the
    // drive threshold, so it resolves; a 4 km one does not.
    const middleBand = place("mid", 38.7400, -9.1000);
    const legs = deriveDayLegs({ dayNumber: 1, items: [item("1", A), item("2", middleBand)] });

    expect(legs).toEqual([]);
  });

  it("drives a long hop", () => {
    const legs = deriveDayLegs({ dayNumber: 1, items: [item("1", A), item("2", FAR)] });

    expect(legs).toHaveLength(1);
    expect(legs[0].mode).toBe("drive");
  });

  it("applies a forced mode to every leg", () => {
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", B), item("3", FAR)],
      modePolicy: { ...DEFAULT_MODE_POLICY, forcedMode: "bicycle" },
    });

    expect(legs.map((leg) => leg.mode)).toEqual(["bicycle", "bicycle"]);
  });

  it("records the straight-line distance without presenting it as travel", () => {
    const legs = deriveDayLegs({ dayNumber: 1, items: [item("1", A), item("2", B)] });

    expect(legs[0].straightLineMeters).toBeGreaterThan(0);
    // It lives on the leg for mode selection and diagnostics only; the routed
    // distance arrives separately and will be larger.
    expect(legs[0]).not.toHaveProperty("distanceMeters");
  });

  it("builds each leg id from day, both item ids and the mode", () => {
    const legs = deriveDayLegs({ dayNumber: 3, items: [item("1", A), item("2", B)] });
    expect(legs[0].id).toBe("day:3:from:1:to:2:mode:walk");
    expect(legs[0].dayNumber).toBe(3);
  });

  it("collapses two stops at effectively the same point", () => {
    // ~4 m apart: one location listed twice, not a journey. Routing it would
    // return a zero-distance result, which the routed arm forbids.
    const nearlyA = place("a2", 38.71003, -9.14002);
    const legs = deriveDayLegs({
      dayNumber: 1,
      items: [item("1", A), item("2", nearlyA), item("3", B)],
    });

    expect(legs).toHaveLength(1);
    expect(legs[0].fromItemId).toBe("2");
    expect(legs[0].toItemId).toBe("3");
  });
});

describe("deriveLegsFromPlaces", () => {
  it("follows the same rules as the itinerary path", () => {
    const legs = deriveLegsFromPlaces([A, B, C]);

    expect(legs).toHaveLength(2);
    expect(legs.map((leg) => leg.mode)).toEqual(["walk", "walk"]);
  });

  it("creates no leg from a single place", () => {
    expect(deriveLegsFromPlaces([A])).toEqual([]);
  });

  it("gives the same place visited twice distinct leg identities", () => {
    const legs = deriveLegsFromPlaces([A, B, A]);

    expect(legs).toHaveLength(2);
    expect(new Set(legs.map((leg) => leg.id)).size).toBe(2);
  });

  it("does not mutate the array it was given", () => {
    const places = [A, B, C, D];
    const snapshot = [...places];

    deriveLegsFromPlaces(places);

    expect(places).toEqual(snapshot);
  });
});
