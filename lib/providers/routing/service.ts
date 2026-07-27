import "server-only";

import { isRoutingMode, matrixCacheKey, routeCacheKey } from "@/lib/routing";
import type {
  MatrixRequest,
  RouteRequest,
  RouteResult,
  RouteUnavailableReason,
  RoutingMatrix,
  UnavailableRouteSegment,
} from "@/lib/routing";

import { routingCache } from "./cache";
import { ROUTING_CACHE_TTL_MS, ROUTING_LIMITS } from "./config";
import { mapWithConcurrency } from "./concurrency";
import {
  RoutingProviderError,
  routingUserMessage,
  toRoutingError,
} from "./errors";
import { requestValhallaMatrix } from "./valhalla/matrix";
import { requestValhallaRoute } from "./valhalla/route";

/**
 * The routing service — the boundary the rest of the server talks to.
 *
 * Two responsibilities the adapter below it deliberately does not have:
 *
 *  1. **Never throwing for a routing outcome.** `routeSegment` returns a
 *     `RouteResult` union. A caller planning a five-day trip must not have one
 *     unroutable leg take down the other fourteen, so failure is a value here,
 *     not an exception. Programmer errors still throw.
 *  2. **Caching and pacing.** A successful route is held for 24 h; a genuine
 *     `no_route` for 15 minutes; every other failure is not cached at all,
 *     because a failure is not data.
 */

export type RouteOptions = { signal?: AbortSignal };

/** What the cache stores. Only ever a routed result or a genuine no-route. */
type CacheableResult =
  | Extract<RouteResult, { status: "routed" }>
  | (UnavailableRouteSegment & { reason: "no_route" });

export async function routeSegment(
  request: RouteRequest,
  options: RouteOptions = {},
): Promise<RouteResult> {
  // Rejected before a request exists. This is the transit gate: an unsupported
  // mode is refused outright rather than quietly served by another profile.
  if (!isRoutingMode(request.mode)) {
    return unavailable(request, "unsupported_mode");
  }

  const key = routeCacheKey(request);
  const cached = routingCache.get<CacheableResult>(key);
  if (cached) return cached;

  const fetchedAt = new Date().toISOString();

  try {
    const routed = await requestValhallaRoute(request, fetchedAt, options.signal);
    routingCache.set(key, routed, ROUTING_CACHE_TTL_MS.route);
    return routed;
  } catch (raw) {
    const error = toRoutingError(raw);

    const result = unavailable(request, error.kind);

    // "There is no path" is an answer; everything else is a failure, and caching
    // a failure as though it were an answer would pin an outage into the app.
    if (result.reason === "no_route") {
      routingCache.set(key, result, ROUTING_CACHE_TTL_MS.noRoute);
    }

    return result;
  }
}

/**
 * Routes many legs with bounded concurrency, in order, with duplicates collapsed.
 *
 * Partial failure is the normal case and is preserved: the returned array has
 * one entry per input, each independently `routed` or `unavailable`. Nothing is
 * dropped, and a single bad leg never discards a good one.
 *
 * Cache lookups happen inside `routeSegment`, so a batch that is entirely cached
 * costs no requests and no waiting on the limiter.
 */
export async function routeSegments(
  requests: RouteRequest[],
  options: RouteOptions = {},
): Promise<RouteResult[]> {
  if (requests.length === 0) return [];

  return mapWithConcurrency(
    requests,
    (request) => routeSegment(request, options),
    {
      limit: ROUTING_LIMITS.maxConcurrentRequests,
      // Identical origin/destination/mode is issued once and shared.
      keyOf: (request) => routeCacheKey(request),
      signal: options.signal,
    },
  );
}

/**
 * A time-distance matrix.
 *
 * Throws rather than returning a union, unlike `routeSegment`. A matrix is a
 * single indivisible answer — there is no partial matrix, and a caller cannot
 * usefully continue with "some of the cells". The API route converts the throw
 * into a user-safe response.
 */
export async function routeMatrix(
  request: MatrixRequest,
  options: RouteOptions = {},
): Promise<RoutingMatrix> {
  if (!isRoutingMode(request.mode)) {
    throw new RoutingProviderError(
      "unsupported_mode",
      `Mode "${request.mode}" cannot be routed`,
    );
  }

  const key = matrixCacheKey(request);
  const cached = routingCache.get<RoutingMatrix>(key);
  if (cached) return cached;

  const fetchedAt = new Date().toISOString();
  const matrix = await requestValhallaMatrix(request, fetchedAt, options.signal);

  routingCache.set(key, matrix, ROUTING_CACHE_TTL_MS.matrix);
  return matrix;
}

/**
 * True when a repeat of this exact request would be served without a call out.
 *
 * Must be read *before* the request, not after: afterwards the entry exists
 * either way and the answer is always "hit".
 */
export function isRouteCached(request: RouteRequest): boolean {
  return routingCache.has(routeCacheKey(request));
}

export function isMatrixCached(request: MatrixRequest): boolean {
  return routingCache.has(matrixCacheKey(request));
}

function unavailable(
  request: RouteRequest,
  reason: RouteUnavailableReason,
): UnavailableRouteSegment {
  return {
    status: "unavailable",
    requestedMode: request.mode,
    reason,
    userMessage: routingUserMessage(reason),
    origin: request.origin,
    destination: request.destination,
  };
}
