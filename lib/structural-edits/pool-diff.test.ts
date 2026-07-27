import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  FIXTURE_SPARE_CAFE,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { TripPlace, VerifiedPlacePool } from "@/lib/schemas";

import {
  POOL_COORDINATE_TOLERANCE_METERS,
  categoriesNowEmpty,
  diffPlacePools,
} from "./pool-diff";

const PREVIOUS = FIXTURE_GENERATION.placePool;
const PLAN = fixtureSavedPlan();

function poolOf(places: TripPlace[]): VerifiedPlacePool {
  return { ...PREVIOUS, places };
}

function diff(next: VerifiedPlacePool) {
  return diffPlacePools({ previous: PREVIOUS, next, plan: PLAN });
}

/** Metres north, converted to degrees of latitude. ~111 km per degree. */
function shifted(place: TripPlace, metres: number): TripPlace {
  return {
    ...place,
    coordinates: {
      ...place.coordinates,
      lat: place.coordinates.lat + metres / 111_320,
    },
  };
}

describe("diffPlacePools — added, removed, retained", () => {
  it("reports nothing changed for an identical pool", () => {
    const changes = diff(PREVIOUS);

    expect(changes.addedPlaceIds).toEqual([]);
    expect(changes.removedPlaceIds).toEqual([]);
    expect(changes.retainedPlaceIds).toHaveLength(PREVIOUS.places.length);
    expect(changes.changedCanonicalRecords).toEqual([]);
    expect(changes.missingUsedPlaceIds).toEqual([]);
    expect(changes.previousCount).toBe(changes.newCount);
  });

  it("reports an added place", () => {
    const changes = diff(poolOf([...PREVIOUS.places, FIXTURE_SPARE_CAFE]));

    expect(changes.addedPlaceIds).toEqual([FIXTURE_SPARE_CAFE.placeId]);
    expect(changes.removedPlaceIds).toEqual([]);
    expect(changes.newCount).toBe(changes.previousCount + 1);
  });

  it("reports a removed place", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.filter(
          (place) => place.placeId !== FIXTURE_PLACES.museumTwo.placeId,
        ),
      ),
    );

    expect(changes.removedPlaceIds).toEqual([FIXTURE_PLACES.museumTwo.placeId]);
    expect(changes.retainedPlaceIds).not.toContain(
      FIXTURE_PLACES.museumTwo.placeId,
    );
  });

  /**
   * The subset that matters. A removed candidate nobody chose is housekeeping; a removed *stop*
   * is a decision the traveller has to make.
   */
  it("singles out removed places the itinerary depends on", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.filter(
          (place) => place.placeId !== FIXTURE_PLACES.museumOne.placeId,
        ),
      ),
    );

    expect(changes.missingUsedPlaceIds).toEqual([FIXTURE_PLACES.museumOne.placeId]);
  });

  it("does not list a removed place the itinerary never used", () => {
    // Every fixture pool place is used, so a stranger is added and then removed again.
    const withSpare = poolOf([...PREVIOUS.places, FIXTURE_SPARE_CAFE]);
    const changes = diffPlacePools({
      previous: withSpare,
      next: PREVIOUS,
      plan: PLAN,
    });

    expect(changes.removedPlaceIds).toEqual([FIXTURE_SPARE_CAFE.placeId]);
    expect(changes.missingUsedPlaceIds).toEqual([]);
  });
});

describe("diffPlacePools — changed records", () => {
  /**
   * A corrected name is the *same place with a better record*. Reporting it as one place gone
   * and another arrived would tell a traveller their museum had disappeared over a typo fix.
   */
  it("reports a renamed place as changed, not as added and removed", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.map((place) =>
          place.placeId === FIXTURE_PLACES.museumOne.placeId
            ? { ...place, name: "Museu Nacional do Azulejo" }
            : place,
        ),
      ),
    );

    expect(changes.addedPlaceIds).toEqual([]);
    expect(changes.removedPlaceIds).toEqual([]);
    expect(changes.changedCanonicalRecords).toEqual([
      { placeId: FIXTURE_PLACES.museumOne.placeId, changedFields: ["name"] },
    ]);
  });

  it("reports each changed field", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.map((place) =>
          place.placeId === FIXTURE_PLACES.cafeOne.placeId
            ? {
                ...place,
                name: "Fábrica",
                address: "R. das Portas de Santo Antão 140",
                website: "https://example.test",
                phone: "+351 000 000 000",
                openingHours: "24/7",
              }
            : place,
        ),
      ),
    );

    expect(changes.changedCanonicalRecords[0].changedFields).toEqual([
      "name",
      "address",
      "website",
      "phone",
      "openingHours",
    ]);
  });

  it("reports a category change", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.map((place) =>
          place.placeId === FIXTURE_PLACES.cafeTwo.placeId
            ? { ...place, category: "bar" as const }
            : place,
        ),
      ),
    );

    expect(changes.changedCanonicalRecords).toEqual([
      { placeId: FIXTURE_PLACES.cafeTwo.placeId, changedFields: ["category"] },
    ]);
  });

  /**
   * OSM coordinates for the same node drift by metres as mappers refine geometry. A one-metre
   * change is not information; a hundred-metre change is.
   */
  it("ignores a coordinate change inside the tolerance", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.map((place) =>
          place.placeId === FIXTURE_PLACES.cafeOne.placeId
            ? shifted(place, POOL_COORDINATE_TOLERANCE_METERS - 5)
            : place,
        ),
      ),
    );

    expect(changes.changedCanonicalRecords).toEqual([]);
  });

  it("reports a coordinate change beyond the tolerance", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.map((place) =>
          place.placeId === FIXTURE_PLACES.cafeOne.placeId
            ? shifted(place, POOL_COORDINATE_TOLERANCE_METERS + 40)
            : place,
        ),
      ),
    );

    expect(changes.changedCanonicalRecords).toEqual([
      { placeId: FIXTURE_PLACES.cafeOne.placeId, changedFields: ["coordinates"] },
    ]);
  });

  it("reports a field that disappeared", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.map((place) => {
          if (place.placeId !== FIXTURE_PLACES.cafeOne.placeId) return place;
          const stripped = { ...place };
          delete (stripped as { openingHours?: string }).openingHours;
          return stripped;
        }),
      ),
    );

    expect(changes.changedCanonicalRecords[0].changedFields).toContain(
      "openingHours",
    );
  });
});

describe("diffPlacePools — categories", () => {
  it("counts places per category on both sides", () => {
    const changes = diff(
      poolOf(
        PREVIOUS.places.filter((place) => place.category !== "museum"),
      ),
    );

    const museums = changes.categoryChanges.find(
      (entry) => entry.category === "museum",
    );
    expect(museums?.previousCount).toBe(2);
    expect(museums?.newCount).toBe(0);
  });

  it("names the categories that are now empty", () => {
    const changes = diff(
      poolOf(PREVIOUS.places.filter((place) => place.category !== "museum")),
    );

    expect(categoriesNowEmpty(changes)).toEqual(["museum"]);
  });

  it("does not report a category that was already empty", () => {
    expect(categoriesNowEmpty(diff(PREVIOUS))).toEqual([]);
  });

  it("does not report a category that gained places", () => {
    const changes = diff(poolOf([...PREVIOUS.places, FIXTURE_SPARE_CAFE]));
    expect(categoriesNowEmpty(changes)).toEqual([]);
  });
});

describe("diffPlacePools — determinism", () => {
  /**
   * The same two pools must produce a byte-identical diff, so a preview can be compared against
   * what actually happened.
   */
  it("is deterministic and sorted", () => {
    const next = poolOf([
      ...PREVIOUS.places.slice().reverse(),
      FIXTURE_SPARE_CAFE,
    ]);

    const first = diff(next);
    const second = diff(next);

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.retainedPlaceIds).toEqual([...first.retainedPlaceIds].sort());
    expect(first.addedPlaceIds).toEqual([...first.addedPlaceIds].sort());
    expect(first.removedPlaceIds).toEqual([...first.removedPlaceIds].sort());
    expect(first.categoryChanges.map((entry) => entry.category)).toEqual(
      [...first.categoryChanges.map((entry) => entry.category)].sort(),
    );
  });

  /** Identity is the canonical id. Never the name — two branches share one and differ. */
  it("does not match places by name", () => {
    const renamedId: TripPlace = {
      ...FIXTURE_PLACES.cafeOne,
      placeId: "osm:node:999001",
      source: {
        ...FIXTURE_PLACES.cafeOne.source,
        canonicalId: "osm:node:999001",
        osmId: "999001",
      },
    };

    const changes = diff(
      poolOf([
        ...PREVIOUS.places.filter(
          (place) => place.placeId !== FIXTURE_PLACES.cafeOne.placeId,
        ),
        renamedId,
      ]),
    );

    // Same name, different id: one gone, one arrived. Not a "change".
    expect(changes.removedPlaceIds).toEqual([FIXTURE_PLACES.cafeOne.placeId]);
    expect(changes.addedPlaceIds).toEqual(["osm:node:999001"]);
    expect(changes.changedCanonicalRecords).toEqual([]);
  });
});
