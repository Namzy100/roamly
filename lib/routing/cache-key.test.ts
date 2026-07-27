import { describe, expect, it } from "vitest";

import { createMemoryCache } from "@/lib/providers/cache";

import {
  ROUTE_CACHE_COORDINATE_PRECISION,
  matrixCacheKey,
  routeCacheKey,
} from "./cache-key";
import type { MatrixRequest, RouteRequest } from "./types";

/**
 * Key construction, and the bounded-cache behaviour it feeds.
 *
 * A cache key has two ways to be wrong and they fail in opposite directions:
 * too coarse and it returns someone else's route, too fine and it never hits.
 * Both are tested here rather than inferred from the rounding constant.
 */

const BASE: RouteRequest = {
  origin: { latitude: 38.7139, longitude: -9.1394 },
  destination: { latitude: 38.7101, longitude: -9.133 },
  mode: "walk",
};

describe("routeCacheKey", () => {
  it("is namespaced", () => {
    expect(routeCacheKey(BASE)).toMatch(/^valhalla-route:/);
  });

  it("is deterministic", () => {
    expect(routeCacheKey(BASE)).toBe(routeCacheKey({ ...BASE }));
  });

  it("separates modes", () => {
    // The walking and driving routes between two points are different paths
    // with different durations. Collapsing them is the worst cache bug here.
    expect(routeCacheKey({ ...BASE, mode: "walk" })).not.toBe(
      routeCacheKey({ ...BASE, mode: "drive" }),
    );
    expect(routeCacheKey({ ...BASE, mode: "bicycle" })).not.toBe(
      routeCacheKey({ ...BASE, mode: "drive" }),
    );
  });

  it("separates directions", () => {
    // A one-way system means A→B and B→A are genuinely different routes.
    expect(
      routeCacheKey({ ...BASE, origin: BASE.destination, destination: BASE.origin }),
    ).not.toBe(routeCacheKey(BASE));
  });

  it("rounds away float noise", () => {
    expect(
      routeCacheKey({
        ...BASE,
        origin: { latitude: 38.71390000001, longitude: -9.13940000002 },
      }),
    ).toBe(routeCacheKey(BASE));
  });

  it("does not collapse coordinates a road's width apart", () => {
    // 5 dp is ~1.1 m. Two doorways on opposite sides of a block must not share
    // a key, or the cache returns the wrong route rather than a redundant one.
    expect(ROUTE_CACHE_COORDINATE_PRECISION).toBe(5);
    expect(
      routeCacheKey({
        ...BASE,
        origin: { latitude: 38.7139, longitude: -9.1404 },
      }),
    ).not.toBe(routeCacheKey(BASE));
  });

  it("ignores canonicalPlaceId", () => {
    // Correlation metadata, not identity: two stops at the same coordinates
    // should share a cached route rather than fetch it twice.
    expect(
      routeCacheKey({
        ...BASE,
        origin: { ...BASE.origin, canonicalPlaceId: "osm:node:1" },
      }),
    ).toBe(routeCacheKey(BASE));
  });

  it("separates alternatives from the plain request", () => {
    expect(routeCacheKey({ ...BASE, alternatives: true })).not.toBe(
      routeCacheKey(BASE),
    );
  });

  it("treats an omitted unit as the default it resolves to", () => {
    expect(routeCacheKey({ ...BASE, units: "kilometers" })).toBe(routeCacheKey(BASE));
  });
});

describe("matrixCacheKey", () => {
  const MATRIX: MatrixRequest = {
    sources: [
      { latitude: 38.7139, longitude: -9.1394 },
      { latitude: 38.7101, longitude: -9.133 },
    ],
    targets: [{ latitude: 38.6968, longitude: -9.2035 }],
    mode: "drive",
  };

  it("is deterministic", () => {
    expect(matrixCacheKey(MATRIX)).toBe(matrixCacheKey({ ...MATRIX }));
  });

  it("respects source ordering", () => {
    // A matrix is read positionally, so reordering the sources produces a
    // different answer, not the same one shuffled.
    expect(
      matrixCacheKey({ ...MATRIX, sources: [...MATRIX.sources].reverse() }),
    ).not.toBe(matrixCacheKey(MATRIX));
  });

  it("distinguishes sources from targets", () => {
    expect(
      matrixCacheKey({ sources: MATRIX.targets, targets: MATRIX.sources, mode: "drive" }),
    ).not.toBe(matrixCacheKey(MATRIX));
  });

  it("separates modes", () => {
    expect(matrixCacheKey({ ...MATRIX, mode: "walk" })).not.toBe(
      matrixCacheKey(MATRIX),
    );
  });

  it("shares no namespace with route keys", () => {
    expect(matrixCacheKey(MATRIX).startsWith("valhalla-matrix:")).toBe(true);
  });
});

describe("routing cache storage", () => {
  function clock(start = 1_000) {
    let now = start;
    return { now: () => now, advance: (ms: number) => (now += ms) };
  }

  it("expires an entry after its TTL", () => {
    const time = clock();
    const cache = createMemoryCache(10, time.now);

    cache.set(routeCacheKey(BASE), { status: "routed" }, 1_000);
    time.advance(999);
    expect(cache.get(routeCacheKey(BASE))).toBeDefined();

    time.advance(2);
    expect(cache.get(routeCacheKey(BASE))).toBeUndefined();
  });

  it("evicts the least recently used entry when bounded", () => {
    const cache = createMemoryCache(2);

    cache.set("a", 1, 60_000);
    cache.set("b", 2, 60_000);
    cache.get("a"); // `a` is now the most recently used.
    cache.set("c", 3, 60_000);

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });

  it("reports eviction and expiry separately for diagnostics", () => {
    const time = clock();
    const cache = createMemoryCache(1, time.now);

    cache.set("a", 1, 100);
    cache.set("b", 2, 100);
    expect(cache.stats().evictions).toBe(1);

    time.advance(200);
    cache.get("b");
    expect(cache.stats().expirations).toBe(1);
  });
});
