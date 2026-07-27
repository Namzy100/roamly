import { describe, expect, it } from "vitest";

import { cacheKey, createMemoryCache } from "./cache";

/** A controllable clock, so TTL behaviour is tested without real waiting. */
function fakeClock(start = 1_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createMemoryCache", () => {
  it("returns a stored value before it expires", () => {
    const clock = fakeClock();
    const cache = createMemoryCache(10, clock.now);
    cache.set("k", { hello: "world" }, 1_000);
    expect(cache.get("k")).toEqual({ hello: "world" });
  });

  it("treats an expired entry as a miss and removes it", () => {
    const clock = fakeClock();
    const cache = createMemoryCache(10, clock.now);
    cache.set("k", "v", 1_000);

    clock.advance(1_001);

    expect(cache.get("k")).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(cache.stats().expirations).toBe(1);
  });

  it("expires exactly at the boundary", () => {
    const clock = fakeClock();
    const cache = createMemoryCache(10, clock.now);
    cache.set("k", "v", 1_000);
    clock.advance(1_000);
    expect(cache.get("k")).toBeUndefined();
  });

  it("counts hits and misses", () => {
    const cache = createMemoryCache(10, fakeClock().now);
    cache.set("k", "v", 1_000);
    cache.get("k");
    cache.get("absent");
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(1);
  });

  it("stays bounded, evicting the least recently used entry", () => {
    const cache = createMemoryCache(3, fakeClock().now);
    cache.set("a", 1, 10_000);
    cache.set("b", 2, 10_000);
    cache.set("c", 3, 10_000);

    // Touching "a" makes "b" the oldest.
    cache.get("a");
    cache.set("d", 4, 10_000);

    expect(cache.size).toBe(3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("d")).toBe(4);
    expect(cache.stats().evictions).toBe(1);
  });

  it("does not grow past the bound under sustained writes", () => {
    const cache = createMemoryCache(50, fakeClock().now);
    for (let i = 0; i < 5_000; i += 1) cache.set(`k${i}`, i, 10_000);
    expect(cache.size).toBe(50);
  });

  it("overwrites rather than duplicating an existing key", () => {
    const cache = createMemoryCache(10, fakeClock().now);
    cache.set("k", 1, 1_000);
    cache.set("k", 2, 1_000);
    expect(cache.size).toBe(1);
    expect(cache.get("k")).toBe(2);
  });

  it("supports has, delete and clear", () => {
    const clock = fakeClock();
    const cache = createMemoryCache(10, clock.now);
    cache.set("k", 1, 1_000);
    expect(cache.has("k")).toBe(true);

    clock.advance(2_000);
    expect(cache.has("k")).toBe(false);

    cache.set("x", 1, 1_000);
    cache.delete("x");
    expect(cache.has("x")).toBe(false);

    cache.set("y", 1, 1_000);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it("supports a short TTL for empty results independently of long ones", () => {
    const clock = fakeClock();
    const cache = createMemoryCache(10, clock.now);
    cache.set("empty", [], 600_000);
    cache.set("full", [1], 21_600_000);

    clock.advance(600_001);

    expect(cache.get("empty")).toBeUndefined();
    expect(cache.get("full")).toEqual([1]);
  });
});

describe("cacheKey", () => {
  it("is namespaced per provider", () => {
    expect(cacheKey("nominatim", { q: "lisbon" })).toMatch(/^nominatim:/);
    expect(cacheKey("overpass", { q: "lisbon" })).toMatch(/^overpass:/);
    expect(cacheKey("nominatim", { q: "x" })).not.toBe(
      cacheKey("overpass", { q: "x" }),
    );
  });

  it("is order-independent for object keys", () => {
    expect(cacheKey("overpass", { a: 1, b: 2 })).toBe(
      cacheKey("overpass", { b: 2, a: 1 }),
    );
  });

  it("is order-independent for array values", () => {
    // Category order must not fragment the cache; the query builder sorts anyway.
    expect(cacheKey("overpass", { c: ["museum", "cafe"] })).toBe(
      cacheKey("overpass", { c: ["cafe", "museum"] }),
    );
  });

  it("normalises float noise so near-identical coordinates share one entry", () => {
    expect(cacheKey("overpass", { lat: 38.7223 })).toBe(
      cacheKey("overpass", { lat: 38.72230000000001 }),
    );
  });

  it("still distinguishes genuinely different coordinates", () => {
    expect(cacheKey("overpass", { lat: 38.7223 })).not.toBe(
      cacheKey("overpass", { lat: 38.7224 }),
    );
  });

  it("distinguishes absent from empty and from zero", () => {
    const absent = cacheKey("nominatim", { country: undefined });
    const empty = cacheKey("nominatim", { country: "" });
    const zero = cacheKey("nominatim", { country: 0 });
    expect(absent).toBe(empty); // both mean "not supplied"
    expect(zero).not.toBe(absent);
  });

  it("handles nested objects deterministically", () => {
    expect(
      cacheKey("overpass", { center: { latitude: 1, longitude: 2 } }),
    ).toBe(cacheKey("overpass", { center: { longitude: 2, latitude: 1 } }));
  });
});
