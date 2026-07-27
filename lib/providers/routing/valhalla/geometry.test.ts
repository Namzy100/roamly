import { describe, expect, it } from "vitest";

import {
  VALHALLA_POLYLINE_PRECISION,
  decodePolyline,
  decodeRouteGeometry,
} from "./geometry";

/**
 * Polyline decoding, pinned to fixtures.
 *
 * The algorithm is not the risk here — the *precision* and the *coordinate
 * order* are. Both fail silently: precision 5 on a precision-6 shape produces
 * perfectly finite coordinates ten times too large, and a lat/lon swap produces
 * coordinates that pass every range check. Neither throws, so both need a
 * fixture with known values rather than a property test.
 */

/**
 * Three points on the Baixa–Alfama walk, encoded at precision 6.
 *
 * Regenerated from the same coordinates listed below, so the fixture and its
 * expectation cannot drift apart silently.
 */
const LISBON_SHAPE = "kb|yhAnkylPjvB_uCpxBoyF";

const LISBON_POINTS: [number, number][] = [
  // [longitude, latitude] — GeoJSON order, which is the reverse of the wire.
  [-9.1394, 38.71391],
  [-9.137, 38.712],
  [-9.132992, 38.710055],
];

/** The first leg of a real Lisbon pedestrian route, captured 2026-07-26. */
const LIVE_SHAPE_PREFIX = "kb|yhAtkylPI{@DmAVgAd@{@p@i@x@WtB{D";

describe("decodePolyline", () => {
  it("decodes a known fixture to exact coordinates", () => {
    expect(decodePolyline(LISBON_SHAPE)).toEqual(LISBON_POINTS);
  });

  it("emits [longitude, latitude], not [latitude, longitude]", () => {
    const [first] = decodePolyline(LISBON_SHAPE);

    // Lisbon is ~38.7°N, ~9.1°W. A swap would put longitude at 38.7, which is a
    // valid longitude — so the check has to be on the values, not the ranges.
    expect(first[0]).toBeCloseTo(-9.1394, 6);
    expect(first[1]).toBeCloseTo(38.71391, 6);
  });

  it("defaults to precision 6, as Valhalla emits", () => {
    expect(VALHALLA_POLYLINE_PRECISION).toBe(6);

    // The regression this guards: decoding a precision-6 shape at precision 5
    // yields coordinates 10× too large, silently. 387.1 is not a latitude.
    const wrong = decodePolyline(LISBON_SHAPE, 5);
    expect(wrong[0][1]).toBeCloseTo(387.1391, 4);
    expect(Math.abs(wrong[0][1])).toBeGreaterThan(90);
  });

  it("decodes a live-captured shape into plausible Lisbon coordinates", () => {
    const points = decodePolyline(LIVE_SHAPE_PREFIX);

    expect(points.length).toBeGreaterThan(2);
    for (const [longitude, latitude] of points) {
      expect(latitude).toBeGreaterThan(38.6);
      expect(latitude).toBeLessThan(38.8);
      expect(longitude).toBeGreaterThan(-9.3);
      expect(longitude).toBeLessThan(-9.0);
    }
  });

  it("rejects an empty string", () => {
    expect(() => decodePolyline("")).toThrow(/empty|not a string/i);
  });

  it("rejects a string truncated mid-value", () => {
    // Every continuation byte is >= 0x20 + 63; ending on one means the varint
    // never terminated.
    expect(() => decodePolyline("kb|yhAnkyl")).toThrow(/truncated|mid-value/i);
  });

  it("rejects characters outside the polyline alphabet", () => {
    // The encoding only ever emits printable ASCII from 63 (`?`) upward, so a
    // control character means this is not a polyline. Written as an escape
    // because the literal character is invisible in a source file.
    expect(() => decodePolyline("kb|yhA\u0001\u0002")).toThrow(/alphabet/i);

    // A plausible-looking non-polyline string hits the same guard.
    expect(() => decodePolyline("not-a-polyline!!!")).toThrow(/alphabet/i);
  });

  it("rejects an over-long encoded value", () => {
    // Every char here is a continuation byte, so the varint never terminates
    // and passes 35 bits — far more than any coordinate delta needs.
    expect(() => decodePolyline("ÿ".repeat(10))).toThrow(/over-long/i);
  });

  it("round-trips deltas, so a long shape does not accumulate error", () => {
    const points = decodePolyline(LISBON_SHAPE);
    expect(points[2]).toEqual([-9.132992, 38.710055]);
  });
});

describe("decodeRouteGeometry", () => {
  it("returns validated GeoJSON for a good shape", () => {
    const result = decodeRouteGeometry(LISBON_SHAPE);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.geometry.type).toBe("LineString");
    expect(result.geometry.coordinates).toEqual(LISBON_POINTS);
  });

  it("rejects a shape that decodes to a single point", () => {
    // One point encoded alone. A route between two distinct places that resolves
    // to one coordinate is a decoding failure, not a very short walk.
    const single = "kb|yhAnkylP";
    const result = decodeRouteGeometry(single);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/at least 2 points/i);
  });

  it("rejects a malformed string without throwing", () => {
    const result = decodeRouteGeometry("not-a-polyline!!!");
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range coordinates", () => {
    // Decoded at precision 5 the fixture lands at latitude 387°, which is not a
    // place. This is the precision-regression guard in its validated form.
    const result = decodeRouteGeometry(LISBON_SHAPE, 5);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/out of geographic range/i);
  });
});
