import { describe, expect, it } from "vitest";

import { TravelSegmentSchema } from "@/lib/schemas/trip-plan";

import {
  ESTIMATE_LABEL,
  ROUTED_BASIS_LABEL,
  durationSecondsToMinutes,
  formatRouteResult,
  formatRoutedDistance,
  formatRoutedDuration,
} from "./format";
import { toTravelSegment } from "./segment";
import type { RouteResult } from "./types";

/**
 * The bridge from a routing result to a renderable itinerary segment, and the
 * wording rules that apply once it gets there.
 */

const LEG = {
  id: "leg:1__2",
  fromPlaceId: "osm:node:1",
  toPlaceId: "osm:node:2",
};

const ROUTED: RouteResult = {
  status: "routed",
  provider: "valhalla",
  mode: "walk",
  origin: { latitude: 38.71391, longitude: -9.1394 },
  destination: { latitude: 38.710055, longitude: -9.133 },
  distanceMeters: 881,
  durationSeconds: 681.558,
  geometry: {
    type: "LineString",
    coordinates: [
      [-9.1394, 38.71391],
      [-9.133, 38.710055],
    ],
  },
  fetchedAt: "2026-07-26T12:00:00.000Z",
  attribution: "© OpenStreetMap contributors",
};

const UNAVAILABLE: RouteResult = {
  status: "unavailable",
  requestedMode: "bicycle",
  reason: "no_route",
  userMessage: "No route could be found between these two places.",
};

describe("toTravelSegment", () => {
  it("produces a routed segment that validates", () => {
    const segment = toTravelSegment(LEG, ROUTED);

    expect(TravelSegmentSchema.safeParse(segment).success).toBe(true);
    expect(segment.status).toBe("routed");
    if (segment.status !== "routed") return;
    expect(segment.mode).toBe("WALK");
    expect(segment.durationSeconds).toBeCloseTo(681.558, 3);
    // Derived deterministically from seconds, not carried separately.
    expect(segment.durationMinutes).toBe(11);
    expect(segment.geometry.coordinates).toHaveLength(2);
  });

  it("produces an unavailable segment that validates and carries no numbers", () => {
    const segment = toTravelSegment(LEG, UNAVAILABLE);

    expect(TravelSegmentSchema.safeParse(segment).success).toBe(true);
    expect(segment.status).toBe("unavailable");
    expect("distanceMeters" in segment).toBe(false);
    expect("geometry" in segment).toBe(false);
  });

  it("carries the requested mode onto an unavailable segment", () => {
    const segment = toTravelSegment(LEG, UNAVAILABLE);
    expect(segment.status === "unavailable" && segment.requestedMode).toBe("BICYCLE");
  });

  it("translates each mode into the itinerary vocabulary", () => {
    for (const [mode, expected] of [
      ["walk", "WALK"],
      ["drive", "DRIVE"],
      ["bicycle", "BICYCLE"],
    ] as const) {
      const segment = toTravelSegment(LEG, { ...ROUTED, mode });
      expect(segment.status === "routed" && segment.mode).toBe(expected);
    }
  });

  it("attaches an optional note without changing the claim", () => {
    const segment = toTravelSegment(LEG, ROUTED, "Downhill through Baixa.");
    expect(segment.note).toBe("Downhill through Baixa.");
  });
});

describe("durationSecondsToMinutes", () => {
  it("rounds to the nearest minute", () => {
    expect(durationSecondsToMinutes(681.558)).toBe(11);
    expect(durationSecondsToMinutes(90)).toBe(2);
    expect(durationSecondsToMinutes(89)).toBe(1);
  });

  it("floors at one minute, never zero", () => {
    // A routed leg took *some* time. Rounding it to "0 min" would read as no
    // journey at all, which is the unavailable arm's job to say.
    expect(durationSecondsToMinutes(5)).toBe(1);
    expect(durationSecondsToMinutes(0.1)).toBe(1);
  });
});

describe("user-facing wording", () => {
  it('formats a duration as "12 min walk"', () => {
    expect(formatRoutedDuration(720, "walk")).toBe("12 min walk");
  });

  it('formats a distance as "3.2 km drive"', () => {
    expect(formatRoutedDistance(3_200, "drive")).toBe("3.2 km drive");
  });

  it('says "Route unavailable" and nothing numeric', () => {
    const label = formatRouteResult(UNAVAILABLE);

    expect(label).toBe("Route unavailable");
    expect(label).not.toMatch(/\d/);
  });

  it("summarises a routed result with both figures", () => {
    expect(formatRouteResult(ROUTED)).toBe("11 min walk · 880 m");
  });

  it("credits road data without claiming traffic", () => {
    expect(ROUTED_BASIS_LABEL).toBe("Routed using OpenStreetMap road data");

    for (const forbidden of [
      /live traffic/i,
      /fastest right now/i,
      /real-?time/i,
      /transit/i,
      /guaranteed/i,
    ]) {
      expect(ROUTED_BASIS_LABEL).not.toMatch(forbidden);
      expect(ESTIMATE_LABEL).not.toMatch(forbidden);
      expect(formatRouteResult(ROUTED)).not.toMatch(forbidden);
      expect(formatRouteResult(UNAVAILABLE)).not.toMatch(forbidden);
    }
  });

  it("labels an estimate as an estimate", () => {
    expect(ESTIMATE_LABEL).toBe("Estimated travel time");
  });
});
