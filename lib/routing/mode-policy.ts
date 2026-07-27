import type { ModePolicy, RouteLocation, RoutingMode } from "./types";

/**
 * Choosing *which* mode to ask for. This sits **above** the provider, on purpose.
 *
 * The routing layer never picks a mode. Given `walk` it returns a walking route
 * or an `unavailable`; it will not decide that 40 km is too far and hand back a
 * drive. Substitution is a product decision with consequences for a traveller's
 * day, and it belongs where it can be seen and configured — here.
 *
 * ## The thresholds are defaults, not truths
 *
 * 1.8 km is a pleasant twenty-minute walk in Lisbon in October and a bad idea in
 * Dubai in August, and neither of those is a property of the number. They are
 * exposed as a `ModePolicy` so a caller — eventually the traveller's own pace
 * and weather context — can move them, and they are documented as planning
 * defaults everywhere they surface.
 */

export const DEFAULT_MODE_POLICY: ModePolicy = {
  /** Up to this, walk. */
  walkMaxMeters: 1_800,
  /** Above this, drive when road travel is appropriate. */
  driveMinMeters: 8_000,
  /**
   * The 1.8–8 km band is left to the caller by default. It is the band where
   * "walk it" and "get a car" are both defensible, and guessing on the
   * traveller's behalf is how a plan acquires a 90-minute walk nobody wanted.
   */
  allowDriveInMiddleBand: false,
};

/**
 * The chosen mode, plus why.
 *
 * `null` means the policy declines to choose — the middle band with driving not
 * allowed. A caller must then supply a mode explicitly or skip the leg; it must
 * not fall back to a default, which would be the silent substitution this module
 * exists to prevent.
 */
export type ModeSelection = {
  mode: RoutingMode | null;
  reason:
    | "forced"
    | "within_walk_threshold"
    | "above_drive_threshold"
    | "middle_band_drive"
    | "middle_band_undecided";
  straightLineMeters: number;
};

/**
 * Picks a mode from straight-line distance.
 *
 * Straight-line, not routed, distance — deliberately. Choosing the mode is what
 * decides which route to *request*, so it cannot depend on having already
 * requested one. The great-circle distance is always an underestimate of the
 * real path, which biases the choice towards walking; the thresholds are set
 * with that in mind.
 *
 * Bicycle is never returned unless it was forced. Cycling depends on
 * infrastructure, hills, luggage and whether the traveller owns a bike, none of
 * which we know, so it is an explicit request only.
 */
export function selectMode(
  straightLineMeters: number,
  policy: ModePolicy = DEFAULT_MODE_POLICY,
): ModeSelection {
  if (policy.forcedMode) {
    return {
      mode: policy.forcedMode,
      reason: "forced",
      straightLineMeters,
    };
  }

  // Inclusive: exactly 1.8 km is inside the walking band, so the boundary has a
  // defined answer rather than falling through to the middle.
  if (straightLineMeters <= policy.walkMaxMeters) {
    return {
      mode: "walk",
      reason: "within_walk_threshold",
      straightLineMeters,
    };
  }

  if (straightLineMeters > policy.driveMinMeters) {
    return {
      mode: "drive",
      reason: "above_drive_threshold",
      straightLineMeters,
    };
  }

  if (policy.allowDriveInMiddleBand) {
    return {
      mode: "drive",
      reason: "middle_band_drive",
      straightLineMeters,
    };
  }

  return {
    mode: null,
    reason: "middle_band_undecided",
    straightLineMeters,
  };
}

const EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Great-circle distance between two points, in metres.
 *
 * Used only for mode selection and diagnostics. It is **never** presented to a
 * traveller as a travel distance and never written to a routed segment — the
 * distance you walk is the routed one, and the difference between them is the
 * whole reason this phase exists.
 */
export function haversineMeters(
  from: Pick<RouteLocation, "latitude" | "longitude">,
  to: Pick<RouteLocation, "latitude" | "longitude">,
): number {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}
