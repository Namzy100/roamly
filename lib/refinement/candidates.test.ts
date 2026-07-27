import { describe, expect, it } from "vitest";

import { FIXTURE_PLACES, fixtureOsmPlace, fixturePool } from "@/lib/generate/test-fixtures";
import type { PlaceCategory } from "@/lib/schemas";

import {
  MAX_REFINEMENT_CANDIDATES,
  REPLACEMENT_RADIUS_METERS,
  deriveEligibleCandidates,
  filterForReplacement,
  orderCandidates,
  placesInUse,
} from "./candidates";
import { fixtureSavedPlan } from "./test-fixtures";

const POOL = fixturePool();

describe("deriveEligibleCandidates", () => {
  it("returns only pool members", () => {
    const eligible = deriveEligibleCandidates(POOL, {});
    const poolIds = new Set(POOL.places.map((place) => place.placeId));

    expect(eligible.places.length).toBeGreaterThan(0);
    for (const place of eligible.places) {
      expect(poolIds.has(place.placeId)).toBe(true);
    }
  });

  it("filters by category", () => {
    const eligible = deriveEligibleCandidates(POOL, { categories: ["cafe"] });

    expect(eligible.places.map((place) => place.category)).toEqual(["cafe", "cafe"]);
  });

  it("excludes the places it was told to", () => {
    const eligible = deriveEligibleCandidates(POOL, {
      categories: ["cafe"],
      excludePlaceIds: [FIXTURE_PLACES.cafeOne.placeId],
    });

    expect(eligible.places.map((place) => place.placeId)).toEqual([
      FIXTURE_PLACES.cafeTwo.placeId,
    ]);
  });

  it("bounds by distance from the anchor", () => {
    // MAAT is ~7 km west of the Azulejo museum, so a 2 km radius excludes it.
    const eligible = deriveEligibleCandidates(POOL, {
      categories: ["museum"],
      anchor: FIXTURE_PLACES.museumOne.coordinates,
      radiusMeters: 2_000,
    });

    expect(eligible.places.map((place) => place.placeId)).toEqual([
      FIXTURE_PLACES.museumOne.placeId,
    ]);
  });

  it("keeps a distant candidate when no radius is given", () => {
    const eligible = deriveEligibleCandidates(POOL, {
      categories: ["museum"],
      anchor: FIXTURE_PLACES.museumOne.coordinates,
    });

    expect(eligible.places).toHaveLength(2);
  });

  it("filters indoor and outdoor by kind of place", () => {
    const withGarden = fixturePool([
      ...Object.values(FIXTURE_PLACES),
      fixtureOsmPlace("7001", "Estufa Fria", "garden", 38.728, -9.154),
    ]);

    const indoor = deriveEligibleCandidates(withGarden, { indoor: true });
    const outdoor = deriveEligibleCandidates(withGarden, { indoor: false });

    expect(indoor.places.some((place) => place.category === "garden")).toBe(false);
    expect(outdoor.places.map((place) => place.category)).toEqual(["garden"]);
  });

  /**
   * The rule the module exists to hold. Any score we could compute from OSM tags
   * would be our opinion presented to a model as data.
   */
  it("invents no ranking, score or quality signal", () => {
    const eligible = deriveEligibleCandidates(POOL, {});

    for (const candidate of eligible.candidates as Record<string, unknown>[]) {
      for (const field of [
        "score",
        "rank",
        "relevance",
        "qualityScore",
        "popularity",
        "rating",
        "distanceMeters",
      ]) {
        expect(candidate[field], field).toBeUndefined();
      }
    }
  });

  it("caps the list and reports the truncation", () => {
    const many = fixturePool(
      Array.from({ length: MAX_REFINEMENT_CANDIDATES + 5 }, (_, index) =>
        fixtureOsmPlace(
          String(60_000 + index),
          `Place ${String(index).padStart(3, "0")}`,
          "cafe",
          38.71 + index / 100_000,
          -9.14,
        ),
      ),
    );

    const eligible = deriveEligibleCandidates(many, {});

    expect(eligible.places).toHaveLength(MAX_REFINEMENT_CANDIDATES);
    expect(eligible.truncated).toBe(true);
  });

  it("reports an empty result rather than relaxing a filter", () => {
    const eligible = deriveEligibleCandidates(POOL, { categories: ["beach"] });

    expect(eligible.places).toEqual([]);
    expect(eligible.candidates).toEqual([]);
  });

  /**
   * The distinction that matters: an empty category list means "nothing fits", and
   * must not collapse into "no filter". `filterForReplacement` produces one when a
   * preference rules out every category, and offering every kind of place instead
   * would hand the traveller something they explicitly did not ask for.
   */
  it("treats an empty category list as nothing eligible, not as no filter", () => {
    expect(deriveEligibleCandidates(POOL, { categories: [] }).places).toEqual([]);
    // Whereas omitting it entirely means any category.
    expect(
      deriveEligibleCandidates(POOL, {}).places.length,
    ).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const filter = {
      categories: ["museum"] as PlaceCategory[],
      anchor: FIXTURE_PLACES.cafeOne.coordinates,
      radiusMeters: REPLACEMENT_RADIUS_METERS,
    };

    const first = deriveEligibleCandidates(POOL, { ...filter });
    const second = deriveEligibleCandidates(POOL, { ...filter });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe("orderCandidates", () => {
  it("orders by distance from the anchor, nearest first", () => {
    const ordered = orderCandidates(
      [FIXTURE_PLACES.museumTwo, FIXTURE_PLACES.museumOne],
      FIXTURE_PLACES.museumOne.coordinates,
    );

    expect(ordered.map((place) => place.placeId)).toEqual([
      FIXTURE_PLACES.museumOne.placeId,
      FIXTURE_PLACES.museumTwo.placeId,
    ]);
  });

  it("breaks a distance tie by name, then id, so the order is total", () => {
    const anchor = { lat: 38.72, lng: -9.14 };
    const a = fixtureOsmPlace("9001", "Beta", "cafe", 38.72, -9.14);
    const b = fixtureOsmPlace("9002", "Alpha", "cafe", 38.72, -9.14);

    expect(orderCandidates([a, b], anchor).map((place) => place.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("does not depend on the input order", () => {
    const anchor = FIXTURE_PLACES.cafeOne.coordinates;
    const forward = orderCandidates(Object.values(FIXTURE_PLACES), anchor);
    const backward = orderCandidates(
      [...Object.values(FIXTURE_PLACES)].reverse(),
      anchor,
    );

    expect(forward.map((p) => p.placeId)).toEqual(backward.map((p) => p.placeId));
  });

  it("preserves pool order when there is no anchor", () => {
    const places = Object.values(FIXTURE_PLACES);

    expect(orderCandidates(places, null).map((p) => p.placeId)).toEqual(
      places.map((p) => p.placeId),
    );
  });

  it("does not mutate its input", () => {
    const places = Object.values(FIXTURE_PLACES);
    const snapshot = places.map((place) => place.placeId);

    orderCandidates(places, FIXTURE_PLACES.cafeOne.coordinates);
    expect(places.map((place) => place.placeId)).toEqual(snapshot);
  });
});

describe("placesInUse", () => {
  it("collects a day's items and backups", () => {
    const plan = fixtureSavedPlan();
    const used = placesInUse(plan, { day: plan.days[0] });

    expect(used.has(FIXTURE_PLACES.cafeOne.placeId)).toBe(true);
    // The day-one backup.
    expect(used.has(FIXTURE_PLACES.museumTwo.placeId)).toBe(true);
    // Day two's café is not in use *on day one*.
    expect(used.has(FIXTURE_PLACES.cafeTwo.placeId)).toBe(false);
  });

  it("collects the whole trip when asked", () => {
    const plan = fixtureSavedPlan();
    const used = placesInUse(plan, { trip: true });

    expect(used.has(FIXTURE_PLACES.cafeTwo.placeId)).toBe(true);
  });
});

describe("filterForReplacement", () => {
  it("preserves the category by default", () => {
    const filter = filterForReplacement({
      pool: POOL,
      current: FIXTURE_PLACES.cafeOne,
      excludePlaceIds: [],
    });

    // A lunch slot filled with a museum is not a refinement, it is a different day.
    expect(filter.categories).toEqual(["cafe"]);
  });

  it("always excludes the place being replaced", () => {
    const filter = filterForReplacement({
      pool: POOL,
      current: FIXTURE_PLACES.cafeOne,
      excludePlaceIds: [FIXTURE_PLACES.cafeTwo.placeId],
    });

    expect(filter.excludePlaceIds).toContain(FIXTURE_PLACES.cafeOne.placeId);
    expect(filter.excludePlaceIds).toContain(FIXTURE_PLACES.cafeTwo.placeId);
  });

  it("honours an explicit category override", () => {
    const filter = filterForReplacement({
      pool: POOL,
      current: FIXTURE_PLACES.cafeOne,
      excludePlaceIds: [],
      preferences: { category: "museum" },
    });

    expect(filter.categories).toEqual(["museum"]);
  });

  it("anchors on the current place and bounds the distance", () => {
    const filter = filterForReplacement({
      pool: POOL,
      current: FIXTURE_PLACES.cafeOne,
      excludePlaceIds: [],
    });

    expect(filter.anchor).toEqual(FIXTURE_PLACES.cafeOne.coordinates);
    expect(filter.radiusMeters).toBe(REPLACEMENT_RADIUS_METERS);
  });

  it("maps indoor and outdoor preferences onto one flag", () => {
    expect(
      filterForReplacement({
        pool: POOL,
        current: FIXTURE_PLACES.cafeOne,
        excludePlaceIds: [],
        preferences: { indoor: true },
      }).indoor,
    ).toBe(true);

    expect(
      filterForReplacement({
        pool: POOL,
        current: FIXTURE_PLACES.cafeOne,
        excludePlaceIds: [],
        preferences: { outdoor: true },
      }).indoor,
    ).toBe(false);
  });

  it("drops a busy category when quieter is asked for, rather than substituting", () => {
    const bar = fixtureOsmPlace("8001", "A bar", "bar", 38.71, -9.14);

    const filter = filterForReplacement({
      pool: fixturePool([bar]),
      current: bar,
      excludePlaceIds: [],
      preferences: { quieter: true },
    });

    // No eligible category left: the honest outcome is "nothing fits", not a
    // different kind of place the traveller did not ask for.
    expect(filter.categories).toEqual([]);
  });
});
