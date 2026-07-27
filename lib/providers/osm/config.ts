/**
 * The only module naming a provider endpoint.
 *
 * Nothing else in the codebase — no component, no route handler — may contain a
 * Nominatim or Overpass URL. Moving to a self-hosted or commercial instance is an
 * edit here and nowhere else.
 *
 * No API key, no account, no billing. Both services below are free and public.
 */

/**
 * Both are overridable so a self-hosted instance — or a local fixture server
 * during repeated browser verification — can stand in without editing code. The
 * same seam `ROAMLY_VALHALLA_BASE_URL` already provides for routing, and for the
 * same reason: hammering a volunteer service on every verification run is the
 * abuse the rate limiter exists to prevent.
 */
export const NOMINATIM_BASE_URL =
  process.env.ROAMLY_NOMINATIM_BASE_URL ?? "https://nominatim.openstreetmap.org";
export const OVERPASS_BASE_URL =
  process.env.ROAMLY_OVERPASS_BASE_URL ??
  "https://overpass-api.de/api/interpreter";

/**
 * How we identify ourselves.
 *
 * Nominatim's usage policy requires a genuine identifying User-Agent with a way
 * to make contact; requests without one get blocked. The contact URL is
 * configurable so a fork does not impersonate this project, and the default is a
 * neutral placeholder rather than anyone's personal details.
 *
 * `ROAMLY_CONTACT_URL` is optional — the app runs keyless and configuration-free.
 * Set it before pointing any real traffic at the public services.
 */
export const CONTACT_URL =
  process.env.ROAMLY_CONTACT_URL ?? "https://github.com/roamly-demo";

export const USER_AGENT = `RoamlyWeekendProject/0.1 (portfolio travel planner; ${CONTACT_URL})`;

/** Attribution carried on every normalised record. Must reach the user. */
export const OSM_ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL) — data via Nominatim and Overpass";

/**
 * Nominatim asks for an absolute maximum of one request per second. This is the
 * floor the limiter enforces process-wide, with headroom rather than exactly 1000.
 */
export const NOMINATIM_MIN_INTERVAL_MS = 1_100;

/**
 * Overpass has no published fixed rate, but it is a shared volunteer service under
 * constant load. We serialise and pace anyway.
 */
export const OVERPASS_MIN_INTERVAL_MS = 1_000;

export const REQUEST_TIMEOUT_MS = {
  nominatim: 10_000,
  /** Overpass is legitimately slow; its own query timeout is set below this. */
  overpass: 30_000,
} as const;

/** Ceiling written into the Overpass query itself, in seconds. */
export const OVERPASS_QUERY_TIMEOUT_S = 25;

export const CACHE_TTL_MS = {
  /** Place names and their coordinates change on the scale of years. */
  geocode: 24 * 60 * 60 * 1_000,
  discover: 6 * 60 * 60 * 1_000,
  /**
   * A successful-but-empty result is cached briefly: it is a real answer worth
   * not re-asking for, but likely to change as the map is edited, and a long TTL
   * would pin a bad radius or category choice in place.
   */
  empty: 10 * 60 * 1_000,
} as const;

/** Bounded so a long-running process cannot grow without limit. */
export const CACHE_MAX_ENTRIES = 500;

/** Hard caps. Enforced in the query builder, not merely suggested. */
export const LIMITS = {
  /** Prevents country-scale Overpass queries. */
  maxRadiusMeters: 30_000,
  minRadiusMeters: 100,
  defaultRadiusMeters: 3_000,
  /** Categories per Overpass request. */
  maxCategoriesPerRequest: 8,
  maxResultsPerCategory: 40,
  /** Total normalised places returned from one discovery call. */
  maxTotalResults: 200,
  /** Nominatim candidates returned to the caller. */
  maxGeocodeResults: 5,
  /** Longest destination string we will send to Nominatim. */
  maxDestinationLength: 120,
  /** Request body ceiling for the internal API routes, in bytes. */
  maxRequestBodyBytes: 4_096,
} as const;

/** One retry only, for transient failures. See `http.ts`. */
export const RETRY = {
  maxAttempts: 2,
  baseDelayMs: 600,
  maxJitterMs: 300,
  /** Ignore an absurd Retry-After rather than hanging a request on it. */
  maxRetryAfterMs: 5_000,
} as const;
