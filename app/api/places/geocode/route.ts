import { GeocodeRequestSchema } from "@/lib/api/places-contract";
import { readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import { geocodeDestination } from "@/lib/providers/osm";

/**
 * `POST /api/places/geocode` — destination candidates for a search string.
 *
 * POST rather than GET so the query is not baked into a URL that ends up in logs,
 * browser history and referrer headers, and so the body size can be bounded.
 *
 * This is a **discovery** endpoint. It has no side effects, writes nothing, and
 * does not generate or persist an itinerary.
 *
 * Deliberately returns *all* plausible candidates rather than picking one. Choosing
 * between "Lisbon, Portugal" and "Lisbon, Ohio" needs the user, and silently taking
 * the first match is how a trip ends up on the wrong continent.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, GeocodeRequestSchema);
  if (!body.ok) return body.response;

  try {
    const result = await geocodeDestination({
      destination: body.data.destination,
      countryCode: body.data.countryCode,
      signal: request.signal,
    });

    return Response.json(result, {
      status: 200,
      headers: {
        // Our own in-process cache is the real one; this just stops intermediaries
        // holding a copy we cannot invalidate.
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return toErrorResponse(error, "geocode");
  }
}
