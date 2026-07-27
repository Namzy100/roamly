import {
  REFRESH_POOL_MAX_BODY_BYTES,
  RefreshPoolRequestSchema,
  type RefreshPoolResponse,
} from "@/lib/api/refresh-pool-contract";
import { jsonError, readJsonBody } from "@/lib/api/route-helpers";
import { logOperation } from "@/lib/providers/log";
import {
  REFRESH_POOL_BUDGET_MS,
  refreshPlacePool,
} from "@/lib/generate/refresh-pool";
import { MAX_TRIP_DAYS, validatePool } from "@/lib/schemas";
import { MAX_PERSISTED_POOL_PLACES } from "@/lib/schemas/generation";
import {
  diffPlacePools,
  previewReconciliation,
  type ReconciliationPolicy,
} from "@/lib/structural-edits";

/**
 * `POST /api/trips/refresh-pool` — re-run a saved trip's place search.
 *
 * ## A preview endpoint, not a write endpoint
 *
 * It returns a refreshed pool, a diff, and what each reconciliation policy *would* do. It
 * persists nothing, mutates nothing, and returns no replacement plan. The traveller sees the
 * consequences, chooses, and the browser applies the pure reconciliation and saves under the
 * revision it read before starting — so cancelling at the confirmation step costs one Overpass
 * search and changes nothing at all.
 *
 * ## No model, no routing, no geocoding
 *
 * Not one request to any of the three. The destination comes from the trip's own stored
 * identity: re-geocoding "Lisbon" could resolve to a different Lisbon and silently move the
 * trip, so a missing identity is a clean failure rather than a fresh choice.
 *
 * ## Duration
 *
 * `maxDuration = 60`, against a 45 s internal budget. Three paced Overpass requests, no model
 * call — materially cheaper than generation, and the shorter ceiling says so.
 */

export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, RefreshPoolRequestSchema, {
    maxBytes: REFRESH_POOL_MAX_BODY_BYTES,
  });
  if (!body.ok) return body.response;

  const {
    plan,
    generation,
    categories,
    radiusMeters,
    expectedRevision,
    requestId,
  } = body.data;

  // Defence in depth: both are already bounded by the schemas, and both protect the provider.
  if (plan.days.length > MAX_TRIP_DAYS) {
    return jsonError(
      400,
      "too_many_days",
      `A trip may span at most ${MAX_TRIP_DAYS} days.`,
    );
  }
  if (generation.placePool.places.length > MAX_PERSISTED_POOL_PLACES) {
    return jsonError(
      400,
      "pool_too_large",
      `A place pool holds at most ${MAX_PERSISTED_POOL_PLACES} places.`,
    );
  }

  const destination = generation.destination;

  /**
   * The trip must know where it is.
   *
   * A pool built from the plan rather than from a search has no OSM identity behind it, and
   * searching around a guessed centre would produce a pool that cannot be compared with the
   * one it replaces.
   */
  if (
    destination.source.provider !== "openstreetmap" ||
    !generation.placePool.poolId.startsWith("discovery:")
  ) {
    return respond(
      {
        status: "failed",
        reason: "destination_unavailable",
        userMessage:
          "This trip's places did not come from a recorded OpenStreetMap search, so there is nothing to re-run. Generating a trip creates one.",
        requestId,
      },
      200,
    );
  }

  const deadline = withDeadline(request.signal, REFRESH_POOL_BUDGET_MS);
  const started = Date.now();

  /** One line per refresh, carrying no destination, no place and no itinerary. See `lib/providers/log.ts`. */
  const record = (result: Parameters<typeof logOperation>[0]["result"], partial?: boolean) =>
    logOperation({
      operation: "refresh-pool",
      provider: "places",
      result,
      durationMs: Date.now() - started,
      requestId,
      ...(partial === undefined ? {} : { partial }),
    });

  try {
    const outcome = await refreshPlacePool({
      destination: {
        canonicalId: destination.canonicalId,
        name: destination.name,
        latitude: destination.latitude,
        longitude: destination.longitude,
      },
      // The original search's categories and radius unless the traveller narrowed them.
      categories: categories ?? generation.discoverySummary.categoriesRequested,
      radiusMeters: radiusMeters ?? generation.discoverySummary.radiusMeters,
      limitPerCategory: Math.max(
        4,
        Math.ceil(
          generation.discoverySummary.candidateCount /
            Math.max(1, generation.discoverySummary.categoriesRequested.length),
        ),
      ),
      signal: deadline.signal,
    });

    if (outcome.status === "failed") {
      record("empty");
      return respond(
        {
          status: "failed",
          reason: "no_results",
          userMessage: outcome.message,
          requestId,
        },
        200,
      );
    }

    /**
     * The refreshed pool is validated before it is described.
     *
     * `buildVerifiedPlacePool` already asserts identity, so this is defence in depth — but a
     * malformed pool must never reach a diff, because the diff is what the traveller makes a
     * decision from.
     */
    const poolCheck = validatePool(outcome.pool.places);
    if (!poolCheck.ok) {
      console.error(
        "[roamly] refreshed pool failed verification",
        poolCheck.error.code,
      );
      record("invalid");
      return respond(
        {
          status: "failed",
          reason: "pool_invalid",
          userMessage:
            "The refreshed place search produced records that did not pass verification, so nothing was changed.",
          requestId,
        },
        200,
      );
    }

    const changes = diffPlacePools({
      previous: generation.placePool,
      next: outcome.pool,
      plan,
    });

    record(outcome.partial ? "partial" : "ok", outcome.partial);

    const policies: ReconciliationPolicy[] = [
      "keep-valid-and-flag-missing",
      "replace-missing-with-unavailable",
    ];

    return respond(
      {
        status: "ok",
        pool: outcome.pool,
        discoverySummary: outcome.summary,
        changes,
        // Both, from one search. See the contract's note.
        previews: [
          previewReconciliation({
            plan,
            generation,
            nextPool: outcome.pool,
            changes,
            policy: policies[0],
          }),
          previewReconciliation({
            plan,
            generation,
            nextPool: outcome.pool,
            changes,
            policy: policies[1],
          }),
        ],
        partial: outcome.partial,
        // Our codes and our sentences; a provider host never appears in one.
        warnings: outcome.warnings.map((warning) => ({
          code: warning.code,
          message: warning.message,
        })),
        expectedRevision,
        requestId,
      },
      200,
    );
  } catch (error) {
    if (deadline.timedOut) {
      record("timeout");
      return respond(
        {
          status: "failed",
          reason: "timeout",
          userMessage:
            "The place search took longer than the time available, so nothing was changed. Please try again.",
          requestId,
        },
        200,
      );
    }
    if (error instanceof Error && error.name === "AbortError") {
      record("aborted");
      return respond(
        {
          status: "failed",
          reason: "aborted",
          userMessage: "The place search was cancelled, so nothing was changed.",
          requestId,
        },
        200,
      );
    }

    console.error("[roamly] pool refresh failed unexpectedly", error);
    record("unavailable");
    return respond(
      {
        status: "failed",
        reason: "provider_unavailable",
        userMessage:
          "The place search could not be reached, so nothing was changed. Please try again.",
        requestId,
      },
      200,
    );
  } finally {
    deadline.dispose();
  }
}

/**
 * A failure is a 200 with a `failed` body, matching the other trip routes.
 *
 * The request was well-formed and was handled; what failed is the *operation*. Returning a 5xx
 * would invite a retry layer somewhere to repeat an Overpass search on the traveller's behalf,
 * which is exactly what the pacing rules exist to prevent.
 */
function respond(body: RefreshPoolResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/** One signal for the whole handler, mirroring the generation pipeline's. */
function withDeadline(
  callerSignal: AbortSignal | undefined,
  budgetMs: number,
): { signal: AbortSignal; timedOut: boolean; dispose: () => void } {
  const controller = new AbortController();
  const state = {
    signal: controller.signal,
    timedOut: false,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    },
  };

  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort(new DOMException("Refresh budget exhausted", "TimeoutError"));
  }, budgetMs);

  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

  return state;
}
