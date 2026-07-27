import { describe, expect, it } from "vitest";

import { deriveVisibleMapPlaces } from "./derive";
import { mockTripPlan } from "@/lib/mock/lisbon-trip";
import {
  boundsOf,
  cameraTargetFor,
  isDegenerate,
  isWithinViewport,
} from "./bounds";
import type { VisibleMapPlace } from "./types";

function place(
  itemId: string,
  longitude: number,
  latitude: number,
): VisibleMapPlace {
  return {
    itemId,
    placeId: itemId,
    sequenceNumber: 1,
    name: itemId,
    longitude,
    latitude,
    kind: "stop",
    dayNumber: 1,
  };
}

describe("boundsOf", () => {
  it("returns null for no places", () => {
    expect(boundsOf([])).toBeNull();
  });

  it("returns a point box for a single place", () => {
    const bounds = boundsOf([place("a", -9.14, 38.72)]);
    expect(bounds).toEqual({
      west: -9.14,
      south: 38.72,
      east: -9.14,
      north: 38.72,
    });
    expect(isDegenerate(bounds!)).toBe(true);
  });

  it("spans every place", () => {
    const bounds = boundsOf([
      place("a", -9.2, 38.69),
      place("b", -9.1, 38.73),
      place("c", -9.39, 38.79),
    ]);

    expect(bounds).toEqual({
      west: -9.39,
      south: 38.69,
      east: -9.1,
      north: 38.79,
    });
  });

  it("treats identical coordinates as degenerate", () => {
    const bounds = boundsOf([
      place("a", -9.14, 38.72),
      place("b", -9.14, 38.72),
    ]);
    expect(isDegenerate(bounds!)).toBe(true);
  });
});

describe("cameraTargetFor", () => {
  it("does nothing when there are no places", () => {
    expect(cameraTargetFor([])).toEqual({ type: "none" });
  });

  it("centres rather than fits for one place", () => {
    // Fitting a zero-span box makes every map library jump to max zoom, which
    // reads as a bug. Centring and letting the caller cap the zoom is correct.
    expect(cameraTargetFor([place("a", -9.14, 38.72)])).toEqual({
      type: "center",
      longitude: -9.14,
      latitude: 38.72,
    });
  });

  it("centres for several places at identical coordinates", () => {
    const target = cameraTargetFor([
      place("a", -9.14, 38.72),
      place("b", -9.14, 38.72),
    ]);
    expect(target.type).toBe("center");
  });

  it("fits bounds for a spread of places", () => {
    const target = cameraTargetFor([
      place("a", -9.2, 38.69),
      place("b", -9.39, 38.79),
    ]);

    expect(target).toEqual({
      type: "bounds",
      bounds: { west: -9.39, south: 38.69, east: -9.2, north: 38.79 },
    });
  });

  it("spans Lisbon and Sintra in the All Days view", () => {
    const target = cameraTargetFor(deriveVisibleMapPlaces(mockTripPlan, "all"));

    expect(target.type).toBe("bounds");
    if (target.type !== "bounds") return;
    // Sintra sits well west and north of the Lisbon stops; the box must cover it.
    expect(target.bounds.west).toBeLessThan(-9.39);
    expect(target.bounds.north).toBeGreaterThan(38.79);
    expect(target.bounds.east).toBeGreaterThan(-9.12);
  });
});

describe("isWithinViewport", () => {
  const viewport = { west: -10, south: 38, east: -9, north: 39 };

  it("accepts a point comfortably inside", () => {
    expect(isWithinViewport({ longitude: -9.5, latitude: 38.5 }, viewport)).toBe(
      true,
    );
  });

  it("rejects a point outside", () => {
    expect(isWithinViewport({ longitude: -8.5, latitude: 38.5 }, viewport)).toBe(
      false,
    );
  });

  it("rejects a point technically visible but hard against the edge", () => {
    // Inside the raw box, but within the inset margin — so the camera should
    // still nudge, otherwise the marker sits under the panel's overlay chrome.
    expect(
      isWithinViewport({ longitude: -9.95, latitude: 38.5 }, viewport),
    ).toBe(false);
  });

  it("honours a custom inset", () => {
    const point = { longitude: -9.95, latitude: 38.5 };
    expect(isWithinViewport(point, viewport, 0)).toBe(true);
    expect(isWithinViewport(point, viewport, 0.12)).toBe(false);
  });
});
