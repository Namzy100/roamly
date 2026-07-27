import { cacheKey } from "@/lib/providers/cache";

import type { MatrixRequest, RouteRequest, RouteLocation } from "./types";

/**
 * Deterministic routing cache keys.
 *
 * ## Why coordinates are rounded to 5 decimal places
 *
 * 5 dp is ~1.1 m at the equator. Finer than that and a coordinate re-read from
 * JSON with one bit of float noise becomes a second cache entry, so the cache
 * quietly stops working. Coarser — 4 dp, ~11 m — and two genuinely different
 * doorways on opposite sides of a block could share a key, which would return
 * the wrong route rather than merely a redundant one.
 *
 * The shared `cacheKey` helper rounds to 6 dp; routing rounds harder, before
 * handing values over, because a route's endpoints are snapped to the nearest
 * road by the provider anyway. `canonicalPlaceId` is deliberately **excluded**:
 * it is correlation metadata, and two stops at the same coordinates should share
 * a cached route rather than fetch it twice.
 */
const COORDINATE_PRECISION = 5;

function roundedPair(location: RouteLocation): string {
  return `${location.latitude.toFixed(COORDINATE_PRECISION)},${location.longitude.toFixed(
    COORDINATE_PRECISION,
  )}`;
}

/**
 * A key for one route request.
 *
 * Mode is part of the key, not an afterthought: the walking and driving routes
 * between the same two points are different paths with different durations, and
 * collapsing them is the most damaging cache bug available here.
 */
export function routeCacheKey(request: RouteRequest): string {
  return cacheKey("valhalla-route", {
    from: roundedPair(request.origin),
    to: roundedPair(request.destination),
    mode: request.mode,
    alternatives: request.alternatives === true,
    units: request.units ?? "kilometers",
    language: request.language ?? "en-US",
  });
}

/**
 * A key for one matrix request.
 *
 * Source and target order is preserved in the key — unlike the shared helper's
 * array handling, which sorts. A matrix result is indexed positionally, so two
 * requests with the same points in a different order are genuinely different
 * answers and must not share an entry.
 */
export function matrixCacheKey(request: MatrixRequest): string {
  return cacheKey("valhalla-matrix", {
    sources: request.sources.map(roundedPair).join(";"),
    targets: request.targets.map(roundedPair).join(";"),
    mode: request.mode,
  });
}

/** Exposed so tests can assert the rounding rule directly. */
export const ROUTE_CACHE_COORDINATE_PRECISION = COORDINATE_PRECISION;
