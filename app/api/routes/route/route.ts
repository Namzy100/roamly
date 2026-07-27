import { RouteApiRequestSchema } from "@/lib/api/routing-contract";
import { readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import {
  ROUTING_ATTRIBUTION,
  ROUTING_LIMITS,
  isRouteCached,
  routeSegment,
} from "@/lib/providers/routing";

/**
 * `POST /api/routes/route` — one routed leg between two points.
 *
 * ## Why a well-formed request always gets 200
 *
 * "There is no path between these two points" is a correct answer, not a client
 * error, so it comes back as `result.status === "unavailable"` with a reason
 * inside a 200. Reserving 4xx and 5xx for requests that were actually wrong, or
 * infrastructure that was actually broken, is what lets a caller distinguish the
 * two — a 400 for a valid unroutable pair would tell them to fix a request that
 * has nothing wrong with it.
 *
 * A routing endpoint: no side effects, no persistence, no itinerary generation.
 * The normalised result is all that crosses the boundary — never a raw provider
 * payload, never an endpoint, never an upstream error code.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, RouteApiRequestSchema, {
    maxBytes: ROUTING_LIMITS.maxRequestBodyBytes,
  });
  if (!body.ok) return body.response;

  try {
    // Read before routing: afterwards the result is in the cache either way, so
    // asking then would always answer "hit".
    const fromCache = isRouteCached(body.data);

    const result = await routeSegment(body.data, { signal: request.signal });

    return Response.json(
      { result, fromCache, attribution: ROUTING_ATTRIBUTION },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, "route");
  }
}
