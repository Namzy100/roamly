/**
 * The routing domain's public surface — provider-independent and client-safe.
 *
 * Deliberately **without** `server-only`. Nothing here contacts a service, names
 * an endpoint, or describes a provider payload; it is the vocabulary the API
 * contract, the map layer and the dev surface all speak. The parts that do reach
 * the network live in `lib/providers/routing/`, which is server-only and is not
 * re-exported from here.
 */

export type {
  DayLeg,
  MatrixRequest,
  ModePolicy,
  RoutedDayLeg,
  RoutedDayResult,
  RoutedGeometry,
  RoutedSegment,
  RouteLocation,
  RouteRequest,
  RouteResult,
  RouteUnavailableReason,
  RoutingMatrix,
  RoutingMode,
  UnavailableRouteSegment,
} from "./types";

export {
  ROUTING_MODES,
  ROUTING_MODE_LABELS,
  ROUTING_MODE_NOUNS,
  isRoutingMode,
  toRoutingMode,
  toTravelMode,
} from "./modes";

export {
  DEFAULT_MODE_POLICY,
  haversineMeters,
  selectMode,
  type ModeSelection,
} from "./mode-policy";

export {
  COLLAPSE_EPSILON_METERS,
  deriveDayLegs,
  deriveLegsFromPlaces,
  deriveLegsFromStops,
  type DeriveDayLegsInput,
  type RoutingStop,
} from "./derive";

export {
  ACCOMMODATION_ORIGIN_ID,
  ACCOMMODATION_RETURN_ID,
  InvalidLegIdError,
  accommodationLegEndpointId,
  isRoutingLegId,
  parseRoutingLegId,
  routingLegId,
  type RoutingLegIdParts,
} from "./leg-id";

export {
  isUsableMeasurement,
  validateRoutedGeometry,
  type GeometryValidation,
} from "./validate";

export {
  matrixCacheKey,
  routeCacheKey,
  ROUTE_CACHE_COORDINATE_PRECISION,
} from "./cache-key";

export {
  ESTIMATE_LABEL,
  ROUTED_BASIS_LABEL,
  durationSecondsToMinutes,
  formatRouteResult,
  formatRoutedDistance,
  formatRoutedDuration,
} from "./format";

export { toTravelSegment } from "./segment";

export {
  MatrixRequestSchema,
  ModePolicySchema,
  RoutedDayResultSchema,
  RoutedGeometrySchema,
  RoutedSegmentSchema,
  RouteLocationSchema,
  RouteRequestSchema,
  RouteResultSchema,
  RoutingMatrixSchema,
  RoutingModeSchema,
  RouteUnavailableReasonSchema,
  UnavailableRouteSegmentSchema,
} from "./schemas";
