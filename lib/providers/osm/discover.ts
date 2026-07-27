import "server-only";

import type { PlaceCategory, TripPlace } from "@/lib/schemas/place";

import { cacheKey, overpassCache } from "./cache";
import {
  CACHE_TTL_MS,
  LIMITS,
  OSM_ATTRIBUTION,
  OVERPASS_BASE_URL,
  OVERPASS_MIN_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
} from "./config";
import { ProviderError } from "./errors";
import { fetchProviderJson } from "./http";
import {
  capPerCategory,
  dedupeAndOrder,
  normalizeOverpassElement,
} from "./normalize";
import { buildOverpassQuery } from "./overpass-query";
import { createRateLimiter } from "./rate-limit";
import { OverpassResponseSchema } from "./schemas";

/**
 * Category-based place discovery via Overpass.
 *
 * Returns normalised `TripPlace` records and metadata only. The raw Overpass
 * payload never leaves this module — that is what makes the provider swappable and
 * stops response quirks leaking into the domain.
 */

const limiter = createRateLimiter(OVERPASS_MIN_INTERVAL_MS);

export type DiscoverInput = {
  center: { latitude: number; longitude: number };
  categories: PlaceCategory[];
  radiusMeters?: number;
  limitPerCategory?: number;
  signal?: AbortSignal;
};

export type PlaceDiscoveryResult = {
  places: TripPlace[];
  /** The clamped, deduplicated categories actually queried. */
  categoriesRequested: PlaceCategory[];
  query: {
    center: { latitude: number; longitude: number };
    radiusMeters: number;
    limitPerCategory: number;
    /** Categories that came back with nothing. Useful, not an error. */
    categoriesWithNoResults: PlaceCategory[];
  };
  /** Counts of what normalisation discarded, and why. */
  discarded: {
    total: number;
    noCategory: number;
    noName: number;
    noCoordinates: number;
    invalid: number;
  };
  fetchedAt: string;
  attribution: string;
  fromCache: boolean;
};

export async function discoverPlaces(
  input: DiscoverInput,
): Promise<PlaceDiscoveryResult> {
  // Validation, clamping and allowlist enforcement all happen here. Anything not
  // in the category allowlist throws before a query string exists.
  const built = buildOverpassQuery({
    center: input.center,
    categories: input.categories,
    radiusMeters: input.radiusMeters ?? LIMITS.defaultRadiusMeters,
    limitPerCategory: input.limitPerCategory ?? LIMITS.maxResultsPerCategory,
  });

  const key = cacheKey("overpass", {
    op: "discover",
    lat: built.center.latitude,
    lon: built.center.longitude,
    radius: built.radiusMeters,
    limit: built.limitPerCategory,
    categories: built.categories,
  });

  const cached = overpassCache.get<PlaceDiscoveryResult>(key);
  if (cached) return { ...cached, fromCache: true };

  const raw = await fetchProviderJson({
    provider: "overpass",
    url: OVERPASS_BASE_URL,
    limiter,
    timeoutMs: REQUEST_TIMEOUT_MS.overpass,
    signal: input.signal,
    // POST, not GET: the query easily exceeds sane URL lengths.
    body: new URLSearchParams({ data: built.query }),
  });

  const parsed = OverpassResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProviderError(
      "invalid_response",
      "overpass",
      `Unexpected Overpass response shape: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }

  const fetchedAt = new Date().toISOString();

  const discarded = {
    total: 0,
    noCategory: 0,
    noName: 0,
    noCoordinates: 0,
    invalid: 0,
  };

  const normalised: TripPlace[] = [];
  for (const element of parsed.data.elements) {
    const place = normalizeOverpassElement(element, fetchedAt);
    if (place) {
      normalised.push(place);
      continue;
    }
    // Attribute the drop, so the dev surface can show *why* a busy area returned
    // fewer places than expected rather than leaving it a mystery.
    discarded.total += 1;
    if (!element.tags) discarded.noCategory += 1;
    else if (!element.tags.name?.trim()) discarded.noName += 1;
    else if (
      element.lat === undefined &&
      element.lon === undefined &&
      !element.center
    ) {
      discarded.noCoordinates += 1;
    } else discarded.invalid += 1;
  }

  const ordered = dedupeAndOrder(normalised);
  const capped = capPerCategory(ordered, built.limitPerCategory).slice(
    0,
    LIMITS.maxTotalResults,
  );

  const found = new Set(capped.map((place) => place.category));
  const categoriesWithNoResults = built.categories.filter(
    (category) => !found.has(category),
  );

  const result: PlaceDiscoveryResult = {
    places: capped,
    categoriesRequested: built.categories,
    query: {
      center: built.center,
      radiusMeters: built.radiusMeters,
      limitPerCategory: built.limitPerCategory,
      categoriesWithNoResults,
    },
    discarded,
    fetchedAt,
    attribution: OSM_ATTRIBUTION,
    fromCache: false,
  };

  overpassCache.set(
    key,
    result,
    capped.length === 0 ? CACHE_TTL_MS.empty : CACHE_TTL_MS.discover,
  );

  return result;
}

/** Diagnostics for the dev surface. Not for normal UI. */
export function overpassLimiterState() {
  return limiter.state();
}
