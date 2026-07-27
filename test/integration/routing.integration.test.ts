import { describe, expect, it } from "vitest";

import { isRoutingProviderError } from "@/lib/providers/routing/errors";
import { routeMatrix, routeSegment } from "@/lib/providers/routing/service";
import type { RoutingMatrix, RouteResult } from "@/lib/routing/types";

/**
 * Opt-in live check against the public Valhalla demo server.
 *
 * Run with `npm run test:integration:routing`. Deliberately **excluded** from
 * `npm test` — `valhalla1.openstreetmap.de` is FOSSGIS demo infrastructure, and
 * a unit suite that hit it on every save would be exactly the abuse the limiter
 * and cache exist to prevent.
 *
 * Responsible-use properties:
 *  - **four requests total**: one pedestrian route, one automobile route, one
 *    2×2 matrix, and one cached repeat that makes no request at all
 *  - two fixed Lisbon coordinates, ~880 m apart
 *  - the real limiter and the real identifying headers
 *  - no polling and no loop
 *  - a provider outage **skips** rather than fails, so this can never break CI
 *    over someone else's server load
 */

/** Praça do Comércio and Sé de Lisboa. Fixed, so the cache actually helps. */
const COMERCIO = { latitude: 38.7075, longitude: -9.1364 };
const SE = { latitude: 38.7098, longitude: -9.1327 };

/** The demo server sheds load rather than queueing. Not our bug. */
function isOutage(result: RouteResult): boolean {
  return (
    result.status === "unavailable" &&
    ["provider_unavailable", "timeout", "rate_limited"].includes(result.reason)
  );
}

describe("live Valhalla routing", () => {
  let pedestrian: RouteResult | null = null;

  it("routes a pedestrian leg", async () => {
    const result = await routeSegment({
      origin: COMERCIO,
      destination: SE,
      mode: "walk",
    });

    if (isOutage(result)) {
      console.log("  SKIPPED — Valhalla demo server unavailable right now");
      return;
    }

    expect(result.status).toBe("routed");
    if (result.status !== "routed") return;
    pedestrian = result;

    expect(result.mode).toBe("walk");
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(result.durationSeconds).toBeGreaterThan(0);
    expect(result.geometry.coordinates.length).toBeGreaterThanOrEqual(2);

    // The endpoints must be near what we asked for. Valhalla snaps to the road
    // network, so a few tens of metres is expected; a kilometre would mean the
    // shape belongs to a different journey, or the coordinates are swapped.
    const [firstLon, firstLat] = result.geometry.coordinates[0];
    const [lastLon, lastLat] = result.geometry.coordinates.at(-1)!;
    expect(Math.abs(firstLat - COMERCIO.latitude)).toBeLessThan(0.005);
    expect(Math.abs(firstLon - COMERCIO.longitude)).toBeLessThan(0.005);
    expect(Math.abs(lastLat - SE.latitude)).toBeLessThan(0.005);
    expect(Math.abs(lastLon - SE.longitude)).toBeLessThan(0.005);

    console.log(
      `  pedestrian: ${Math.round(result.distanceMeters)} m, ` +
        `${Math.round(result.durationSeconds)} s, ` +
        `${result.geometry.coordinates.length} shape points`,
    );
    console.log(`  attribution: ${result.attribution}`);
  });

  it("routes an automobile leg, and it differs from the walk", async () => {
    const result = await routeSegment({
      origin: COMERCIO,
      destination: SE,
      mode: "drive",
    });

    if (isOutage(result)) {
      console.log("  SKIPPED — Valhalla demo server unavailable right now");
      return;
    }

    expect(result.status).toBe("routed");
    if (result.status !== "routed") return;

    expect(result.mode).toBe("drive");
    expect(result.distanceMeters).toBeGreaterThan(0);
    expect(result.durationSeconds).toBeGreaterThan(0);

    if (pedestrian?.status === "routed") {
      // Different costing profiles produce genuinely different paths in Alfama's
      // one-way streets. Identical results would mean the mode is being ignored.
      expect(result.geometry.coordinates).not.toEqual(pedestrian.geometry.coordinates);
    }

    console.log(
      `  automobile: ${Math.round(result.distanceMeters)} m, ` +
        `${Math.round(result.durationSeconds)} s`,
    );
  });

  it("fetches a small time-distance matrix", async () => {
    let matrix: RoutingMatrix;
    try {
      matrix = await routeMatrix({
        sources: [COMERCIO, SE],
        targets: [COMERCIO, SE],
        mode: "drive",
      });
    } catch (error) {
      if (
        isRoutingProviderError(error) &&
        ["provider_unavailable", "timeout", "rate_limited"].includes(error.kind)
      ) {
        console.log("  SKIPPED — Valhalla demo server unavailable right now");
        return;
      }
      throw error;
    }

    expect(matrix.durationsSeconds).toHaveLength(2);
    expect(matrix.durationsSeconds[0]).toHaveLength(2);
    expect(matrix.distancesMeters).toHaveLength(2);

    // The diagonal is a point to itself: zero, and legitimately so.
    expect(matrix.durationsSeconds[0][0]).toBe(0);
    // The off-diagonal is a real journey.
    expect(matrix.durationsSeconds[0][1]).toBeGreaterThan(0);

    console.log(
      `  matrix 2x2: ${JSON.stringify(matrix.durationsSeconds)} seconds`,
    );
  });

  it("serves an identical repeat from cache", async () => {
    if (pedestrian?.status !== "routed") {
      console.log("  SKIPPED — nothing cached to re-request");
      return;
    }

    const repeat = await routeSegment({
      origin: COMERCIO,
      destination: SE,
      mode: "walk",
    });

    // Same object, including `fetchedAt` — which is what proves the cache
    // genuinely spared the demo server a second request rather than merely
    // returning an equal-looking answer.
    expect(repeat).toEqual(pedestrian);
    expect(repeat.status === "routed" && repeat.fetchedAt).toBe(pedestrian.fetchedAt);
  });
});
