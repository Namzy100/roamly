/**
 * The only module naming a routing endpoint.
 *
 * Nothing else in the codebase — no component, no route handler, no test — may
 * contain a Valhalla URL. Moving to a self-hosted or commercial instance is an
 * edit here and nowhere else.
 *
 * No API key, no account, no billing. The service below is free and public.
 *
 * ## What this server is
 *
 * `valhalla1.openstreetmap.de` is FOSSGIS's public **demo** instance of Valhalla.
 * It is demo infrastructure: unversioned, unguaranteed, and liable to be slow,
 * rate-limited or simply gone. Treating it as anything else would be building on
 * someone else's goodwill and calling it an SLA. Everything downstream is built
 * to degrade to an explicit "route unavailable" rather than to a wrong answer.
 *
 * ## Before this carries real traffic
 *
 * Notify the operator or move off the shared instance. In increasing order of
 * effort: self-host Valhalla (open source, a country extract runs comfortably on
 * a small VM), use a commercial Valhalla-compatible host, or swap the adapter
 * for another routing engine — the domain layer would not change.
 */

export const VALHALLA_BASE_URL =
  process.env.ROAMLY_VALHALLA_BASE_URL ?? "https://valhalla1.openstreetmap.de";

export const VALHALLA_ENDPOINTS = {
  route: "/route",
  matrix: "/sources_to_targets",
} as const;

/**
 * How we identify ourselves on a shared demo service.
 *
 * A stable client id lets the operator see who is generating traffic and get in
 * touch — or block us specifically rather than a whole IP range — which is the
 * whole point of sending it. Configurable so a fork does not impersonate this
 * project, and containing nothing personal.
 */
export const ROUTING_CLIENT_ID =
  process.env.ROAMLY_ROUTING_CLIENT_ID ?? "roamly-weekend-project";

export const ROUTING_CONTACT_URL =
  process.env.ROAMLY_CONTACT_URL ?? "https://github.com/roamly-demo";

export const ROUTING_USER_AGENT = `RoamlyWeekendProject/0.1 (portfolio travel planner; ${ROUTING_CONTACT_URL})`;

/**
 * Attribution carried on every routed segment. Must reach the user.
 *
 * Says "road data", not "traffic" or "conditions": Valhalla computes over
 * OpenStreetMap geometry with a costing profile, and this deployment has no
 * traffic feed. Anything stronger would be a claim we cannot support.
 */
export const ROUTING_ATTRIBUTION =
  "© OpenStreetMap contributors (ODbL) — routing by Valhalla (FOSSGIS demo server)";

/**
 * Valhalla's costing profiles, mapped from our modes.
 *
 * The map is total over `RoutingMode` and contains no transit entry, so there is
 * no expressible way to send a transit request and receive a walking route back
 * under a transit label.
 */
export const COSTING_BY_MODE = {
  walk: "pedestrian",
  drive: "auto",
  bicycle: "bicycle",
} as const;

/**
 * Restraint on a shared demo service.
 *
 * Three concurrent requests with a gap between starts, rather than a bare
 * concurrency cap: the cap alone would let a five-day itinerary fire fifteen
 * requests in three tight bursts. The interval spreads them. Both are
 * configurable so a self-hosted instance can be told it is allowed to go faster.
 */
export const ROUTING_LIMITS = {
  maxConcurrentRequests: 3,
  /** Minimum gap between request *starts*, process-wide. */
  minIntervalMs: 250,
  requestTimeoutMs: 15_000,

  /** Waypoints per `/api/routes/day` request. A five-day trip routes day by day. */
  maxWaypointsPerDay: 24,

  /**
   * Matrix element ceiling, ours and deliberately conservative.
   *
   * Valhalla's own limit for the auto profile is higher, but it is *their*
   * limit on *their* hardware and it is not something we have verified for this
   * instance. 64 elements (8×8) is more than this product needs and far below
   * anything that would be noticed.
   */
  maxMatrixElements: 64,
  maxMatrixSources: 8,
  maxMatrixTargets: 8,

  /** Request body ceiling for the internal routing API routes, in bytes. */
  maxRequestBodyBytes: 8_192,
} as const;

export const ROUTING_CACHE_TTL_MS = {
  /** A road does not move. */
  route: 24 * 60 * 60 * 1_000,
  matrix: 24 * 60 * 60 * 1_000,
  /**
   * "There is no route" is a real answer worth not re-asking for, but it is the
   * one most likely to be wrong — an unmapped path, a ferry not yet tagged, a
   * mis-snapped endpoint — so it is held briefly rather than pinned for a day.
   */
  noRoute: 15 * 60 * 1_000,
} as const;

export const ROUTING_CACHE_MAX_ENTRIES = 500;

/** One retry only, for transient failures. See `client.ts`. */
export const ROUTING_RETRY = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxJitterMs: 300,
  /** Ignore an absurd Retry-After rather than hanging a request on it. */
  maxRetryAfterMs: 5_000,
} as const;
