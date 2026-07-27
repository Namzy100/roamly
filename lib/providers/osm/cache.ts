import {
  cacheKey as sharedCacheKey,
  createMemoryCache,
  type Cache,
  type CacheEntry,
  type CacheStats,
} from "@/lib/providers/cache";

import { CACHE_MAX_ENTRIES } from "./config";

/**
 * The OSM adapter's cache instances and namespaces.
 *
 * The implementation itself is provider-independent and lives in
 * `lib/providers/cache.ts`; this module owns only *which* caches exist for this
 * provider and what their namespaces are called. Routing has its own equivalent.
 */
export { createMemoryCache };
export type { Cache, CacheEntry, CacheStats };

/** Narrowed to this provider's two namespaces, so a typo cannot invent a third. */
export function cacheKey(
  namespace: "nominatim" | "overpass",
  parts: Record<string, unknown>,
): string {
  return sharedCacheKey(namespace, parts);
}

/** Process-wide caches, one namespace per provider. */
export const nominatimCache = createMemoryCache(CACHE_MAX_ENTRIES);
export const overpassCache = createMemoryCache(CACHE_MAX_ENTRIES);

/** For the dev diagnostics surface only — never rendered in normal UI. */
export function providerCacheStats(): Record<string, CacheStats> {
  return {
    nominatim: nominatimCache.stats(),
    overpass: overpassCache.stats(),
  };
}
