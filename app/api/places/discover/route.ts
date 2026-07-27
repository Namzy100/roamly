import { DiscoverRequestSchema } from "@/lib/api/places-contract";
import { readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import { discoverPlaces } from "@/lib/providers/osm";
import { buildVerifiedPlacePool, PoolValidationError } from "@/lib/schemas/pool";

/**
 * `POST /api/places/discover` — verified places near a point, by category.
 *
 * Every returned place is run through pool construction before the response is
 * built, so a record that would fail verification never reaches a caller. The pool
 * result is reported alongside the places, which is what lets the dev surface show
 * "pool validates" rather than asking anyone to take it on trust.
 *
 * A discovery endpoint: no side effects, no persistence, no itinerary generation.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, DiscoverRequestSchema);
  if (!body.ok) return body.response;

  try {
    const result = await discoverPlaces({
      center: body.data.center,
      categories: body.data.categories,
      radiusMeters: body.data.radiusMeters,
      limitPerCategory: body.data.limitPerCategory,
      signal: request.signal,
    });

    // Deterministic pool id: same query, same pool identity, so a cached response
    // and a fresh one are indistinguishable to the caller.
    const poolId = [
      "pool",
      result.query.center.latitude.toFixed(5),
      result.query.center.longitude.toFixed(5),
      result.query.radiusMeters,
      result.categoriesRequested.join("+"),
    ].join(":");

    let pool: {
      valid: boolean;
      poolId: string;
      placeCount: number;
      error?: string;
    };

    try {
      const built = buildVerifiedPlacePool(result.places, {
        poolId,
        createdAt: result.fetchedAt,
        categories: result.categoriesRequested,
        attribution: result.attribution,
      });
      pool = { valid: true, poolId, placeCount: built.places.length };
    } catch (error) {
      // A pool failure is a bug in normalisation, not a user error. Report it
      // rather than returning places that failed verification.
      if (error instanceof PoolValidationError) {
        console.error("[roamly] discover pool validation failed", error.message);
        return toErrorResponse(error, "discover");
      }
      throw error;
    }

    return Response.json(
      { ...result, pool },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, "discover");
  }
}
