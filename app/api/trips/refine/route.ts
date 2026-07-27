import {
  REFINE_MAX_BODY_BYTES,
  RefineTripRequestSchema,
  type RefineTripResponse,
} from "@/lib/api/refine-contract";
import { SSE_EVENT } from "@/lib/api/generate-contract";
import { jsonError, readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import { MAX_TRIP_DAYS } from "@/lib/schemas";
import { MAX_PERSISTED_POOL_PLACES } from "@/lib/schemas/generation";
import { refineTrip } from "@/lib/refinement";
import type { RefinementStage, TripRefinementResult } from "@/lib/refinement";

/**
 * `POST /api/trips/refine` — one bounded change to a saved trip.
 *
 * ## Nothing is persisted, and that is the rollback guarantee
 *
 * Same shape as the other two write-adjacent routes: a pure server transformation. It
 * reads a plan, returns a candidate replacement, and forgets both. The guarded save
 * happens client-side against the revision it read before starting.
 *
 * The consequence is the property this phase turns on: a refinement that fails at any
 * point — a refusal, a rejected place, a timeout, a cancelled request — leaves the
 * traveller's saved trip **untouched**. Not rolled back; never written to.
 *
 * ## No routing calls
 *
 * Not one. A refinement invalidates routes by dropping results whose adjacency no
 * longer exists, and recalculating is a separate action the traveller takes through
 * `POST /api/trips/route`. That keeps this endpoint off the routing budget and keeps
 * an edit from silently costing twenty requests to a donated server.
 *
 * ## Duration
 *
 * `maxDuration = 90`, against a 60 s internal budget. Shorter than generation because
 * a refinement is one small model call rather than two large ones — and a traveller
 * waiting on an edit has less patience than one waiting on a whole trip.
 */

export const maxDuration = 90;

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, RefineTripRequestSchema, {
    maxBytes: REFINE_MAX_BODY_BYTES,
  });
  if (!body.ok) return body.response;

  const {
    plan,
    generation,
    command,
    providerPreference,
    expectedRevision,
    requestId,
  } = body.data;

  /**
   * Caps re-checked here rather than trusted from the client.
   *
   * `TripPlanSchema` already bounds days and `TripGenerationContextSchema` bounds the
   * pool, so these are defence in depth — but they are the caps that protect the
   * *provider* budget, and they cost two comparisons.
   */
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

  /**
   * The command must name a day this trip has.
   *
   * Checked before the model call, so an out-of-range day costs nothing. The
   * orchestrator checks it again — it is the authority — but failing early keeps a
   * typo from consuming quota.
   */
  if ("dayNumber" in command) {
    const exists = plan.days.some((day) => day.dayNumber === command.dayNumber);
    if (!exists) {
      return jsonError(
        400,
        "unknown_day",
        `This trip has no day ${command.dayNumber}.`,
      );
    }
  }

  const wantsStream = (request.headers.get("accept") ?? "").includes(
    "text/event-stream",
  );

  if (!wantsStream) {
    try {
      const result = await refineTrip({
        plan,
        generation,
        command,
        providerPreference,
        revisionBefore: expectedRevision,
        signal: request.signal,
      });
      return Response.json(toResponseBody(result, requestId, expectedRevision), {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return toErrorResponse(error, "trip-refinement");
    }
  }

  return streamRefinement({
    plan,
    generation,
    command,
    providerPreference,
    expectedRevision,
    requestId,
    signal: request.signal,
  });
}

/**
 * The SSE variant.
 *
 * Progress events are stage names and nothing else. As with generation, **no part of
 * the plan is streamed**: the replacement is buffered, validated in full, and
 * delivered once. A half-applied refinement rendered as though it were final is the
 * failure this whole phase is arranged to prevent.
 */
function streamRefinement(context: {
  plan: Parameters<typeof refineTrip>[0]["plan"];
  generation: Parameters<typeof refineTrip>[0]["generation"];
  command: Parameters<typeof refineTrip>[0]["command"];
  providerPreference: Parameters<typeof refineTrip>[0]["providerPreference"];
  expectedRevision: number;
  requestId: string;
  signal: AbortSignal;
}): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          closed = true;
        }
      };

      try {
        const result = await refineTrip({
          plan: context.plan,
          generation: context.generation,
          command: context.command,
          providerPreference: context.providerPreference,
          revisionBefore: context.expectedRevision,
          signal: context.signal,
          onProgress: (stage: RefinementStage) =>
            send(SSE_EVENT.progress, { stage }),
        });

        send(
          SSE_EVENT.result,
          toResponseBody(result, context.requestId, context.expectedRevision),
        );
      } catch (error) {
        console.error("[roamly] refinement stream failed", error);
        send(SSE_EVENT.result, {
          status: "unavailable",
          reason: "unknown",
          userMessage:
            "Something went wrong making that change, so your trip was left unchanged. Please try again.",
          requestId: context.requestId,
        } satisfies RefineTripResponse);
      } finally {
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the client disconnecting.
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * The pipeline's result → the wire.
 *
 * The narrow point everything the browser learns passes through. Internal error
 * context (`placeId`) is dropped; `dayNumber` and `itemId` survive because the UI uses
 * them to point at the card the problem is about, and both are the client's own ids.
 */
export function toResponseBody(
  result: TripRefinementResult,
  requestId: string,
  expectedRevision: number,
): RefineTripResponse {
  switch (result.status) {
    case "success":
      return {
        status: "success",
        plan: result.plan,
        generationContext: result.generationContext,
        summary: result.summary,
        warnings: [],
        expectedRevision,
        requestId,
      };
    case "partial":
      return {
        status: "partial",
        plan: result.plan,
        generationContext: result.generationContext,
        summary: result.summary,
        warnings: result.warnings,
        expectedRevision,
        requestId,
      };
    case "refused":
      return { status: "refused", userMessage: result.userMessage, requestId };
    case "unavailable":
      return {
        status: "unavailable",
        reason: result.reason,
        userMessage: result.userMessage,
        requestId,
      };
    case "failed":
      return {
        status: "failed",
        errors: result.errors.map((error) => ({
          code: error.code,
          message: error.message,
          ...(error.dayNumber !== undefined ? { dayNumber: error.dayNumber } : {}),
          ...(error.itemId !== undefined ? { itemId: error.itemId } : {}),
        })),
        userMessage: result.userMessage,
        requestId,
      };
  }
}
