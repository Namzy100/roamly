import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlaceCategory, TripPlace } from "@/lib/schemas";

import {
  DISCOVERY_LIMITS,
  MAX_DISCOVERY_REQUESTS,
  clampRadius,
  discoverForStrategy,
  orderForPool,
  perCategoryLimit,
  requestedCategories,
} from "./discovery";
import {
  FIXTURE_DESTINATION,
  FIXTURE_PLACES,
  fixtureOsmPlace,
  fixtureStrategy,
} from "./test-fixtures";

/**
 * Discovery, with Overpass mocked.
 *
 * **No live provider request is made in this file.** Overpass is a volunteer service
 * and a suite that queried it on every save is the abuse the rate limiter exists to
 * prevent; the live checks are opt-in via `npm run test:integration:osm`.
 *
 * The mock records every call, because the assertions that matter here are about
 * *restraint*: how many requests were issued, with what radius, and what happens when
 * one of them fails.
 */

const discoverPlaces = vi.hoisted(() => vi.fn());

vi.mock("@/lib/providers/osm", () => ({ discoverPlaces }));

function discoveryResult(
  places: TripPlace[],
  options: {
    categories?: PlaceCategory[];
    categoriesWithNoResults?: PlaceCategory[];
    discarded?: number;
  } = {},
) {
  const categories =
    options.categories ??
    ([...new Set(places.map((place) => place.category))] as PlaceCategory[]);

  return {
    places,
    categoriesRequested: categories,
    query: {
      center: {
        latitude: FIXTURE_DESTINATION.latitude,
        longitude: FIXTURE_DESTINATION.longitude,
      },
      radiusMeters: 4_000,
      limitPerCategory: 6,
      categoriesWithNoResults: options.categoriesWithNoResults ?? [],
    },
    discarded: {
      total: options.discarded ?? 0,
      noCategory: 0,
      noName: 0,
      noCoordinates: 0,
      invalid: 0,
    },
    fetchedAt: "2026-07-27T09:00:00.000Z",
    attribution: "© OpenStreetMap contributors (ODbL)",
    fromCache: false,
  };
}

beforeEach(() => {
  discoverPlaces.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("requestedCategories", () => {
  it("deduplicates and sorts, so the cap and the pool id are deterministic", () => {
    expect(requestedCategories(fixtureStrategy())).toEqual([
      "cafe",
      "museum",
      "restaurant",
    ]);
  });

  it("does not depend on which day mentioned a category first", () => {
    const a = fixtureStrategy();
    const b = fixtureStrategy();
    b.days = [b.days[1], b.days[0]];

    expect(requestedCategories(a)).toEqual(requestedCategories(b));
  });
});

describe("clampRadius", () => {
  it("clamps a model's radius at both ends", () => {
    expect(clampRadius(50)).toBe(DISCOVERY_LIMITS.minRadiusMeters);
    expect(clampRadius(400_000)).toBe(DISCOVERY_LIMITS.maxRadiusMeters);
    expect(clampRadius(4_000)).toBe(4_000);
  });

  it("falls back for a non-finite value", () => {
    expect(clampRadius(Number.NaN)).toBeGreaterThan(0);
  });
});

describe("perCategoryLimit", () => {
  it("takes the largest limit any slot asked for, clamped", () => {
    const strategy = fixtureStrategy();
    strategy.days[0].searchRequirements[0].candidateLimit = 12;

    expect(perCategoryLimit(strategy)).toBe(12);
  });

  it("does not go below the floor", () => {
    const strategy = fixtureStrategy();
    for (const day of strategy.days) {
      for (const slot of day.searchRequirements) slot.candidateLimit = 1;
    }

    expect(perCategoryLimit(strategy)).toBe(DISCOVERY_LIMITS.minPerCategory);
  });
});

describe("orderForPool", () => {
  it("deduplicates by canonical id, keeping the first occurrence", () => {
    const duplicate = { ...FIXTURE_PLACES.cafeOne, name: "A different name" };

    const ordered = orderForPool([FIXTURE_PLACES.cafeOne, duplicate]);

    expect(ordered).toHaveLength(1);
    expect(ordered[0].name).toBe(FIXTURE_PLACES.cafeOne.name);
  });

  it("orders by category then name, regardless of which batch finished first", () => {
    const forward = orderForPool([
      FIXTURE_PLACES.museumOne,
      FIXTURE_PLACES.cafeTwo,
      FIXTURE_PLACES.cafeOne,
    ]);
    const backward = orderForPool([
      FIXTURE_PLACES.cafeOne,
      FIXTURE_PLACES.museumOne,
      FIXTURE_PLACES.cafeTwo,
    ]);

    expect(forward.map((place) => place.placeId)).toEqual(
      backward.map((place) => place.placeId),
    );
    expect(forward[0].category).toBe("cafe");
  });
});

describe("discoverForStrategy", () => {
  it("builds one pool from the strategy's categories", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult(Object.values(FIXTURE_PLACES)),
    );

    const outcome = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(discoverPlaces).toHaveBeenCalledTimes(1);
    expect(outcome.pool.places).toHaveLength(7);
    expect(outcome.summary.candidateCount).toBe(7);
    expect(outcome.summary.categoriesRequested).toEqual([
      "cafe",
      "museum",
      "restaurant",
    ]);
  });

  it("passes the geocoded centre, never anything from the model", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));

    await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(discoverPlaces.mock.calls[0][0].center).toEqual({
      latitude: FIXTURE_DESTINATION.latitude,
      longitude: FIXTURE_DESTINATION.longitude,
    });
  });

  it("clamps the radius before it reaches the provider", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));
    const strategy = fixtureStrategy();
    strategy.recommendedRadiusMeters = 15_000;

    await discoverForStrategy({ strategy, destination: FIXTURE_DESTINATION });

    expect(discoverPlaces.mock.calls[0][0].radiusMeters).toBe(
      DISCOVERY_LIMITS.maxRadiusMeters,
    );
  });

  it("batches at eight categories and never exceeds the request cap", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));

    const strategy = fixtureStrategy();
    const everything: PlaceCategory[] = [
      "restaurant", "cafe", "bar", "fast_food", "hotel", "hostel", "guest_house",
      "museum", "gallery", "attraction", "monument", "viewpoint", "park", "garden",
      "beach", "market", "place_of_worship", "theatre", "music_venue", "shopping",
      "winery", "historic_site",
    ];
    strategy.days = [
      {
        dayNumber: 1,
        theme: "Everything",
        pace: "packed",
        searchRequirements: everything.slice(0, 6).map((category, index) => ({
          slotId: `d1-s${index + 1}`,
          category,
          purpose: "A stop.",
          mealType: null,
          required: false,
          candidateLimit: 6,
        })),
      },
      {
        dayNumber: 2,
        theme: "The rest",
        pace: "packed",
        searchRequirements: everything.slice(6, 12).map((category, index) => ({
          slotId: `d2-s${index + 1}`,
          category,
          purpose: "A stop.",
          mealType: null,
          required: false,
          candidateLimit: 6,
        })),
      },
    ];

    await discoverForStrategy({ strategy, destination: FIXTURE_DESTINATION });

    expect(discoverPlaces.mock.calls.length).toBeLessThanOrEqual(
      MAX_DISCOVERY_REQUESTS,
    );
    for (const call of discoverPlaces.mock.calls) {
      expect(call[0].categories.length).toBeLessThanOrEqual(8);
    }
  });

  it("keeps the other batches when one fails, and says which slots may be open", async () => {
    // One batch failing must not lose the other. A trip with an honest gap is usable;
    // a trip with nothing is a wasted model call.
    const strategy = fixtureStrategy();
    strategy.days[0].searchRequirements = [
      ...strategy.days[0].searchRequirements,
      ...(["bar", "park", "beach", "theatre", "market", "garden"] as const).map(
        (category, index) => ({
          slotId: `d1-s${index + 4}`,
          category,
          purpose: "A stop.",
          mealType: null,
          required: false,
          candidateLimit: 6,
        }),
      ),
    ];

    discoverPlaces
      .mockResolvedValueOnce(discoveryResult([FIXTURE_PLACES.cafeOne]))
      .mockRejectedValueOnce(new Error("overpass exploded"));

    const outcome = await discoverForStrategy({
      strategy,
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.pool.places).toHaveLength(1);
    expect(outcome.warnings.map((warning) => warning.code)).toContain(
      "discovery_batch_failed",
    );
    // No provider hostname or upstream message reaches the warning.
    expect(JSON.stringify(outcome.warnings)).not.toContain("exploded");
  });

  it("reports an empty category rather than substituting another", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult([FIXTURE_PLACES.cafeOne], {
        categories: ["cafe", "museum", "restaurant"],
        categoriesWithNoResults: ["museum", "restaurant"],
      }),
    );

    const outcome = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.summary.categoriesWithNoResults).toEqual(["museum", "restaurant"]);
    expect(
      outcome.warnings.filter((warning) => warning.code === "discovery_empty_category"),
    ).toHaveLength(2);
    // Nothing was invented to fill them.
    expect(outcome.pool.places).toHaveLength(1);
  });

  it("returns an empty pool rather than anything fabricated", async () => {
    discoverPlaces.mockResolvedValue(
      discoveryResult([], {
        categories: ["cafe", "museum", "restaurant"],
        categoriesWithNoResults: ["cafe", "museum", "restaurant"],
      }),
    );

    const outcome = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.pool.places).toEqual([]);
    expect(outcome.summary.candidateCount).toBe(0);
  });

  it("caps the pool and says how many were dropped", async () => {
    const many = Array.from({ length: DISCOVERY_LIMITS.maxPoolPlaces + 10 }, (_, i) =>
      fixtureOsmPlace(
        String(80_000 + i),
        `Place ${String(i).padStart(3, "0")}`,
        "cafe",
        38.7 + i / 10_000,
        -9.1,
      ),
    );
    discoverPlaces.mockResolvedValue(discoveryResult(many));

    const outcome = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.pool.places).toHaveLength(DISCOVERY_LIMITS.maxPoolPlaces);
    expect(outcome.warnings.map((warning) => warning.code)).toContain(
      "discovery_pool_capped",
    );
  });

  it("deduplicates a place returned by two batches", async () => {
    const strategy = fixtureStrategy();
    strategy.days[0].searchRequirements = [
      ...strategy.days[0].searchRequirements,
      ...(["bar", "park", "beach", "theatre", "market", "garden"] as const).map(
        (category, index) => ({
          slotId: `d1-s${index + 4}`,
          category,
          purpose: "A stop.",
          mealType: null,
          required: false,
          candidateLimit: 6,
        }),
      ),
    ];

    // The same element can legitimately match two category filters.
    discoverPlaces
      .mockResolvedValueOnce(discoveryResult([FIXTURE_PLACES.museumOne]))
      .mockResolvedValueOnce(discoveryResult([FIXTURE_PLACES.museumOne]));

    const outcome = await discoverForStrategy({
      strategy,
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.pool.places).toHaveLength(1);
  });

  it("gives the pool a deterministic id that cannot be mistaken for a derived one", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));

    const first = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });
    const second = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(first.pool.poolId).toBe(second.pool.poolId);
    expect(first.pool.poolId.startsWith("discovery:")).toBe(true);
    expect(first.pool.poolId).not.toContain("plan-derived");
  });

  it("records the destination on the pool", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));

    const outcome = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.pool.destination).toEqual({
      canonicalId: FIXTURE_DESTINATION.canonicalId,
      name: "Lisbon",
      latitude: FIXTURE_DESTINATION.latitude,
      longitude: FIXTURE_DESTINATION.longitude,
    });
  });

  it("carries the OpenStreetMap attribution", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));

    const outcome = await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
    });

    expect(outcome.pool.attribution).toMatch(/OpenStreetMap/);
    expect(outcome.summary.attribution).toMatch(/OpenStreetMap/);
  });

  it("threads the abort signal through to the provider", async () => {
    discoverPlaces.mockResolvedValue(discoveryResult([FIXTURE_PLACES.cafeOne]));
    const controller = new AbortController();

    await discoverForStrategy({
      strategy: fixtureStrategy(),
      destination: FIXTURE_DESTINATION,
      signal: controller.signal,
    });

    expect(discoverPlaces.mock.calls[0][0].signal).toBe(controller.signal);
  });
});
