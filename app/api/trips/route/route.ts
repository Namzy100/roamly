import { readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import {
  TRIP_ROUTING_MAX_BODY_BYTES,
  TripRoutingRequestSchema,
} from "@/lib/api/trip-routing-contract";
import { routeTripPlan } from "@/lib/providers/routing";

/**
 * `POST /api/trips/route` — every eligible leg of a whole trip, routed.
 *
 * A pure transformation: plan in, enriched plan out. **Nothing is persisted
 * here.** The trip lives in the caller's browser, so the server has nothing to
 * write to and no business writing anywhere else. The guarded save happens
 * client-side against the revision the caller read before starting, which is
 * echoed back untouched so it survives the round trip.
 *
 * ## Timing
 *
 * A five-day trip is ~19 legs. At three concurrent provider requests and a
 * 250 ms gap between starts, a fully uncached run is typically 8–15 s and slower
 * when the shared demo server is loaded — hence `maxDuration` below rather than
 * relying on a platform default. Cached legs cost nothing, so re-running after a
 * partial failure is fast.
 *
 * Partial success is a **200** with `status: "partial"` and a complete plan.
 * Only a contract violation yields `failed`, and only a malformed request or a
 * broken provider yields a 4xx/5xx.
 */

/**
 * Above the expected worst case, below Vercel's Hobby ceiling.
 *
 * Not a promise that the work takes this long — it is the point at which the
 * platform stops waiting. The client sends an `AbortSignal` of its own, and the
 * bounded leg count is what actually keeps the work finite.
 */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, TripRoutingRequestSchema, {
    maxBytes: TRIP_ROUTING_MAX_BODY_BYTES,
  });
  if (!body.ok) return body.response;

  const { plan, placePool, policy, expectedRevision, retryLegIds } = body.data;

  try {
    const result = await routeTripPlan({
      plan,
      placePool,
      // A partial policy is completed against the defaults inside
      // `planRoutingPolicy`, so it passes straight through.
      policy,
      // Absent for a whole-trip run; present for a targeted retry. Filtered against
      // the plan's expected legs server-side — see `routeTripPlan`.
      ...(retryLegIds ? { retryLegIds } : {}),
      signal: request.signal,
    });

    if (result.status === "failed") {
      // A contract violation is our bug, not the caller's, and it is logged in
      // full server-side. The response carries our own codes and messages —
      // never a provider name, a hostname or a stack trace.
      console.error(
        "[roamly] trip routing enrichment failed",
        JSON.stringify(result.errors),
      );
      return Response.json(
        { status: "failed", errors: result.errors, expectedRevision },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }

    return Response.json(
      {
        status: result.status,
        plan: result.plan,
        summary: result.summary,
        expectedRevision,
        attribution: result.attribution,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return toErrorResponse(error, "trip-routing");
  }
}
