import { describe, expect, it } from "vitest";

import {
  MAX_PROMPT_CANDIDATES,
  buildModelCandidates,
  sourceFacts,
  toCandidate,
} from "./candidates";
import { FIXTURE_PLACES, fixtureOsmPlace, fixturePool } from "./test-fixtures";

describe("toCandidate", () => {
  it("copies canonical identity and coordinates verbatim", () => {
    const candidate = toCandidate(FIXTURE_PLACES.cafeOne);

    expect(candidate.placeId).toBe(FIXTURE_PLACES.cafeOne.placeId);
    expect(candidate.name).toBe(FIXTURE_PLACES.cafeOne.name);
    expect(candidate.latitude).toBe(FIXTURE_PLACES.cafeOne.coordinates.lat);
    expect(candidate.longitude).toBe(FIXTURE_PLACES.cafeOne.coordinates.lng);
    expect(candidate.category).toBe("cafe");
  });

  /**
   * The central rule. A relevance or quality score would demonstrably improve the
   * model's choices, and any score we could compute from OSM tags would be our
   * opinion dressed as data — which the model would then reason about as a fact.
   */
  it("invents no quality signal of any kind", () => {
    const candidate = toCandidate(FIXTURE_PLACES.museumOne) as Record<string, unknown>;

    for (const field of [
      "rating",
      "userRatingCount",
      "priceLevel",
      "qualityScore",
      "popularity",
      "score",
      "distanceMeters",
      "isOpenNow",
    ]) {
      expect(candidate[field], field).toBeUndefined();
    }
  });

  it("omits absent fields rather than sending empty strings", () => {
    const candidate = toCandidate(FIXTURE_PLACES.museumTwo);

    // `"address": ""` in a prompt reads as an address the model might complete.
    expect("address" in candidate).toBe(false);
    expect("website" in candidate).toBe(false);
    expect("openingHours" in candidate).toBe(false);
  });

  it("carries opening hours verbatim", () => {
    const candidate = toCandidate(FIXTURE_PLACES.cafeOne);

    expect(candidate.openingHours).toBe(FIXTURE_PLACES.cafeOne.openingHours);
  });

  it("joins cuisine tags without reinterpreting them", () => {
    const candidate = toCandidate(
      fixtureOsmPlace("5001", "Somewhere", "restaurant", 38.7, -9.1, {
        cuisine: ["portuguese", "seafood"],
      }),
    );

    expect(candidate.cuisine).toBe("portuguese, seafood");
  });

  it("only carries a category label when it adds something", () => {
    const plain = toCandidate(FIXTURE_PLACES.cafeTwo);
    expect(plain.categoryLabel).toBe("Café");

    const labelled = toCandidate(
      fixtureOsmPlace("5002", "X", "cafe", 38.7, -9.1, {
        categoryLabel: "Coffee roastery",
      }),
    );
    expect(labelled.categoryLabel).toBe("Coffee roastery");
  });

  it("does not mutate the canonical record", () => {
    const snapshot = JSON.stringify(FIXTURE_PLACES.cafeOne);

    toCandidate(FIXTURE_PLACES.cafeOne);
    expect(JSON.stringify(FIXTURE_PLACES.cafeOne)).toBe(snapshot);
  });
});

describe("sourceFacts", () => {
  it("labels opening hours as uninterpreted", () => {
    const facts = sourceFacts(FIXTURE_PLACES.cafeOne);

    expect(facts.join(" ")).toMatch(/raw and uninterpreted/i);
  });

  it("restates tags without adding a judgement", () => {
    const facts = sourceFacts(
      fixtureOsmPlace("5003", "X", "cafe", 38.7, -9.1, {
        wheelchair: "designated",
        outdoorSeating: true,
        takeaway: false,
      }),
    );

    expect(facts).toContain("OpenStreetMap wheelchair tag: designated");
    expect(facts).toContain("Tagged as having outdoor seating");
    expect(facts).toContain("Tagged as no takeaway");
  });

  it("says when there is no address, rather than staying silent", () => {
    expect(sourceFacts(FIXTURE_PLACES.museumTwo)).toContain(
      "No address recorded in OpenStreetMap",
    );
  });

  it("says nothing about a tag the provider did not supply", () => {
    const facts = sourceFacts(FIXTURE_PLACES.museumTwo).join(" ");

    expect(facts).not.toMatch(/wheelchair|outdoor|takeaway/);
  });
});

describe("buildModelCandidates", () => {
  it("preserves pool order exactly, so the prompt is reproducible", () => {
    const pool = fixturePool();

    const first = buildModelCandidates({ pool, limitPerCategory: 8 });
    const second = buildModelCandidates({ pool, limitPerCategory: 8 });

    expect(first.candidates.map((c) => c.placeId)).toEqual(
      pool.places.map((place) => place.placeId),
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("counts candidates by category", () => {
    const result = buildModelCandidates({ pool: fixturePool(), limitPerCategory: 8 });

    expect(result.countsByCategory).toEqual({
      cafe: 2,
      hotel: 1,
      museum: 2,
      restaurant: 2,
    });
  });

  it("applies the per-category cap and reports the truncation", () => {
    const result = buildModelCandidates({ pool: fixturePool(), limitPerCategory: 1 });

    expect(result.countsByCategory).toEqual({
      cafe: 1,
      hotel: 1,
      museum: 1,
      restaurant: 1,
    });
    // Silent truncation would read as "this is everything that was found".
    expect(result.truncated).toBe(true);
  });

  it("reports no truncation when everything fits", () => {
    expect(
      buildModelCandidates({ pool: fixturePool(), limitPerCategory: 8 }).truncated,
    ).toBe(false);
  });

  it("caps the total prompt size and says so", () => {
    const many = Array.from({ length: MAX_PROMPT_CANDIDATES + 20 }, (_, index) =>
      fixtureOsmPlace(
        String(90_000 + index),
        `Place ${String(index).padStart(3, "0")}`,
        "cafe",
        38.7 + index / 10_000,
        -9.1,
      ),
    );

    const result = buildModelCandidates({
      pool: fixturePool(many),
      limitPerCategory: 999,
    });

    expect(result.candidates).toHaveLength(MAX_PROMPT_CANDIDATES);
    expect(result.truncated).toBe(true);
  });

  it("handles an empty pool without inventing a candidate", () => {
    const result = buildModelCandidates({
      pool: fixturePool([]),
      limitPerCategory: 8,
    });

    expect(result.candidates).toEqual([]);
    expect(result.countsByCategory).toEqual({});
    expect(result.truncated).toBe(false);
  });
});
