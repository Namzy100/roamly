import { createMemoryCache, type CacheStats } from "@/lib/providers/cache";

import { ROUTING_CACHE_MAX_ENTRIES } from "./config";

/**
 * The routing namespace's cache instance.
 *
 * The implementation is the shared, provider-independent one in
 * `lib/providers/cache.ts`; this module owns only the instance and its bound.
 * Keys are built in `lib/routing/cache-key.ts`, which rounds coordinates to 5 dp
 * — see the reasoning there.
 *
 * **Serverless caveat.** Per-process memory. Instances do not share it, cold
 * starts begin empty, and nothing may rely on a hit for correctness. It exists
 * to spare a donated demo server our repeat questions, not to be a store.
 */
export const routingCache = createMemoryCache(ROUTING_CACHE_MAX_ENTRIES);

/** For the dev diagnostics surface only — never rendered in normal UI. */
export function routingCacheStats(): CacheStats {
  return routingCache.stats();
}
