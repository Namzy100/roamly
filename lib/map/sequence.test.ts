import { describe, expect, it } from "vitest";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";

import { deriveVisibleMapPlaces } from "./derive";
import { buildSequenceGeoJson, buildSequenceLines } from "./sequence";
import type { VisibleMapPlace } from "./types";

function stop(
  itemId: string,
  sequenceNumber: number,
  dayNumber: number,
  longitude = -9.14,
  latitude = 38.72,
): VisibleMapPlace {
  return {
    itemId,
    placeId: itemId,
    sequenceNumber,
    name: itemId,
    longitude,
    latitude,
    kind: "stop",
    dayNumber,
  };
}

const stay: VisibleMapPlace = {
  itemId: "accommodation:hotel",
  placeId: "hotel",
  sequenceNumber: 0,
  name: "Hotel",
  longitude: -9.13,
  latitude: 38.71,
  kind: "accommodation",
  dayNumber: null,
};

describe("buildSequenceLines", () => {
  it("returns nothing for an empty list", () => {
    expect(buildSequenceLines([])).toEqual([]);
  });

  it("returns nothing for a day with a single stop", () => {
    // One point is not a line; drawing a zero-length segment renders as a blob.
    expect(buildSequenceLines([stop("a", 1, 1)])).toEqual([]);
  });

  it("joins a day's stops in itinerary order", () => {
    const lines = buildSequenceLines([
      stop("b", 2, 1, -9.15, 38.73),
      stop("a", 1, 1, -9.14, 38.72),
      stop("c", 3, 1, -9.16, 38.74),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].coordinates).toEqual([
      [-9.14, 38.72],
      [-9.15, 38.73],
      [-9.16, 38.74],
    ]);
  });

  it("excludes the accommodation", () => {
    // The stay is a base, not a step in the day's sequence.
    const lines = buildSequenceLines([
      stop("a", 1, 1),
      stop("b", 2, 1, -9.15, 38.73),
      stay,
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0].coordinates).toHaveLength(2);
  });

  it("keeps each day separate rather than joining across days", () => {
    const lines = buildSequenceLines([
      stop("d1a", 1, 1),
      stop("d1b", 2, 1, -9.15, 38.73),
      stop("d2a", 3, 2, -9.2, 38.69),
      stop("d2b", 4, 2, -9.21, 38.7),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => line.dayNumber)).toEqual([1, 2]);
    // The crucial assertion: no segment bridges day 1's last stop to day 2's
    // first, which would draw a phantom overnight journey.
    expect(lines[0].coordinates).toHaveLength(2);
    expect(lines[1].coordinates).toHaveLength(2);
  });

  it("orders lines by day number regardless of input order", () => {
    const lines = buildSequenceLines([
      stop("d3a", 1, 3),
      stop("d3b", 2, 3, -9.15, 38.73),
      stop("d1a", 3, 1, -9.2, 38.69),
      stop("d1b", 4, 1, -9.21, 38.7),
    ]);

    expect(lines.map((line) => line.dayNumber)).toEqual([1, 3]);
  });
});

describe("buildSequenceGeoJson", () => {
  it("emits one LineString feature per day", () => {
    const geojson = buildSequenceGeoJson([
      stop("d1a", 1, 1),
      stop("d1b", 2, 1, -9.15, 38.73),
      stop("d2a", 3, 2, -9.2, 38.69),
      stop("d2b", 4, 2, -9.21, 38.7),
      stay,
    ]);

    expect(geojson.type).toBe("FeatureCollection");
    expect(geojson.features).toHaveLength(2);
    expect(geojson.features[0].geometry.type).toBe("LineString");
    expect(geojson.features[0].properties.dayNumber).toBe(1);
    expect(geojson.features[1].properties.dayNumber).toBe(2);
  });

  it("emits an empty collection rather than null when there is nothing to draw", () => {
    // MapLibre needs a valid source object even with no features.
    expect(buildSequenceGeoJson([])).toEqual({
      type: "FeatureCollection",
      features: [],
    });
  });

  it("produces five separate lines for the Lisbon mock in All Days", () => {
    const geojson = buildSequenceGeoJson(
      deriveVisibleMapPlaces(mockTripPlan, "all"),
    );

    expect(geojson.features).toHaveLength(5);
    expect(geojson.features.map((f) => f.properties.dayNumber)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    // Day 1 has five stops, so four segments and five vertices.
    expect(geojson.features[0].geometry.coordinates).toHaveLength(5);
  });

  it("produces one line for a single active day", () => {
    const geojson = buildSequenceGeoJson(
      deriveVisibleMapPlaces(mockTripPlan, 2),
    );

    expect(geojson.features).toHaveLength(1);
    expect(geojson.features[0].properties.dayNumber).toBe(2);
  });
});
