import "server-only";

/**
 * The routing provider adapter's public surface.
 *
 * Everything crossing this boundary is normalised routing-domain data. Raw
 * Valhalla shapes, the HTTP client, the limiter, the polyline decoder and the
 * cache are internal — a caller cannot reach them through this module, which is
 * what keeps the provider swappable.
 *
 * `server-only` here and on each entry point means importing any of this from a
 * client component is a **build error**, not a runtime surprise. Browser code
 * reaches routing exclusively through `POST /api/routes/*`.
 */

export {
  routeSegment,
  routeSegments,
  routeMatrix,
  isRouteCached,
  isMatrixCached,
} from "./service";
export type { RouteOptions } from "./service";

export { routeItineraryDay, routeDayPlaces } from "./day";
export type { RouteItineraryDayInput } from "./day";

export {
  TRIP_ROUTING_LIMITS,
  assertWithinTripCaps,
  routeTripPlan,
} from "./trip";
export type { RouteTripPlanInput, TripRoutingResult } from "./trip";

export {
  RoutingProviderError,
  isRoutingProviderError,
  routingUserMessage,
} from "./errors";
export type { RoutingErrorKind } from "./errors";

export { ROUTING_ATTRIBUTION, ROUTING_LIMITS } from "./config";

export { routingCacheStats } from "./cache";
export { routingLimiterState } from "./client";
