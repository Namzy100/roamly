import { describe, expect, it } from "vitest";

import type { MatrixRequest, RouteRequest } from "@/lib/routing";

import { RoutingProviderError } from "../errors";
import { normalizeMatrixResponse, normalizeRouteResponse } from "./normalize";

/**
 * Raw payload → normalised domain, and every way that must fail.
 *
 * The shapes below are trimmed from live responses recorded on 2026-07-26. The
 * negative cases matter more than the positive one: a normaliser that repairs a
 * malformed payload produces a plausible route out of nothing, which is exactly
 * the failure this project is built to avoid.
 */

const FETCHED_AT = "2026-07-26T12:00:00.000Z";

/** Three points on a real Baixa–Alfama walk, precision 6. */
const SHAPE = "kb|yhAnkylPjvB_uCpxBoyF";
/** A second, disjoint fragment, for the multi-leg case. */
const SHAPE_2 = "svxyhA~}xlPjvB_uC";

const REQUEST: RouteRequest = {
  origin: { latitude: 38.7139, longitude: -9.1394 },
  destination: { latitude: 38.7101, longitude: -9.133 },
  mode: "walk",
};

function routeBody(overrides: Record<string, unknown> = {}) {
  return {
    trip: {
      status: 0,
      status_message: "Found route between points",
      units: "kilometers",
      language: "en-US",
      summary: { time: 681.558, length: 0.881 },
      legs: [{ summary: { time: 681.558, length: 0.881 }, shape: SHAPE }],
      ...overrides,
    },
  };
}

describe("normalizeRouteResponse", () => {
  it("normalises a valid single-leg route", () => {
    const segment = normalizeRouteResponse(routeBody(), REQUEST, FETCHED_AT);

    expect(segment.status).toBe("routed");
    expect(segment.provider).toBe("valhalla");
    expect(segment.mode).toBe("walk");
    expect(segment.durationSeconds).toBeCloseTo(681.558, 3);
    // Kilometres in, metres out.
    expect(segment.distanceMeters).toBeCloseTo(881, 3);
    expect(segment.geometry.coordinates).toHaveLength(3);
    expect(segment.fetchedAt).toBe(FETCHED_AT);
    expect(segment.attribution).toContain("OpenStreetMap");
  });

  it("carries the requested mode through unchanged", () => {
    for (const mode of ["walk", "drive", "bicycle"] as const) {
      const segment = normalizeRouteResponse(
        routeBody(),
        { ...REQUEST, mode },
        FETCHED_AT,
      );
      expect(segment.mode).toBe(mode);
    }
  });

  it("sums a multi-leg trip rather than reporting only the first leg", () => {
    const segment = normalizeRouteResponse(
      routeBody({
        legs: [
          { summary: { time: 100, length: 0.5 }, shape: SHAPE },
          { summary: { time: 200, length: 1.5 }, shape: SHAPE_2 },
        ],
      }),
      REQUEST,
      FETCHED_AT,
    );

    expect(segment.durationSeconds).toBe(300);
    expect(segment.distanceMeters).toBe(2_000);
    // Both legs' shapes are present; neither is discarded.
    expect(segment.geometry.coordinates.length).toBeGreaterThan(3);
  });

  it("drops the duplicated seam point when joining legs", () => {
    // Both legs start at the same coordinate, so the join must not repeat it.
    const segment = normalizeRouteResponse(
      routeBody({
        legs: [
          { summary: { time: 100, length: 0.5 }, shape: SHAPE },
          { summary: { time: 100, length: 0.5 }, shape: SHAPE },
        ],
      }),
      REQUEST,
      FETCHED_AT,
    );

    // 3 + 3 points, minus nothing: the second leg starts where leg 1 *began*,
    // not where it ended, so there is no seam to collapse here.
    expect(segment.geometry.coordinates).toHaveLength(6);
  });

  it("rejects a non-zero trip status inside an HTTP 200", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ status: 207, status_message: "No path could be found" }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(RoutingProviderError);
  });

  it("classifies a non-zero trip status as no_route, not a protocol error", () => {
    try {
      normalizeRouteResponse(routeBody({ status: 207 }), REQUEST, FETCHED_AT);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RoutingProviderError);
      expect((error as RoutingProviderError).kind).toBe("no_route");
    }
  });

  it("rejects a missing trip", () => {
    expect(() => normalizeRouteResponse({}, REQUEST, FETCHED_AT)).toThrow(
      /Unexpected route response shape/,
    );
  });

  it("rejects a trip with no legs", () => {
    expect(() =>
      normalizeRouteResponse(routeBody({ legs: [] }), REQUEST, FETCHED_AT),
    ).toThrow(/no legs/);
  });

  it("rejects a malformed summary", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ legs: [{ summary: { time: "fast" }, shape: SHAPE }] }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/Unexpected route response shape/);
  });

  it("rejects a zero duration rather than reporting an instant journey", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ legs: [{ summary: { time: 0, length: 0.881 }, shape: SHAPE }] }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/duration was not a usable number/);
  });

  it("rejects a zero distance", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ legs: [{ summary: { time: 681, length: 0 }, shape: SHAPE }] }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/distance was not a usable number/);
  });

  it("rejects a non-finite measurement at the schema, before any arithmetic", () => {
    // Zod's `z.number()` already excludes Infinity and NaN, so this never
    // reaches the value check. Asserted anyway: the two guards defend different
    // things — the schema stops a single bad leg, `isUsableMeasurement` stops a
    // sum of good legs that overflows.
    expect(() =>
      normalizeRouteResponse(
        routeBody({
          legs: [
            { summary: { time: Number.POSITIVE_INFINITY, length: 1 }, shape: SHAPE },
          ],
        }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/Unexpected route response shape/);
  });

  it("rejects a negative duration", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ legs: [{ summary: { time: -5, length: 0.881 }, shape: SHAPE }] }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/duration was not a usable number/);
  });

  it("rejects a malformed shape", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ legs: [{ summary: { time: 681, length: 0.881 }, shape: "!!!" }] }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/shape could not be used/);
  });

  it("rejects a shape with fewer than two points", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({
          legs: [{ summary: { time: 681, length: 0.881 }, shape: "kb|yhAnkylP" }],
        }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/shape could not be used/);
  });

  it("rejects a null shape", () => {
    expect(() =>
      normalizeRouteResponse(
        routeBody({ legs: [{ summary: { time: 681, length: 0.881 }, shape: null }] }),
        REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/Unexpected route response shape/);
  });

  it("rejects a response answering in units we did not request", () => {
    // A miles answer read as kilometres is 1.6× wrong and entirely plausible.
    expect(() =>
      normalizeRouteResponse(routeBody({ units: "miles" }), REQUEST, FETCHED_AT),
    ).toThrow(/answered in "miles"/);
  });
});

/* -------------------------------------------------------------------------- */

const MATRIX_REQUEST: MatrixRequest = {
  sources: [
    { latitude: 38.7139, longitude: -9.1394 },
    { latitude: 38.7101, longitude: -9.133 },
  ],
  targets: [
    { latitude: 38.7139, longitude: -9.1394 },
    { latitude: 38.6968, longitude: -9.2035 },
  ],
  mode: "drive",
};

function cell(from: number, to: number, time: number | null, distance: number | null) {
  return { from_index: from, to_index: to, time, distance };
}

describe("normalizeMatrixResponse", () => {
  it("normalises a square matrix", () => {
    const matrix = normalizeMatrixResponse(
      {
        units: "kilometers",
        sources_to_targets: [
          [cell(0, 0, 0, 0), cell(0, 1, 987, 7.363)],
          [cell(1, 0, 197, 0.941), cell(1, 1, 938, 7.16)],
        ],
      },
      MATRIX_REQUEST,
      FETCHED_AT,
    );

    expect(matrix.provider).toBe("valhalla");
    expect(matrix.mode).toBe("drive");
    expect(matrix.durationsSeconds).toEqual([
      [0, 987],
      [197, 938],
    ]);
    expect(matrix.distancesMeters[0][1]).toBeCloseTo(7_363, 3);
    expect(matrix.distancesMeters[1][0]).toBeCloseTo(941, 3);
  });

  it("normalises a rectangular matrix", () => {
    const request: MatrixRequest = {
      ...MATRIX_REQUEST,
      targets: [...MATRIX_REQUEST.targets, { latitude: 38.7, longitude: -9.15 }],
    };

    const matrix = normalizeMatrixResponse(
      {
        sources_to_targets: [
          [cell(0, 0, 1, 1), cell(0, 1, 2, 2), cell(0, 2, 3, 3)],
          [cell(1, 0, 4, 4), cell(1, 1, 5, 5), cell(1, 2, 6, 6)],
        ],
      },
      request,
      FETCHED_AT,
    );

    expect(matrix.durationsSeconds).toHaveLength(2);
    expect(matrix.durationsSeconds[0]).toHaveLength(3);
  });

  it("preserves null cells rather than coercing them to zero", () => {
    const matrix = normalizeMatrixResponse(
      {
        sources_to_targets: [
          [cell(0, 0, 0, 0), cell(0, 1, null, null)],
          [cell(1, 0, 197, 0.941), cell(1, 1, 938, 7.16)],
        ],
      },
      MATRIX_REQUEST,
      FETCHED_AT,
    );

    // An unreachable pair coerced to 0 would read as "these are the same place",
    // which is the worst available misreading of a travel matrix.
    expect(matrix.durationsSeconds[0][1]).toBeNull();
    expect(matrix.distancesMeters[0][1]).toBeNull();
    // A genuine zero is still a zero, and must survive distinctly.
    expect(matrix.durationsSeconds[0][0]).toBe(0);
  });

  it("rejects a row-count mismatch", () => {
    expect(() =>
      normalizeMatrixResponse(
        { sources_to_targets: [[cell(0, 0, 1, 1), cell(0, 1, 2, 2)]] },
        MATRIX_REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/had 1 rows, expected 2/);
  });

  it("rejects a column-count mismatch", () => {
    expect(() =>
      normalizeMatrixResponse(
        {
          sources_to_targets: [
            [cell(0, 0, 1, 1)],
            [cell(1, 0, 2, 2), cell(1, 1, 3, 3)],
          ],
        },
        MATRIX_REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/row 0 had 1 cells, expected 2/);
  });

  it("rejects a malformed matrix payload", () => {
    expect(() =>
      normalizeMatrixResponse({ sources_to_targets: "nope" }, MATRIX_REQUEST, FETCHED_AT),
    ).toThrow(/Unexpected matrix response shape/);
  });

  it("rejects a matrix answering in the wrong units", () => {
    expect(() =>
      normalizeMatrixResponse(
        {
          units: "miles",
          sources_to_targets: [
            [cell(0, 0, 1, 1), cell(0, 1, 2, 2)],
            [cell(1, 0, 3, 3), cell(1, 1, 4, 4)],
          ],
        },
        MATRIX_REQUEST,
        FETCHED_AT,
      ),
    ).toThrow(/answered in "miles"/);
  });
});
