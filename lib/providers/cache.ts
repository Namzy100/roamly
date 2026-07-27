/**
 * The provider-independent cache, shared by every adapter.
 *
 * Deliberately a tiny interface so the in-memory implementation below can be
 * swapped for Vercel KV, Redis or a filesystem cache without touching a single
 * caller. Only `get`/`set` are on the hot path; the rest exist for diagnostics
 * and tests.
 *
 * It lives here rather than under any one provider because it knows nothing
 * about any of them — `lib/providers/osm/cache.ts` and
 * `lib/providers/routing/cache.ts` each hold their own *instances* and TTL
 * policy, and share this implementation.
 *
 * ## Serverless caveat
 *
 * This is per-process memory. On Vercel or any serverless host, each instance has
 * its own copy, instances restart freely, and a cold start begins empty. So the
 * cache reduces repeat load and protects the public services from *our* loops —
 * it is not a durable store and must never be relied on for correctness. An
 * external cache is the fix when this stops being a weekend project.
 */
export type CacheEntry<T> = {
  value: T;
  /** Epoch ms after which the entry is stale. */
  expiresAt: number;
};

export type Cache = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  has(key: string): boolean;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
  stats(): CacheStats;
};

export type CacheStats = {
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
  expirations: number;
};

/** Bounded so a long-running process cannot grow without limit. */
export const DEFAULT_CACHE_MAX_ENTRIES = 500;

/**
 * Bounded TTL cache with least-recently-used eviction.
 *
 * A `Map` preserves insertion order, so re-inserting on read gives LRU ordering
 * for free: the oldest key is always the first one the iterator yields.
 */
export function createMemoryCache(
  maxEntries: number = DEFAULT_CACHE_MAX_ENTRIES,
  now: () => number = Date.now,
): Cache {
  const entries = new Map<string, CacheEntry<unknown>>();
  let hits = 0;
  let misses = 0;
  let evictions = 0;
  let expirations = 0;

  return {
    get<T>(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry) {
        misses += 1;
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        expirations += 1;
        misses += 1;
        return undefined;
      }
      // Re-insert so this key becomes the most recently used.
      entries.delete(key);
      entries.set(key, entry);
      hits += 1;
      return entry.value as T;
    },

    set<T>(key: string, value: T, ttlMs: number): void {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, { value, expiresAt: now() + ttlMs });

      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
        evictions += 1;
      }
    },

    has(key: string): boolean {
      const entry = entries.get(key);
      if (!entry) return false;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        expirations += 1;
        return false;
      }
      return true;
    },

    delete(key: string): void {
      entries.delete(key);
    },

    clear(): void {
      entries.clear();
    },

    get size(): number {
      return entries.size;
    },

    stats(): CacheStats {
      return {
        size: entries.size,
        maxEntries,
        hits,
        misses,
        evictions,
        expirations,
      };
    },
  };
}

/**
 * Namespaced, deterministic cache keys.
 *
 * Object keys are sorted before serialising so `{a,b}` and `{b,a}` produce one
 * entry rather than two, and numbers are rounded to a fixed precision so
 * floating-point noise in a coordinate cannot fragment the cache.
 */
export function cacheKey(
  namespace: string,
  parts: Record<string, unknown>,
): string {
  return `${namespace}:${cacheKeyBody(parts)}`;
}

function serialiseKeyPart(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") {
    // 6 decimal places is ~0.1 m at the equator — far finer than any place needs,
    // and enough to stop 38.7223 and 38.72230000000001 becoming two keys.
    return Number.isInteger(value) ? String(value) : value.toFixed(6);
  }
  if (Array.isArray(value)) {
    return `[${[...value].map(serialiseKeyPart).sort().join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${cacheKeyBody(value as Record<string, unknown>)}}`;
  }
  return String(value);
}

function cacheKeyBody(parts: Record<string, unknown>): string {
  return Object.keys(parts)
    .sort()
    .map((key) => `${key}=${serialiseKeyPart(parts[key])}`)
    .join("&");
}
