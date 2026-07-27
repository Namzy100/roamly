import "server-only";

import type { MatrixRequest, RoutingMatrix } from "@/lib/routing";

import { postRoutingJson } from "../client";
import {
  COSTING_BY_MODE,
  ROUTING_LIMITS,
  VALHALLA_ENDPOINTS,
} from "../config";
import { RoutingProviderError } from "../errors";
import { normalizeMatrixResponse, toProviderLocation } from "./normalize";

/**
 * One time-distance matrix against Valhalla's `/sources_to_targets`.
 *
 * ## What a matrix is for here, and what it is not
 *
 * It answers "roughly how far apart is everything" in one request instead of
 * N×M. That is useful for feasibility checks and, later, for ranking candidate
 * stops. It is **not** a source of rendered geometry: the endpoint returns costs
 * only, and the `/route` endpoint remains authoritative for anything drawn on a
 * map. No product surface in this phase consumes a matrix; the adapter exists so
 * the next phase does not have to add a provider integration under deadline.
 *
 * ## The element cap is ours, not theirs
 *
 * 64 elements (8×8). Valhalla's own limits are higher, but they are limits on
 * *their* hardware that we have not verified for this instance, and a matrix is
 * the cheapest way to accidentally ask a donated server for a thousand route
 * computations at once. The cap is enforced here, before a request exists.
 */
export async function requestValhallaMatrix(
  request: MatrixRequest,
  fetchedAt: string,
  signal?: AbortSignal,
): Promise<RoutingMatrix> {
  assertWithinCaps(request);

  const costing = COSTING_BY_MODE[request.mode];
  if (!costing) {
    throw new RoutingProviderError(
      "unsupported_mode",
      `No costing profile for mode "${request.mode}"`,
    );
  }

  const body = {
    sources: request.sources.map(toProviderLocation),
    targets: request.targets.map(toProviderLocation),
    costing,
    units: "kilometers",
  };

  const raw = await postRoutingJson({
    path: VALHALLA_ENDPOINTS.matrix,
    body,
    signal,
  });

  return normalizeMatrixResponse(raw, request, fetchedAt);
}

/**
 * Rejects an oversized matrix before it becomes a request.
 *
 * Throws `invalid_locations` rather than clamping. Silently trimming targets
 * would return a matrix whose indices no longer line up with what the caller
 * asked for, which is worse than a clear refusal.
 */
export function assertWithinCaps(request: MatrixRequest): void {
  if (request.sources.length === 0 || request.targets.length === 0) {
    throw new RoutingProviderError(
      "invalid_locations",
      "A matrix needs at least one source and one target",
    );
  }
  if (request.sources.length > ROUTING_LIMITS.maxMatrixSources) {
    throw new RoutingProviderError(
      "invalid_locations",
      `At most ${ROUTING_LIMITS.maxMatrixSources} sources per matrix`,
    );
  }
  if (request.targets.length > ROUTING_LIMITS.maxMatrixTargets) {
    throw new RoutingProviderError(
      "invalid_locations",
      `At most ${ROUTING_LIMITS.maxMatrixTargets} targets per matrix`,
    );
  }

  const elements = request.sources.length * request.targets.length;
  if (elements > ROUTING_LIMITS.maxMatrixElements) {
    throw new RoutingProviderError(
      "invalid_locations",
      `A matrix may contain at most ${ROUTING_LIMITS.maxMatrixElements} elements, requested ${elements}`,
    );
  }
}
