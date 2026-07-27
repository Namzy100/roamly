import { describe, expect, it } from "vitest";

import { testOsmPlace, testPlace } from "@/lib/map/test-fixtures";

import {
  assertItineraryUsesPool,
  assertPlaceIsVerifiable,
  buildVerifiedPlacePool,
  PoolValidationError,
  validatePool,
} from "./pool";
import type { TripPlace } from "./place";

const META = {
  poolId: "pool:test",
  createdAt: "2026-07-26T10:00:00.000Z",
  categories: ["museum" as const],
  attribution: "© OpenStreetMap contributors (ODbL)",
};

function expectPoolError(
  fn: () => unknown,
  code: PoolValidationError["code"],
): void {
  try {
    fn();
    throw new Error(`Expected a PoolValidationError with code ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(PoolValidationError);
    expect((error as PoolValidationError).code).toBe(code);
  }
}

describe("buildVerifiedPlacePool", () => {
  it("accepts well-formed OSM places", () => {
    const pool = buildVerifiedPlacePool(
      [
        testOsmPlace({ osmId: "1" }),
        testOsmPlace({ osmId: "2" }),
        testOsmPlace({ osmType: "way", osmId: "1" }),
      ],
      META,
    );
    expect(pool.places).toHaveLength(3);
    expect(pool.poolId).toBe("pool:test");
  });

  it("accepts mock places with no OSM identity", () => {
    const pool = buildVerifiedPlacePool([testPlace({ placeId: "mock_a" })], META);
    expect(pool.places[0].source.provider).toBe("mock");
  });

  it("rejects duplicate canonical ids", () => {
    expectPoolError(
      () =>
        buildVerifiedPlacePool(
          [testOsmPlace({ osmId: "1" }), testOsmPlace({ osmId: "1" })],
          META,
        ),
      "duplicate_place_id",
    );
  });

  it("rejects a placeId that disagrees with source.canonicalId", () => {
    const place = testOsmPlace({ osmId: "1" });
    const tampered: TripPlace = {
      ...place,
      source: { ...place.source, canonicalId: "osm:node:999" },
    };
    expectPoolError(
      () => buildVerifiedPlacePool([tampered], META),
      "placeid_source_mismatch",
    );
  });

  it("rejects an OSM place missing its element identity", () => {
    const place = testOsmPlace({ osmId: "1" });
    const tampered: TripPlace = {
      ...place,
      source: {
        provider: "openstreetmap",
        canonicalId: place.placeId,
        attribution: place.source.attribution,
      },
    };
    expectPoolError(
      () => buildVerifiedPlacePool([tampered], META),
      "malformed_source_identity",
    );
  });

  it("rejects an OSM place whose element fields do not reconstruct its id", () => {
    // placeId says node/1, but the element fields say way/1. One of them is a lie.
    const place = testOsmPlace({ osmId: "1" });
    const tampered: TripPlace = {
      ...place,
      source: { ...place.source, osmType: "way" },
    };
    expectPoolError(
      () => buildVerifiedPlacePool([tampered], META),
      "osm_identity_mismatch",
    );
  });

  it("rejects a mock place claiming OSM element identity", () => {
    // The check that stops sample data passing itself off as verified provider data.
    const tampered: TripPlace = {
      ...testPlace({ placeId: "mock_a" }),
      source: {
        provider: "mock",
        canonicalId: "mock_a",
        osmType: "node",
        osmId: "12345",
        attribution: "Sample data",
      },
    };
    expectPoolError(
      () => buildVerifiedPlacePool([tampered], META),
      "mock_claims_osm_source",
    );
  });

  it("rejects a place with a blank name", () => {
    const tampered = { ...testOsmPlace({ osmId: "1" }), name: "   " };
    expectPoolError(() => buildVerifiedPlacePool([tampered], META), "missing_name");
  });

  it("rejects a place with non-finite coordinates", () => {
    const tampered = {
      ...testOsmPlace({ osmId: "1" }),
      coordinates: { lat: Number.NaN, lng: 0 },
    };
    expectPoolError(
      () => buildVerifiedPlacePool([tampered], META),
      "missing_coordinates",
    );
  });

  it("rejects a place with a category outside the allowlist", () => {
    const tampered = {
      ...testOsmPlace({ osmId: "1" }),
      category: "nightlife" as never,
    };
    expectPoolError(
      () => buildVerifiedPlacePool([tampered], META),
      "unsupported_category",
    );
  });

  it("does not silently repair — it throws", () => {
    // The pool must never quietly drop a bad record and hand back a shorter list;
    // that would hide exactly the failure it exists to catch.
    expect(() =>
      buildVerifiedPlacePool(
        [testOsmPlace({ osmId: "1" }), { ...testOsmPlace({ osmId: "2" }), name: "" }],
        META,
      ),
    ).toThrow(PoolValidationError);
  });
});

describe("assertItineraryUsesPool", () => {
  const inPool = testOsmPlace({ osmId: "1" });
  const pool = buildVerifiedPlacePool([inPool], META);

  it("accepts an itinerary that only references pool places", () => {
    expect(() => assertItineraryUsesPool([inPool], pool)).not.toThrow();
  });

  it("rejects a placeId that is not in the pool", () => {
    // The core no-invention gate.
    expectPoolError(
      () => assertItineraryUsesPool([testOsmPlace({ osmId: "9999" })], pool),
      "place_outside_pool",
    );
  });

  it("rejects an attached record that was renamed", () => {
    expectPoolError(
      () => assertItineraryUsesPool([{ ...inPool, name: "Somewhere Else" }], pool),
      "attached_place_mismatch",
    );
  });

  it("rejects an attached record whose coordinates were altered", () => {
    expectPoolError(
      () =>
        assertItineraryUsesPool(
          [{ ...inPool, coordinates: { lat: 0, lng: 0 } }],
          pool,
        ),
      "attached_place_mismatch",
    );
  });

  it("rejects even a tiny coordinate drift", () => {
    // "How far is too far" is not a judgement this gate should make.
    expectPoolError(
      () =>
        assertItineraryUsesPool(
          [
            {
              ...inPool,
              coordinates: {
                lat: inPool.coordinates.lat + 0.00001,
                lng: inPool.coordinates.lng,
              },
            },
          ],
          pool,
        ),
      "attached_place_mismatch",
    );
  });

  it("rejects an attached record whose category was changed", () => {
    expectPoolError(
      () => assertItineraryUsesPool([{ ...inPool, category: "cafe" }], pool),
      "attached_place_mismatch",
    );
  });

  it("rejects an attached record whose provider was changed", () => {
    expectPoolError(
      () =>
        assertItineraryUsesPool(
          [
            {
              ...inPool,
              source: { ...inPool.source, provider: "mock" as const },
            },
          ],
          pool,
        ),
      "attached_place_mismatch",
    );
  });

  it("accepts optional metadata differing, since that is not identity", () => {
    // A record may legitimately carry fewer optional fields than the pool copy;
    // what must not change is who and where the place is.
    expect(() =>
      assertItineraryUsesPool([{ ...inPool, website: undefined }], pool),
    ).not.toThrow();
  });
});

describe("validatePool", () => {
  it("reports success without throwing", () => {
    expect(validatePool([testOsmPlace({ osmId: "1" })])).toEqual({ ok: true });
  });

  it("reports the first failure without throwing", () => {
    const result = validatePool([
      testOsmPlace({ osmId: "1" }),
      testOsmPlace({ osmId: "1" }),
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("duplicate_place_id");
  });
});

describe("assertPlaceIsVerifiable", () => {
  it("is exported so callers can validate before pool construction", () => {
    expect(() => assertPlaceIsVerifiable(testOsmPlace({ osmId: "1" }))).not.toThrow();
  });
});
