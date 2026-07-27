import "server-only";

/**
 * The OpenStreetMap provider adapter's public surface.
 *
 * Everything crossing this boundary is normalised domain data. Raw Nominatim and
 * Overpass shapes, the HTTP client, the limiter and the caches are internal — a
 * caller cannot reach them through this module, which is what keeps the provider
 * swappable.
 *
 * `server-only` here and on each entry point means importing any of this from a
 * client component is a **build error**, not a runtime surprise.
 */

export { geocodeDestination, nominatimLimiterState } from "./geocode";
export type { GeocodeInput, GeocodeResult } from "./geocode";

export { discoverPlaces, overpassLimiterState } from "./discover";
export type { DiscoverInput, PlaceDiscoveryResult } from "./discover";

export type { GeocodedDestination } from "./normalize";

export { ProviderError, isProviderError } from "./errors";
export type { ProviderErrorKind } from "./errors";

export {
  ALL_PLACE_CATEGORIES,
  isAllowedCategory,
} from "./categories";

export {
  isCanonicalId,
  parseCanonicalId,
  toCanonicalId,
} from "./identity";

export { OSM_ATTRIBUTION } from "./config";

export { providerCacheStats } from "./cache";
