import "server-only";

import type { RouteRequest, RoutedSegment } from "@/lib/routing";

import { postRoutingJson } from "../client";
import { COSTING_BY_MODE, VALHALLA_ENDPOINTS } from "../config";
import { RoutingProviderError } from "../errors";
import { normalizeRouteResponse, toProviderLocation } from "./normalize";

/**
 * One route request against Valhalla's `/route` endpoint.
 *
 * Asks for exactly what this phase needs and nothing more:
 *
 *  - two locations, both `break` type so the shape starts and ends at them
 *  - the mapped costing profile
 *  - kilometres, so the unit conversion has one form
 *  - `directions_type: "none"`, which suppresses the maneuver list
 *
 * That last one is worth spelling out. A Lisbon walk of 880 m returns ~14 KB of
 * turn-by-turn instructions in four languages' worth of phrasing variants, and
 * this phase builds no turn-by-turn UI. Suppressing them cuts the response by
 * roughly 80% — bandwidth we are not entitled to spend on a donated server for
 * data we would immediately discard.
 *
 * Throws `RoutingProviderError`; the service layer converts it to an
 * `unavailable` segment. Nothing here invents a distance, a duration or a line.
 */
export async function requestValhallaRoute(
  request: RouteRequest,
  fetchedAt: string,
  signal?: AbortSignal,
): Promise<RoutedSegment> {
  const costing = COSTING_BY_MODE[request.mode];

  // Total over `RoutingMode`, so this is unreachable through the type system —
  // it guards against a plain-JS caller or a future mode added without a
  // profile, which must fail loudly rather than default to walking.
  if (!costing) {
    throw new RoutingProviderError(
      "unsupported_mode",
      `No costing profile for mode "${request.mode}"`,
    );
  }

  const body = {
    locations: [
      { ...toProviderLocation(request.origin), type: "break" },
      { ...toProviderLocation(request.destination), type: "break" },
    ],
    costing,
    units: request.units ?? "kilometers",
    // No maneuvers: this phase renders geometry, not instructions.
    directions_type: "none",
    directions_options: { language: request.language ?? "en-US" },
    /**
     * `alternates` is accepted but deliberately left at 0 by default. An
     * alternative route is a second full computation on a shared server for a
     * feature no surface in this phase presents.
     */
    ...(request.alternatives ? { alternates: 1 } : {}),
  };

  const raw = await postRoutingJson({
    path: VALHALLA_ENDPOINTS.route,
    body,
    signal,
  });

  return normalizeRouteResponse(raw, request, fetchedAt);
}
