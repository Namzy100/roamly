import { describe, expect, it } from "vitest";

import {
  FIXTURE_PLACES,
  fixtureOsmPlace,
  fixturePool,
} from "@/lib/generate/test-fixtures";
import { fixtureSavedPlan } from "@/lib/refinement/test-fixtures";
import type { PlaceCategory, TripPlace, TripPlan } from "@/lib/schemas";

import {
  isLandmarkEligible,
  landmarkEligibility,
  selectLandmarkCandidates,
  MAX_LANDMARK_CANDIDATES_PER_TRIP,
} from "./landmark-eligibility";

/**
 * Eligibility, tested as a cost control as much as a policy.
 *
 * The failure this exists to prevent is a discovery pass returning a hundred cafés and Roamly asking Wikimedia about every
 * one of them. So the important assertions are the negative ones — that a café produces no candidate at all, and that a
 * large pool cannot produce more than the cap however it is shaped.
 *
 * The second failure, subtler, is spending a bounded budget on the wrong places. With a cap, ordering *is* the policy:
 * pool-first ordering on a museum-heavy pool would enrich nothing the traveller actually visits.
 */

const ALL_CATEGORIES: PlaceCategory[] = [
  "restaurant",
  "cafe",
  "bar",
  "fast_food",
  "hotel",
  "hostel",
  "guest_house",
  "museum",
  "gallery",
  "attraction",
  "monument",
  "viewpoint",
  "park",
  "garden",
  "beach",
  "market",
  "place_of_worship",
  "theatre",
  "music_venue",
  "shopping",
  "winery",
  "historic_site",
];

function place(
  category: PlaceCategory,
  name = "Museu Nacional do Azulejo",
  id = "9001",
): TripPlace {
  return fixtureOsmPlace(id, name, category, 38.7248, -9.115);
}

describe("category policy", () => {
  it("is total over every category in the schema", () => {
    for (const category of ALL_CATEGORIES) {
      expect(typeof landmarkEligibility(place(category)).eligible, category).toBe(
        "boolean",
      );
    }
  });

  it("admits public-interest landmarks", () => {
    for (const category of [
      "museum",
      "gallery",
      "monument",
      "historic_site",
      "attraction",
      "viewpoint",
      "park",
      "garden",
      "beach",
      "place_of_worship",
      "theatre",
    ] as PlaceCategory[]) {
      expect(isLandmarkEligible(place(category)), category).toBe(true);
    }
  });

  /**
   * The cost control, asserted directly.
   *
   * Every one of these is refused with `commercial_premises`, so a pool full of restaurants produces no requests at all —
   * not cached misses, not cheap requests. No request is ever formed.
   */
  it("refuses commercial premises, and says that is why", () => {
    for (const category of [
      "restaurant",
      "cafe",
      "bar",
      "fast_food",
      "hotel",
      "hostel",
      "guest_house",
      "shopping",
      "winery",
      "market",
      "music_venue",
    ] as PlaceCategory[]) {
      const verdict = landmarkEligibility(place(category));
      expect(verdict.eligible, category).toBe(false);
      if (verdict.eligible) throw new Error("unreachable");
      expect(verdict.code, category).toBe("commercial_premises");
    }
  });

  /** A name of one or two characters corroborates nothing, and name-only matching is refused anyway. */
  it("refuses a name too short to corroborate anything", () => {
    const verdict = landmarkEligibility(place("museum", "M"));
    expect(verdict.eligible).toBe(false);
    if (verdict.eligible) throw new Error("unreachable");
    expect(verdict.code).toBe("name_too_short");
  });

  /**
   * Eligibility is not a claim that an entity exists.
   *
   * Asserted as a property of the shape: the verdict carries no QID, no entity and no existence flag. There is nothing in
   * it that could be mistaken for "Wikidata has this".
   */
  it("says nothing about whether an entity exists", () => {
    expect(Object.keys(landmarkEligibility(place("museum")))).toEqual([
      "eligible",
    ]);
  });

  it("is deterministic", () => {
    const subject = place("museum");
    expect(landmarkEligibility(subject)).toEqual(landmarkEligibility(subject));
  });
});

describe("candidate selection", () => {
  /** The fixture day 1 is café, museum, restaurant — so exactly one scheduled stop is eligible. */
  it("selects only eligible scheduled places", () => {
    const candidates = selectLandmarkCandidates({ plan: fixtureSavedPlan() });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(isLandmarkEligible(candidate.place)).toBe(true);
    }
    expect(
      candidates.every((candidate) => candidate.place.category !== "cafe"),
    ).toBe(true);
  });

  /**
   * Scheduled before backup before pool, because the cap discards the tail.
   *
   * A pool-first order on a museum-heavy pool would spend the whole budget on museums the traveller never sees.
   */
  it("orders scheduled stops ahead of backups and unused pool places", () => {
    const spare = fixtureOsmPlace(
      "9101",
      "Unused Museum",
      "museum",
      38.71,
      -9.14,
    );

    const bands = selectLandmarkCandidates({
      plan: fixtureSavedPlan(),
      pool: fixturePool([...Object.values(FIXTURE_PLACES), spare]),
    }).map((candidate) => candidate.source);

    const firstPool = bands.indexOf("pool");
    const lastScheduled = bands.lastIndexOf("scheduled");

    expect(firstPool === -1 || firstPool > lastScheduled).toBe(true);
  });

  it("never exceeds the per-trip cap", () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      fixtureOsmPlace(
        `92${index}`,
        `Museum Number ${index}`,
        "museum",
        38.71 + index / 2_000,
        -9.14,
      ),
    );

    expect(
      selectLandmarkCandidates({
        plan: fixtureSavedPlan(),
        pool: fixturePool([...Object.values(FIXTURE_PLACES), ...many]),
      }).length,
    ).toBeLessThanOrEqual(MAX_LANDMARK_CANDIDATES_PER_TRIP);
  });

  /** A pool of nothing but cafés produces no candidates, so no requests. */
  it("produces nothing for a pool of only commercial places", () => {
    const commercial = Array.from({ length: 40 }, (_, index) =>
      fixtureOsmPlace(`93${index}`, `Café ${index}`, "cafe", 38.71, -9.14),
    );

    const plan = fixtureSavedPlan();
    const placeless: TripPlan = {
      ...plan,
      days: plan.days.map((day) => ({
        ...day,
        items: day.items.map((item) => ({ ...item, place: null })),
        backups: [],
      })),
    };

    expect(
      selectLandmarkCandidates({
        plan: placeless,
        pool: fixturePool(commercial),
      }),
    ).toEqual([]);
  });

  /** One place is one answer, however many bands it appears in. */
  it("lists a place once, in its strongest band", () => {
    const candidates = selectLandmarkCandidates({
      plan: fixtureSavedPlan(),
      pool: fixturePool(),
    });

    const ids = candidates.map((candidate) => candidate.place.placeId);
    expect(new Set(ids).size).toBe(ids.length);

    /* The museum is scheduled, so its pool copy must not downgrade it. */
    expect(
      candidates.find(
        (candidate) =>
          candidate.place.placeId === FIXTURE_PLACES.museumOne.placeId,
      )?.source,
    ).toBe("scheduled");
  });

  /**
   * Deterministic under a reordered pool.
   *
   * With a cap, an unstable order means a different twelve on two machines — which would make a cache useless and these
   * tests meaningless.
   */
  it("is stable when the pool is reordered", () => {
    const extras = [
      fixtureOsmPlace("9401", "Alpha Museum", "museum", 38.72, -9.13),
      fixtureOsmPlace("9402", "Beta Gallery", "gallery", 38.73, -9.12),
      fixtureOsmPlace("9403", "Gamma Monument", "monument", 38.74, -9.11),
    ];

    const forward = selectLandmarkCandidates({
      plan: fixtureSavedPlan(),
      pool: fixturePool([...Object.values(FIXTURE_PLACES), ...extras]),
    }).map((candidate) => candidate.place.placeId);

    const reversed = selectLandmarkCandidates({
      plan: fixtureSavedPlan(),
      pool: fixturePool([
        ...[...extras].reverse(),
        ...Object.values(FIXTURE_PLACES),
      ]),
    }).map((candidate) => candidate.place.placeId);

    expect(forward).toEqual(reversed);
  });

  it("works with no pool at all", () => {
    expect(() =>
      selectLandmarkCandidates({ plan: fixtureSavedPlan(), pool: null }),
    ).not.toThrow();
  });
});
