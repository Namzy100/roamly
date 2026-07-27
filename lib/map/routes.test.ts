import { describe, expect, it } from "vitest";

import { buildRouteGeoJson, routeCoordinates } from "./routes";
import { buildSequenceGeoJson } from "./sequence";
import type { MapRouteLine, VisibleMapPlace } from "./types";

/**
 * The route layer, and its relationship to the sequence layer.
 *
 * The property worth protecting is that they stay two things. A day with one
 * unroutable leg must still show its full visit order, and a routed line must
 * never be mistaken for a straight one — so the two collections are built
 * independently and neither suppresses the other.
 */

function line(legId: string, overrides: Partial<MapRouteLine> = {}): MapRouteLine {
  return {
    legId,
    mode: "walk",
    coordinates: [
      [-9.1394, 38.71391],
      [-9.137, 38.712],
      [-9.133, 38.710055],
    ],
    dayNumber: 1,
    ...overrides,
  };
}

function stop(itemId: string, longitude: number, latitude: number): VisibleMapPlace {
  return {
    itemId,
    placeId: `osm:node:${itemId}`,
    sequenceNumber: Number(itemId),
    name: itemId,
    longitude,
    latitude,
    kind: "stop",
    dayNumber: 1,
  };
}

describe("buildRouteGeoJson", () => {
  it("emits one feature per routed leg", () => {
    const collection = buildRouteGeoJson([line("1"), line("2")]);

    expect(collection.type).toBe("FeatureCollection");
    expect(collection.features).toHaveLength(2);
    expect(collection.features[0].geometry.type).toBe("LineString");
  });

  it("emits nothing for no routes", () => {
    expect(buildRouteGeoJson([]).features).toEqual([]);
  });

  it("carries mode and day as feature properties, for styling", () => {
    const [feature] = buildRouteGeoJson([line("1", { mode: "drive" })]).features;

    expect(feature.properties.mode).toBe("drive");
    expect(feature.properties.dayNumber).toBe(1);
    expect(feature.properties.legId).toBe("1");
  });

  it("defaults `selected` to false rather than undefined", () => {
    // A MapLibre `["get", "selected"]` expression on undefined evaluates to
    // null, which does not behave as false in a `case`.
    expect(buildRouteGeoJson([line("1")]).features[0].properties.selected).toBe(false);
  });

  it("marks the selected leg", () => {
    const collection = buildRouteGeoJson([
      line("1"),
      line("2", { selected: true }),
    ]);

    expect(collection.features.map((f) => f.properties.selected)).toEqual([
      false,
      true,
    ]);
  });

  it("preserves coordinate order", () => {
    const [feature] = buildRouteGeoJson([line("1")]).features;

    // GeoJSON is [longitude, latitude]; Lisbon is at ~-9.1, ~38.7.
    expect(feature.geometry.coordinates[0][0]).toBeCloseTo(-9.1394, 5);
    expect(feature.geometry.coordinates[0][1]).toBeCloseTo(38.71391, 5);
  });
});

describe("routeCoordinates", () => {
  it("flattens every vertex for camera fitting", () => {
    expect(routeCoordinates([line("1"), line("2")])).toHaveLength(6);
  });

  it("returns positioned objects the bounds helper accepts", () => {
    const [first] = routeCoordinates([line("1")]);
    expect(first).toEqual({ longitude: -9.1394, latitude: 38.71391 });
  });

  it("is empty for no routes", () => {
    expect(routeCoordinates([])).toEqual([]);
  });
});

describe("the two layers coexist", () => {
  const places = [stop("1", -9.1394, 38.71391), stop("2", -9.133, 38.710055)];

  it("keeps the sequence line even when a route exists", () => {
    const sequence = buildSequenceGeoJson(places);
    const routes = buildRouteGeoJson([line("1")]);

    // Visit order and walked path are different facts. Dropping the first
    // because the second arrived would lose information, not tidy it away.
    expect(sequence.features).toHaveLength(1);
    expect(routes.features).toHaveLength(1);
  });

  it("differs geometrically from the sequence line", () => {
    const sequence = buildSequenceGeoJson(places);
    const routes = buildRouteGeoJson([line("1")]);

    // Two stops make a two-point straight line; the routed path follows roads
    // and has more vertices. If these ever matched, the route would be fake.
    expect(sequence.features[0].geometry.coordinates).toHaveLength(2);
    expect(
      routes.features[0].geometry.coordinates.length,
    ).toBeGreaterThan(sequence.features[0].geometry.coordinates.length);
  });

  it("draws no route feature for a day whose legs all failed", () => {
    // The caller filters unavailable legs out before building lines, and the
    // type has no arm that could express one — so an all-failed day yields an
    // empty collection while the sequence line survives intact.
    expect(buildRouteGeoJson([]).features).toEqual([]);
    expect(buildSequenceGeoJson(places).features).toHaveLength(1);
  });
});
