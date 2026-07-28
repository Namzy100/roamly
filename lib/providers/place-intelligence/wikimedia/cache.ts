import "server-only";

import { mayCache, type ProviderId } from "@/lib/place-intelligence";
import {
  cacheKey as sharedCacheKey,
  createMemoryCache,
  type CacheStats,
} from "@/lib/providers/cache";

import { WIKIMEDIA_CACHE_MAX_ENTRIES, WIKIMEDIA_CACHE_TTL_MS } from "./config";

/**
 * The Wikimedia adapter's cache namespaces and TTLs.
 *
 * ## Caching is an obligation here, not an optimisation
 *
 * Every other cache in this codebase exists to make Roamly faster. This one exists because Wikimedia's etiquette page
 * *asks* for it: the read path has no published rate limit, the services are volunteer-funded, and the documented
 * expectation is that clients cache rather than re-ask. So a cache miss is a cost to somebody else, which is why the
 * TTLs in `config.ts` are measured in hours rather than minutes — a monastery's founding date does not change, and a
 * short TTL would generate traffic to re-learn things that had not moved.
 *
 * ## Only normalized answers go in, and that is what keeps matching honest
 *
 * The values stored here are `NormalizedEntity`, `TitleResolution` and the like — never a raw payload, and never a
 * *match*. A cached entity still passes through `evaluateWikidataCandidate` and `mergeIntelligence` on every read,
 * so the cache can shorten the question and can never answer it. Storing an identity would be the dangerous
 * shortcut: a match made under one place's coordinates would then be served to another, and the trust ranking would
 * have been applied once, hours ago, to different evidence.
 *
 * Raw payloads are excluded for a second reason. They are large, they are mostly fields Roamly discards, and a cache
 * full of them is a copy of a provider's response living in process memory long after the request that justified it.
 *
 * ## What is never cached
 *
 * A transient failure and a malformed response have no route into this module: `writeCache` accepts only a value a
 * caller has already normalized, and every failure path in `client.ts` and `schemas.ts` *throws*. So "a timeout is
 * not cached as data" is a property of the control flow rather than a rule to remember — there is no
 * `cache.set(key, error)` to write by accident.
 *
 * A **safe empty result** is different and is cached, briefly. "Wikidata does not hold this QID" and "no entity
 * within 250 m" are real answers, and re-asking them on every render would be the exact traffic the etiquette page
 * objects to. Briefly, because an absence is the answer most likely to change as OSM and Wikidata gain coverage.
 *
 * ## Server only, in process memory
 *
 * No browser cache and no persistent store. This is the same per-process memory `lib/providers/cache.ts` documents:
 * it dies with the serverless instance, a cold start begins empty, and nothing may depend on it for correctness.
 * Persisting provider answers is what the sidecar in the trip record is for, and that goes through the persistence
 * policy rather than through here.
 */

/**
 * The five caches, one per question Roamly asks.
 *
 * Separate namespaces rather than one keyed by a `kind` field, because a namespace is what makes a key collision
 * impossible: a QID and a Commons file title are both strings, and one flat keyspace would let an entity answer a
 * media lookup if a key were ever built with the wrong parts.
 */
export type WikimediaCacheNamespace =
  /** `Special:EntityData/{QID}.json` — one entity, normalized. */
  | "wd-entity"
  /** `wbgetentities` — the same shape, reached in a batch. Shares the entity TTL and not its key. */
  | "wd-entities"
  /** A Wikipedia article title resolved to a QID, or the documented reason it was not. */
  | "wp-title"
  /** The candidates near one place, already normalized and ordered. */
  | "wd-nearby"
  /** One Commons file's normalized metadata. */
  | "commons-media";

/** Which provider's permission governs each namespace, so `mayCache` can be asked rather than assumed. */
const PROVIDER_OF: Record<WikimediaCacheNamespace, ProviderId> = {
  "wd-entity": "wikidata",
  "wd-entities": "wikidata",
  "wp-title": "wikidata",
  "wd-nearby": "wikidata",
  "commons-media": "wikimedia-commons",
};

const TTL_OF: Record<WikimediaCacheNamespace, number> = {
  "wd-entity": WIKIMEDIA_CACHE_TTL_MS.entity,
  "wd-entities": WIKIMEDIA_CACHE_TTL_MS.entity,
  "wp-title": WIKIMEDIA_CACHE_TTL_MS.titleResolution,
  "wd-nearby": WIKIMEDIA_CACHE_TTL_MS.search,
  "commons-media": WIKIMEDIA_CACHE_TTL_MS.media,
};

/**
 * How long a known absence is remembered.
 *
 * Fifteen minutes. Long enough that one page load does not re-ask the same question a dozen times, short enough that
 * a place gaining an entity today is enriched today. Deliberately much shorter than the success TTLs: a fact that
 * exists stays true for years, where a fact that is missing is missing only until somebody adds it.
 */
export const WIKIMEDIA_EMPTY_TTL_MS = 15 * 60 * 1_000;

/**
 * One process-wide cache, shared by the five namespaces.
 *
 * One instance rather than five, because the bound that matters is total memory and five separate 500-entry caches
 * would be a 2,500-entry budget nobody chose. The namespace lives in the key, which `lib/providers/cache.ts` is
 * built for.
 */
const cache = createMemoryCache(WIKIMEDIA_CACHE_MAX_ENTRIES);

/**
 * A deterministic key, namespaced.
 *
 * Delegates to the shared `cacheKey`, which sorts object keys and rounds numbers to six decimal places — the same
 * rounding `client.ts` applies to a coordinate before it reaches the SPARQL template, so a place's key and its query
 * cannot drift apart on floating-point noise.
 */
export function wikimediaCacheKey(
  namespace: WikimediaCacheNamespace,
  parts: Record<string, unknown>,
): string {
  return sharedCacheKey(namespace, parts);
}

/** A cached value, or `undefined`. Never throws: a cache miss and a cache failure are the same thing to a caller. */
export function readCache<T>(
  namespace: WikimediaCacheNamespace,
  parts: Record<string, unknown>,
): T | undefined {
  return cache.get<T>(wikimediaCacheKey(namespace, parts));
}

/**
 * Stores a normalized answer.
 *
 * `mayCache` is consulted rather than trusted from a comment. It answers `granted` for both providers today, so the
 * gate is inert — and it is here because that is the only way a future tightening of the policy table takes effect
 * without somebody remembering to come back to this file.
 */
export function writeCache<T>(
  namespace: WikimediaCacheNamespace,
  parts: Record<string, unknown>,
  value: T,
): void {
  if (mayCache(PROVIDER_OF[namespace]) !== "granted") return;
  cache.set(wikimediaCacheKey(namespace, parts), value, TTL_OF[namespace]);
}

/**
 * Stores a *known absence* under the short TTL.
 *
 * A separate function rather than a `ttlMs` argument, so the choice is visible at the call site: `writeEmptyCache`
 * reads as "we are remembering that there was nothing", where a numeric argument would read as a tuning knob and
 * would eventually be passed the success TTL by accident.
 */
export function writeEmptyCache<T>(
  namespace: WikimediaCacheNamespace,
  parts: Record<string, unknown>,
  value: T,
): void {
  if (mayCache(PROVIDER_OF[namespace]) !== "granted") return;
  cache.set(wikimediaCacheKey(namespace, parts), value, WIKIMEDIA_EMPTY_TTL_MS);
}

/** For the dev diagnostics surface and for tests asserting a second lookup did not re-request. */
export function wikimediaCacheStats(): CacheStats {
  return cache.stats();
}

/** Tests only. A shared process cache would otherwise leak an entity from one case into the next. */
export function clearWikimediaCache(): void {
  cache.clear();
}
