import { MatrixApiRequestSchema } from "@/lib/api/routing-contract";
import { readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import {
  ROUTING_ATTRIBUTION,
  ROUTING_LIMITS,
  isMatrixCached,
  routeMatrix,
} from "@/lib/providers/routing";

/**
 * `POST /api/routes/matrix` — pairwise durations and distances.
 *
 * Costs only. The matrix endpoint returns no geometry, and nothing here
 * synthesises any: `/api/routes/route` remains the sole source of a line that
 * gets drawn. A caller wanting both must ask for both.
 *
 * Unlike the route endpoint, a failure here is a real failure. There is no
 * partial matrix — the cells are read positionally, so "some of them" is not a
 * usable answer — and the error crosses as a status code with a user-safe
 * message.
 *
 * Element count is capped at the contract before any server work happens.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, MatrixApiRequestSchema, {
    maxBytes: ROUTING_LIMITS.maxRequestBodyBytes,
  });
  if (!body.ok) return body.response;

  try {
    // Read before routing: afterwards the entry exists either way.
    const fromCache = isMatrixCached(body.data);

    const matrix = await routeMatrix(body.data, { signal: request.signal });

    return Response.json(
      { matrix, fromCache, attribution: ROUTING_ATTRIBUTION },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, "matrix");
  }
}
