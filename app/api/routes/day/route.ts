import { DayApiRequestSchema } from "@/lib/api/routing-contract";
import { readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import { ROUTING_LIMITS, routeDayPlaces } from "@/lib/providers/routing";
import { DEFAULT_MODE_POLICY } from "@/lib/routing";

/**
 * `POST /api/routes/day` — every leg of one day, routed.
 *
 * ## Partial success is the contract
 *
 * A day of eight stops is seven legs, and one of them failing says nothing about
 * the other six. The response is always the full set with a per-leg status, plus
 * counts in `day.summary`, so a caller can render six real routes and one honest
 * gap. Discarding the six because of the one would be the worst possible
 * handling of a flaky shared server.
 *
 * ## One day, never several
 *
 * The route takes a single day's stops. Nothing here joins the end of one day to
 * the start of the next — that is a leg no traveller makes, and routing it would
 * put a line across the map between Tuesday night and Wednesday morning.
 *
 * No side effects, no persistence, no reordering, no itinerary generation. The
 * stops come back in exactly the order they were sent.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, DayApiRequestSchema, {
    maxBytes: ROUTING_LIMITS.maxRequestBodyBytes,
  });
  if (!body.ok) return body.response;

  const { stops, mode, modePolicy, dayNumber } = body.data;

  try {
    const day = await routeDayPlaces({
      places: stops,
      /**
       * An explicit `mode` wins and is applied to every leg — that is what
       * "the user picked cycling" means. Otherwise the supplied policy, or the
       * default, chooses per leg from straight-line distance.
       */
      modePolicy: mode
        ? { ...(modePolicy ?? DEFAULT_MODE_POLICY), forcedMode: mode }
        : modePolicy,
      dayNumber: dayNumber ?? null,
      signal: request.signal,
    });

    return Response.json(
      { day },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, "day");
  }
}
