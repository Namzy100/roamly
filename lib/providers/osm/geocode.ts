import "server-only";

import { cacheKey, nominatimCache } from "./cache";
import {
  CACHE_TTL_MS,
  LIMITS,
  NOMINATIM_BASE_URL,
  NOMINATIM_MIN_INTERVAL_MS,
  OSM_ATTRIBUTION,
  REQUEST_TIMEOUT_MS,
} from "./config";
import { ProviderError } from "./errors";
import { fetchProviderJson } from "./http";
import { normalizeGeocodeResult, type GeocodedDestination } from "./normalize";
import { createRateLimiter } from "./rate-limit";
import { NominatimSearchResponseSchema } from "./schemas";

/**
 * Destination geocoding via Nominatim.
 *
 * ## Policy compliance
 *
 * One shared limiter for the whole process, so **all** Nominatim traffic is
 * serialised at ≥1 request/second regardless of how many callers there are. There
 * are deliberately no parallel Nominatim requests anywhere in the codebase: the
 * limiter would serialise them anyway, and issuing them concurrently would only
 * hide that fact from whoever reads the code next.
 *
 * Caching, an identifying User-Agent, `Accept: application/json` and a single retry
 * ceiling are handled in `http.ts`. There is no search-as-you-type anywhere — the
 * dev surface requires an explicit submit — because that pattern is precisely what
 * the usage policy prohibits.
 */

/** Shared, module-scoped: one limiter per process, not per call. */
const limiter = createRateLimiter(NOMINATIM_MIN_INTERVAL_MS);

export type GeocodeInput = {
  destination: string;
  /** ISO 3166-1 alpha-2, to disambiguate places sharing a name. */
  countryCode?: string;
  signal?: AbortSignal;
};

export type GeocodeResult = {
  query: string;
  candidates: GeocodedDestination[];
  attribution: string;
  fetchedAt: string;
  fromCache: boolean;
};

export async function geocodeDestination(
  input: GeocodeInput,
): Promise<GeocodeResult> {
  const destination = input.destination.trim();

  if (destination.length === 0) {
    throw new ProviderError(
      "malformed_query",
      "nominatim",
      "Destination must not be empty",
    );
  }
  if (destination.length > LIMITS.maxDestinationLength) {
    throw new ProviderError(
      "malformed_query",
      "nominatim",
      `Destination must be ${LIMITS.maxDestinationLength} characters or fewer`,
    );
  }

  const countryCode = normalizeCountryCode(input.countryCode);

  const key = cacheKey("nominatim", {
    op: "search",
    q: destination.toLowerCase(),
    country: countryCode ?? "",
    limit: LIMITS.maxGeocodeResults,
  });

  const cached = nominatimCache.get<GeocodeResult>(key);
  if (cached) return { ...cached, fromCache: true };

  const url = new URL("/search", NOMINATIM_BASE_URL);
  url.searchParams.set("q", destination);
  // jsonv2 gives the `name`/`addresstype` split that plain json lacks.
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", String(LIMITS.maxGeocodeResults));
  url.searchParams.set("addressdetails", "1");
  if (countryCode) url.searchParams.set("countrycodes", countryCode);

  const raw = await fetchProviderJson({
    provider: "nominatim",
    url: url.toString(),
    limiter,
    timeoutMs: REQUEST_TIMEOUT_MS.nominatim,
    signal: input.signal,
  });

  const parsed = NominatimSearchResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(
      "invalid_response",
      "nominatim",
      `Unexpected Nominatim response shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }

  const fetchedAt = new Date().toISOString();

  // Deduplicate by canonical identity: Nominatim can return the same OSM element
  // more than once for a query that matches several of its names.
  const seen = new Set<string>();
  const candidates: GeocodedDestination[] = [];
  for (const record of parsed.data) {
    const normalised = normalizeGeocodeResult(record, fetchedAt);
    if (!normalised) continue;
    if (seen.has(normalised.canonicalId)) continue;
    seen.add(normalised.canonicalId);
    candidates.push(normalised);
    if (candidates.length >= LIMITS.maxGeocodeResults) break;
  }

  const result: GeocodeResult = {
    query: destination,
    candidates,
    attribution: OSM_ATTRIBUTION,
    fetchedAt,
    fromCache: false,
  };

  // An empty answer is still an answer — cached, but briefly, since it is the most
  // likely thing to change and the least useful to pin.
  nominatimCache.set(
    key,
    result,
    candidates.length === 0 ? CACHE_TTL_MS.empty : CACHE_TTL_MS.geocode,
  );

  return result;
}

/**
 * Deliberately **not** exported as "pick the best match".
 *
 * Choosing between "Lisbon, Portugal" and "Lisbon, Ohio" is a product decision that
 * belongs to the caller with the user in front of them. Silently taking the first
 * result at the domain layer is how a trip ends up in the wrong country.
 */
function normalizeCountryCode(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (!/^[a-z]{2}$/.test(trimmed)) {
    throw new ProviderError(
      "malformed_query",
      "nominatim",
      "Country code must be two letters (ISO 3166-1 alpha-2)",
    );
  }
  return trimmed;
}

/** Diagnostics for the dev surface. Not for normal UI. */
export function nominatimLimiterState() {
  return limiter.state();
}
