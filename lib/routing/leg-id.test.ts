import { describe, expect, it } from "vitest";

import {
  ACCOMMODATION_ORIGIN_ID,
  ACCOMMODATION_RETURN_ID,
  InvalidLegIdError,
  accommodationLegEndpointId,
  isRoutingLegId,
  parseRoutingLegId,
  routingLegId,
} from "./leg-id";

/**
 * Leg identity.
 *
 * Every enrichment guarantee rests on this: a result is attached to a leg
 * because their ids match, so an id that collides across days, modes or
 * itinerary positions would attach a real duration to the wrong walk.
 */

describe("routingLegId", () => {
  it("is deterministic", () => {
    const parts = {
      dayNumber: 2,
      fromItemId: "a",
      toItemId: "b",
      mode: "walk" as const,
    };
    expect(routingLegId(parts)).toBe(routingLegId({ ...parts }));
  });

  it("has the documented shape", () => {
    expect(
      routingLegId({
        dayNumber: 3,
        fromItemId: "d3_i1",
        toItemId: "d3_i2",
        mode: "drive",
      }),
    ).toBe("day:3:from:d3_i1:to:d3_i2:mode:drive");
  });

  it("separates identical stop pairs on different days", () => {
    // The same market visited on Tuesday and Thursday is two journeys.
    const tuesday = routingLegId({
      dayNumber: 2,
      fromItemId: "a",
      toItemId: "b",
      mode: "walk",
    });
    const thursday = routingLegId({
      dayNumber: 4,
      fromItemId: "a",
      toItemId: "b",
      mode: "walk",
    });
    expect(tuesday).not.toBe(thursday);
  });

  it("separates modes", () => {
    const walk = routingLegId({
      dayNumber: 1,
      fromItemId: "a",
      toItemId: "b",
      mode: "walk",
    });
    const drive = routingLegId({
      dayNumber: 1,
      fromItemId: "a",
      toItemId: "b",
      mode: "drive",
    });
    expect(walk).not.toBe(drive);
  });

  it("is directional", () => {
    expect(
      routingLegId({ dayNumber: 1, fromItemId: "a", toItemId: "b", mode: "walk" }),
    ).not.toBe(
      routingLegId({ dayNumber: 1, fromItemId: "b", toItemId: "a", mode: "walk" }),
    );
  });

  it("cannot be confused by a colon in an item id", () => {
    // A colon would make the id ambiguous to parse, so it is rejected at
    // construction rather than discovered later as a mis-parse.
    expect(() =>
      routingLegId({
        dayNumber: 1,
        fromItemId: "a:b",
        toItemId: "c",
        mode: "walk",
      }),
    ).toThrow(InvalidLegIdError);
  });

  it("rejects an empty item id", () => {
    expect(() =>
      routingLegId({ dayNumber: 1, fromItemId: "", toItemId: "b", mode: "walk" }),
    ).toThrow(InvalidLegIdError);
  });

  it("rejects a non-positive or non-integer day", () => {
    for (const dayNumber of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        routingLegId({ dayNumber, fromItemId: "a", toItemId: "b", mode: "walk" }),
      ).toThrow(InvalidLegIdError);
    }
  });
});

describe("parseRoutingLegId", () => {
  it("round-trips", () => {
    const parts = {
      dayNumber: 5,
      fromItemId: "d5_i3_osm-node-1",
      toItemId: "d5_i4_osm-node-2",
      mode: "bicycle" as const,
    };
    expect(parseRoutingLegId(routingLegId(parts))).toEqual(parts);
  });

  it("returns null for a non-leg-id", () => {
    for (const value of [
      "leg:1__2",
      "day:1:from:a:to:b",
      "day:x:from:a:to:b:mode:walk",
      "day:1:from:a:to:b:mode:transit",
      "",
    ]) {
      expect(parseRoutingLegId(value)).toBeNull();
    }
  });

  it("agrees with isRoutingLegId", () => {
    const id = routingLegId({
      dayNumber: 1,
      fromItemId: "a",
      toItemId: "b",
      mode: "walk",
    });
    expect(isRoutingLegId(id)).toBe(true);
    expect(isRoutingLegId("nope")).toBe(false);
  });
});

describe("accommodation endpoints", () => {
  it("gives the outbound and return legs distinct identities", () => {
    expect(accommodationLegEndpointId("origin")).toBe(ACCOMMODATION_ORIGIN_ID);
    expect(accommodationLegEndpointId("return")).toBe(ACCOMMODATION_RETURN_ID);
    expect(ACCOMMODATION_ORIGIN_ID).not.toBe(ACCOMMODATION_RETURN_ID);
  });

  it("survives a round trip through a leg id", () => {
    // They are hyphenated rather than colon-separated precisely so they can.
    const id = routingLegId({
      dayNumber: 1,
      fromItemId: ACCOMMODATION_ORIGIN_ID,
      toItemId: "stop-1",
      mode: "walk",
    });
    expect(parseRoutingLegId(id)?.fromItemId).toBe(ACCOMMODATION_ORIGIN_ID);
  });

  it("cannot collide with a real item id", () => {
    // `nanoid` and the mock's `d1_i2_<placeId>` scheme both exclude "@".
    expect(ACCOMMODATION_ORIGIN_ID.startsWith("@")).toBe(true);
    expect(ACCOMMODATION_RETURN_ID.startsWith("@")).toBe(true);
  });
});
