import { describe, expect, it } from "vitest";

import {
  RoutedSegmentSchema,
  RouteRequestSchema,
  RouteResultSchema,
  RoutingModeSchema,
  UnavailableRouteSegmentSchema,
} from "./schemas";
import { isUsableMeasurement, validateRoutedGeometry } from "./validate";
import {
  RoutedTravelSegmentSchema,
  EstimatedTravelSegmentSchema,
  TravelSegmentSchema,
  UnavailableTravelSegmentSchema,
  segmentDurationMinutes,
  isRoutedSegment,
} from "@/lib/schemas/trip-plan";

/**
 * The contracts, and the states they must make unrepresentable.
 *
 * The point of the discriminated union is that a wrong claim cannot be
 * *expressed*, not merely that nobody writes one. So most of these tests assert
 * a rejection: zero distance, zero duration, geometry on an estimate, a duration
 * on an unavailable leg, transit on a routed one.
 */

const GEOMETRY = {
  type: "LineString" as const,
  coordinates: [
    [-9.1394, 38.71391],
    [-9.133, 38.710055],
  ] as [number, number][],
};

const ROUTED = {
  status: "routed",
  provider: "valhalla",
  mode: "walk",
  origin: { latitude: 38.71391, longitude: -9.1394 },
  destination: { latitude: 38.710055, longitude: -9.133 },
  distanceMeters: 881,
  durationSeconds: 681.558,
  geometry: GEOMETRY,
  fetchedAt: "2026-07-26T12:00:00.000Z",
  attribution: "© OpenStreetMap contributors",
};

const UNAVAILABLE = {
  status: "unavailable",
  requestedMode: "drive",
  reason: "no_route",
  userMessage: "No route could be found between these two places.",
};

describe("RoutedSegmentSchema", () => {
  it("accepts a well-formed routed segment", () => {
    expect(RoutedSegmentSchema.safeParse(ROUTED).success).toBe(true);
  });

  it("rejects a zero distance", () => {
    // Zero is how a naive implementation says "failed". The unavailable arm is
    // the only way to say that here.
    expect(
      RoutedSegmentSchema.safeParse({ ...ROUTED, distanceMeters: 0 }).success,
    ).toBe(false);
  });

  it("rejects a zero duration", () => {
    expect(
      RoutedSegmentSchema.safeParse({ ...ROUTED, durationSeconds: 0 }).success,
    ).toBe(false);
  });

  it("rejects a negative measurement", () => {
    expect(
      RoutedSegmentSchema.safeParse({ ...ROUTED, distanceMeters: -1 }).success,
    ).toBe(false);
  });

  it("rejects geometry with fewer than two points", () => {
    expect(
      RoutedSegmentSchema.safeParse({
        ...ROUTED,
        geometry: { type: "LineString", coordinates: [[-9.1394, 38.71391]] },
      }).success,
    ).toBe(false);
  });

  it("rejects an out-of-range coordinate", () => {
    expect(
      RoutedSegmentSchema.safeParse({
        ...ROUTED,
        geometry: {
          type: "LineString",
          coordinates: [
            [-9.1394, 38.71391],
            [-9.133, 138.71],
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects an unsupported mode", () => {
    expect(RoutedSegmentSchema.safeParse({ ...ROUTED, mode: "transit" }).success).toBe(
      false,
    );
  });

  it("rejects a provider other than valhalla", () => {
    expect(
      RoutedSegmentSchema.safeParse({ ...ROUTED, provider: "mock" }).success,
    ).toBe(false);
  });
});

describe("UnavailableRouteSegmentSchema", () => {
  it("accepts a well-formed unavailable segment", () => {
    expect(UnavailableRouteSegmentSchema.safeParse(UNAVAILABLE).success).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(
      UnavailableRouteSegmentSchema.safeParse({ ...UNAVAILABLE, reason: "vibes" })
        .success,
    ).toBe(false);
  });

  it("requires a user-facing message", () => {
    expect(
      UnavailableRouteSegmentSchema.safeParse({ ...UNAVAILABLE, userMessage: "" })
        .success,
    ).toBe(false);
  });
});

describe("RouteResultSchema", () => {
  it("discriminates on status", () => {
    const routed = RouteResultSchema.safeParse(ROUTED);
    const unavailable = RouteResultSchema.safeParse(UNAVAILABLE);

    expect(routed.success).toBe(true);
    expect(unavailable.success).toBe(true);
    expect(routed.success && routed.data.status).toBe("routed");
  });

  it("rejects a hybrid claiming both arms", () => {
    // "unavailable, and here is a route anyway" must not parse.
    expect(
      RouteResultSchema.safeParse({ ...UNAVAILABLE, geometry: GEOMETRY, status: "both" })
        .success,
    ).toBe(false);
  });
});

describe("RoutingModeSchema", () => {
  it("accepts exactly the three supported modes", () => {
    expect(RoutingModeSchema.options).toEqual(["walk", "drive", "bicycle"]);
  });

  it("rejects transit", () => {
    expect(RoutingModeSchema.safeParse("transit").success).toBe(false);
  });
});

describe("RouteRequestSchema", () => {
  it("rejects an out-of-range latitude", () => {
    expect(
      RouteRequestSchema.safeParse({
        origin: { latitude: 138, longitude: 0 },
        destination: { latitude: 0, longitude: 0 },
        mode: "walk",
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* TravelSegment — the itinerary-facing union                                  */
/* -------------------------------------------------------------------------- */

const ENDPOINTS = {
  id: "leg:a__b",
  fromPlaceId: "osm:node:1",
  toPlaceId: "osm:node:2",
  note: null,
};

const ROUTED_SEGMENT = {
  ...ENDPOINTS,
  status: "routed",
  provider: "valhalla",
  mode: "WALK",
  distanceMeters: 881,
  durationSeconds: 681.558,
  durationMinutes: 11,
  geometry: GEOMETRY,
  fetchedAt: "2026-07-26T12:00:00.000Z",
  attribution: "© OpenStreetMap contributors",
};

const ESTIMATED_SEGMENT = {
  ...ENDPOINTS,
  status: "estimated",
  provider: "mock",
  mode: "TRANSIT",
  estimatedDurationMinutes: 20,
  estimatedDistanceMeters: 5_000,
  basis: "Sample itinerary data",
  confidence: "low",
  disclaimer: "Estimated travel time.",
};

const UNAVAILABLE_SEGMENT = {
  ...ENDPOINTS,
  status: "unavailable",
  requestedMode: "DRIVE",
  reason: "no_route",
  userMessage: "No route could be found between these two places.",
};

describe("TravelSegmentSchema", () => {
  it("accepts all three arms", () => {
    expect(TravelSegmentSchema.safeParse(ROUTED_SEGMENT).success).toBe(true);
    expect(TravelSegmentSchema.safeParse(ESTIMATED_SEGMENT).success).toBe(true);
    expect(TravelSegmentSchema.safeParse(UNAVAILABLE_SEGMENT).success).toBe(true);
  });

  it("rejects a segment with no status — the pre-Phase-4 shape", () => {
    // This is exactly what a stored v2 plan looks like, and why the schema
    // version had to move.
    expect(
      TravelSegmentSchema.safeParse({
        ...ENDPOINTS,
        mode: "WALK",
        durationMinutes: 16,
        distanceMeters: 1_200,
      }).success,
    ).toBe(false);
  });

  it("rejects transit on a routed segment", () => {
    // We cannot route transit, so a routed transit leg cannot exist.
    expect(
      RoutedTravelSegmentSchema.safeParse({ ...ROUTED_SEGMENT, mode: "TRANSIT" })
        .success,
    ).toBe(false);
  });

  it("allows transit on an estimate", () => {
    expect(
      EstimatedTravelSegmentSchema.safeParse(ESTIMATED_SEGMENT).success,
    ).toBe(true);
  });

  it("rejects an estimate that claims a provider route", () => {
    expect(
      EstimatedTravelSegmentSchema.safeParse({
        ...ESTIMATED_SEGMENT,
        provider: "valhalla",
      }).success,
    ).toBe(false);
  });

  it("requires a disclaimer on an estimate", () => {
    const { disclaimer: _omitted, ...withoutDisclaimer } = ESTIMATED_SEGMENT;
    expect(EstimatedTravelSegmentSchema.safeParse(withoutDisclaimer).success).toBe(
      false,
    );
  });

  it("drops unknown fields rather than letting geometry ride on an estimate", () => {
    const parsed = TravelSegmentSchema.safeParse({
      ...ESTIMATED_SEGMENT,
      geometry: GEOMETRY,
    });

    expect(parsed.success).toBe(true);
    // The union has no `geometry` on this arm, so it does not survive parsing —
    // there is no path by which an estimate reaches the map as a line.
    expect(parsed.success && "geometry" in parsed.data).toBe(false);
  });

  it("gives an unavailable segment no numbers to render", () => {
    const parsed = UnavailableTravelSegmentSchema.safeParse({
      ...UNAVAILABLE_SEGMENT,
      distanceMeters: 500,
      durationMinutes: 9,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && "distanceMeters" in parsed.data).toBe(false);
    expect(parsed.success && "durationMinutes" in parsed.data).toBe(false);
  });

  it("rejects a zero-duration routed segment", () => {
    expect(
      RoutedTravelSegmentSchema.safeParse({ ...ROUTED_SEGMENT, durationMinutes: 0 })
        .success,
    ).toBe(false);
  });
});

describe("segment accessors", () => {
  it("reads a duration from whichever arm has one", () => {
    const routed = TravelSegmentSchema.parse(ROUTED_SEGMENT);
    const estimated = TravelSegmentSchema.parse(ESTIMATED_SEGMENT);
    const unavailable = TravelSegmentSchema.parse(UNAVAILABLE_SEGMENT);

    expect(segmentDurationMinutes(routed)).toBe(11);
    expect(segmentDurationMinutes(estimated)).toBe(20);
    // Null, not zero. An unroutable leg must not read as instant travel.
    expect(segmentDurationMinutes(unavailable)).toBeNull();
  });

  it("identifies routed segments", () => {
    expect(isRoutedSegment(TravelSegmentSchema.parse(ROUTED_SEGMENT))).toBe(true);
    expect(isRoutedSegment(TravelSegmentSchema.parse(ESTIMATED_SEGMENT))).toBe(false);
  });
});

describe("validateRoutedGeometry", () => {
  it("accepts two or more finite in-range points", () => {
    expect(validateRoutedGeometry(GEOMETRY.coordinates).ok).toBe(true);
  });

  it("rejects a single point", () => {
    const result = validateRoutedGeometry([[-9.1394, 38.71391]]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("too_few_points");
  });

  it("rejects a non-finite coordinate", () => {
    const result = validateRoutedGeometry([
      [-9.1394, 38.71391],
      [Number.NaN, 38.71],
    ]);
    expect(!result.ok && result.reason).toBe("non_finite_coordinate");
  });

  it("rejects an out-of-range coordinate", () => {
    const result = validateRoutedGeometry([
      [-9.1394, 38.71391],
      [-9.133, 91],
    ]);
    expect(!result.ok && result.reason).toBe("out_of_range_coordinate");
  });
});

describe("isUsableMeasurement", () => {
  it("requires a finite, strictly positive number", () => {
    expect(isUsableMeasurement(1)).toBe(true);
    expect(isUsableMeasurement(0)).toBe(false);
    expect(isUsableMeasurement(-1)).toBe(false);
    expect(isUsableMeasurement(Number.NaN)).toBe(false);
    expect(isUsableMeasurement(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
