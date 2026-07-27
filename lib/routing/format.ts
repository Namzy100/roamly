import { formatDistance, formatDuration } from "@/lib/format";

import { ROUTING_MODE_NOUNS } from "./modes";
import type { RouteResult, RoutingMode } from "./types";

/**
 * User-facing wording for routing results.
 *
 * Centralised so the honesty rules are enforced once rather than remembered at
 * every call site. What we may say, and what we must not:
 *
 * | Say | Never say |
 * | --- | --- |
 * | "12 min walk" | "12 min — live traffic" |
 * | "3.2 km drive" | "fastest right now" |
 * | "Route unavailable" | anything implying a route exists |
 * | "Estimated travel time" (estimates only) | "real-time conditions" |
 * | "Routed using OpenStreetMap road data" | "transit route" |
 *
 * Valhalla routes are computed from OpenStreetMap geometry and a costing
 * profile. This deployment has no traffic feed and no transit feed, so any
 * phrasing implying either would be false.
 */

/** The sentence a routed segment is allowed to be summarised as. */
export const ROUTED_BASIS_LABEL = "Routed using OpenStreetMap road data";

/** The label estimates must carry, so they are never mistaken for routed data. */
export const ESTIMATE_LABEL = "Estimated travel time";

/** Seconds → whole minutes, rounded up, floored at 1. */
export function durationSecondsToMinutes(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}

/** "12 min walk", "1 hr 5 min drive". */
export function formatRoutedDuration(
  durationSeconds: number,
  mode: RoutingMode,
): string {
  return `${formatDuration(durationSecondsToMinutes(durationSeconds))} ${
    ROUTING_MODE_NOUNS[mode]
  }`;
}

/** "3.2 km drive", "450 m walk". */
export function formatRoutedDistance(
  distanceMeters: number,
  mode: RoutingMode,
): string {
  return `${formatDistance(distanceMeters)} ${ROUTING_MODE_NOUNS[mode]}`;
}

/**
 * One line describing a result, whatever its state.
 *
 * The unavailable arm returns "Route unavailable" and nothing numeric — there is
 * no distance to hint at and no duration to soften it with.
 */
export function formatRouteResult(result: RouteResult): string {
  if (result.status === "unavailable") return "Route unavailable";
  return `${formatDuration(
    durationSecondsToMinutes(result.durationSeconds),
  )} ${ROUTING_MODE_NOUNS[result.mode]} · ${formatDistance(result.distanceMeters)}`;
}
