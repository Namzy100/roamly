import type { TravelSegment } from "@/lib/schemas/trip-plan";

import { durationSecondsToMinutes } from "./format";
import { toTravelMode } from "./modes";
import type { RoutedDayLeg, RouteResult } from "./types";

/**
 * The bridge from a routing result to an itinerary `TravelSegment`.
 *
 * One function, because this is the exact point where a provider fact becomes
 * something a traveller reads, and the two arms must not diverge. Both are
 * derived mechanically from the result's own discriminant — there is no path
 * that produces a `routed` segment from an `unavailable` result, or attaches
 * geometry to something that has none.
 *
 * Note what this does **not** do: it does not attach the segment to a plan. The
 * plan is immutable and versioned, and grafting routed data onto it belongs to
 * the orchestration phase that owns plan construction. Here the segments are
 * returned standalone.
 */
export function toTravelSegment(
  leg: Pick<RoutedDayLeg, "id" | "fromPlaceId" | "toPlaceId">,
  result: RouteResult,
  note: string | null = null,
): TravelSegment {
  if (result.status === "unavailable") {
    return {
      id: leg.id,
      fromPlaceId: leg.fromPlaceId,
      toPlaceId: leg.toPlaceId,
      note,
      status: "unavailable",
      requestedMode: toTravelMode(result.requestedMode),
      reason: result.reason,
      userMessage: result.userMessage,
    };
  }

  return {
    id: leg.id,
    fromPlaceId: leg.fromPlaceId,
    toPlaceId: leg.toPlaceId,
    note,
    status: "routed",
    provider: result.provider,
    // `toTravelMode` is total over `RoutingMode`, and `RoutingMode` excludes
    // transit, so the narrow `RoutedTravelMode` the schema wants is guaranteed.
    mode: toTravelMode(result.mode) as "WALK" | "DRIVE" | "BICYCLE",
    distanceMeters: result.distanceMeters,
    durationSeconds: result.durationSeconds,
    durationMinutes: durationSecondsToMinutes(result.durationSeconds),
    geometry: result.geometry,
    fetchedAt: result.fetchedAt,
    attribution: result.attribution,
  };
}
