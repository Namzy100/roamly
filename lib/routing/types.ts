/**
 * The provider-independent routing vocabulary.
 *
 * Nothing in this file names Valhalla except the `provider` literal on a result,
 * and no Valhalla shape appears anywhere in `lib/routing/`. The adapter under
 * `lib/providers/routing/valhalla/` translates into these types and nothing
 * escapes it — which is what makes the provider replaceable and keeps raw
 * responses out of the map, the store and the plan.
 *
 * ## What a route from this layer is, and is not
 *
 * It is a path computed over OpenStreetMap road, path and cycleway data using a
 * costing profile. It is **not** live traffic, not "fastest right now", not a
 * real-time condition, and not a guarantee of accessibility. Nothing downstream
 * may describe it as any of those.
 */

/**
 * The modes we support end to end.
 *
 * Transit is deliberately absent. The public Valhalla demo has no transit feed
 * loaded, and returning a walking or driving route under a transit label would
 * be a lie about what the traveller is being told to do. A transit request is
 * rejected as `unsupported_mode` rather than quietly substituted.
 */
export type RoutingMode = "walk" | "drive" | "bicycle";

export type RouteLocation = {
  latitude: number;
  longitude: number;
  /** Carried through for correlation only; never sent to the provider. */
  canonicalPlaceId?: string;
};

export type RouteRequest = {
  origin: RouteLocation;
  destination: RouteLocation;
  mode: RoutingMode;
  alternatives?: boolean;
  language?: string;
  units?: "kilometers";
};

/**
 * A decoded route shape, in GeoJSON's `[longitude, latitude]` order.
 *
 * The ordering is stated here because it is the single most common way to get
 * this wrong: nearly every routing provider emits `lat,lon` and every map
 * renderer wants `lon,lat`. The decoder swaps once, at the boundary, and tests
 * assert the result lands in the right hemisphere.
 */
export type RoutedGeometry = {
  type: "LineString";
  coordinates: [longitude: number, latitude: number][];
};

export type RoutedSegment = {
  status: "routed";
  provider: "valhalla";
  mode: RoutingMode;
  origin: RouteLocation;
  destination: RouteLocation;
  /** Finite and strictly positive. Zero is not a route. */
  distanceMeters: number;
  /** Finite and strictly positive. Zero is not a route. */
  durationSeconds: number;
  geometry: RoutedGeometry;
  fetchedAt: string;
  attribution: string;
};

/**
 * Why a route could not be produced.
 *
 * `no_route` is a genuine, cacheable answer — the provider looked and there is
 * no path. Everything else is a failure of ours or of the service, and is never
 * cached as though it were data.
 */
export type RouteUnavailableReason =
  | "no_route"
  | "provider_unavailable"
  | "timeout"
  | "rate_limited"
  | "invalid_locations"
  | "unsupported_mode"
  | "invalid_response"
  | "aborted"
  | "unknown";

export type UnavailableRouteSegment = {
  status: "unavailable";
  requestedMode: RoutingMode;
  reason: RouteUnavailableReason;
  userMessage: string;
  /** Present when the request that failed had identifiable endpoints. */
  origin?: RouteLocation;
  destination?: RouteLocation;
};

/**
 * The only thing the routing service ever returns for a single leg.
 *
 * A discriminated union rather than `RoutedSegment | null`, because "we do not
 * know" carries a reason the traveller is owed and a caller must handle.
 */
export type RouteResult = RoutedSegment | UnavailableRouteSegment;

export type RoutingMatrix = {
  mode: RoutingMode;
  sources: RouteLocation[];
  targets: RouteLocation[];
  /** `null` means unreachable. Never coerced to zero — zero is a real duration. */
  durationsSeconds: Array<Array<number | null>>;
  distancesMeters: Array<Array<number | null>>;
  fetchedAt: string;
  provider: "valhalla";
};

export type MatrixRequest = {
  sources: RouteLocation[];
  targets: RouteLocation[];
  mode: RoutingMode;
};

/**
 * How a caller wants modes chosen for a day.
 *
 * Thresholds are planning defaults, not facts about the world: 1.8 km is a
 * pleasant walk in Lisbon in October and a bad idea in Dubai in August. They are
 * configurable for exactly that reason. See `lib/routing/mode-policy.ts`.
 */
export type ModePolicy = {
  /** Straight-line distance at or below which walking is chosen. */
  walkMaxMeters: number;
  /** Straight-line distance above which driving is chosen, when allowed. */
  driveMinMeters: number;
  /** Whether the middle band may resolve to driving. */
  allowDriveInMiddleBand: boolean;
  /**
   * Forces every leg to this mode. Set when the user has explicitly asked —
   * bicycle is never auto-selected.
   */
  forcedMode?: RoutingMode;
};

/** A pair of consecutive, place-backed stops eligible for routing. */
export type DayLeg = {
  /**
   * Stable identity: day, both item ids, and the requested mode. Built by the
   * one constructor in `./leg-id.ts` — never assembled by hand, never derived
   * from array position. See that module for why each component is needed.
   */
  id: string;
  /** Part of the leg's identity, so a Tuesday result cannot land on Wednesday. */
  dayNumber: number;
  fromItemId: string;
  toItemId: string;
  fromPlaceId: string;
  toPlaceId: string;
  origin: RouteLocation;
  destination: RouteLocation;
  mode: RoutingMode;
  /** Great-circle distance, used only for mode selection and diagnostics. */
  straightLineMeters: number;
};

export type RoutedDayLeg = DayLeg & { result: RouteResult };

export type RoutedDayResult = {
  dayNumber: number | null;
  legs: RoutedDayLeg[];
  /** Counts, so a partial failure is visible without walking the array. */
  summary: {
    total: number;
    routed: number;
    unavailable: number;
    /** Sum over routed legs only. Never includes an estimate. */
    routedDistanceMeters: number;
    routedDurationSeconds: number;
  };
  attribution: string;
};
