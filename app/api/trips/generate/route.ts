import { nanoid } from "nanoid";

import {
  GENERATE_MAX_BODY_BYTES,
  GenerateTripRequestSchema,
  PROVIDER_LABELS,
  SSE_EVENT,
  type GenerateTripResponse,
} from "@/lib/api/generate-contract";
import { jsonError, readJsonBody, toErrorResponse } from "@/lib/api/route-helpers";
import { generateTripPlan } from "@/lib/generate";
import type { GenerationStage, TripGenerationResult } from "@/lib/generate";
import { MAX_TRIP_DAYS, tripDayCount } from "@/lib/schemas";

/**
 * `POST /api/trips/generate` — the whole generation pipeline, once.
 *
 * ## Nothing is persisted, again
 *
 * Same shape as `POST /api/trips/route`: a pure server transformation. The trip lives
 * in the traveller's browser, so the server has nothing to write to. It builds a
 * plan, validates it, returns it, and forgets it. The atomic save happens
 * client-side, and a run that fails at the final gate therefore leaves nothing at all
 * — no orphaned trip, no half-written pool.
 *
 * ## Two response shapes, one pipeline
 *
 * `Accept: text/event-stream` gets progress events followed by one `result` event.
 * Anything else gets plain JSON. The pipeline is identical; only the delivery
 * differs, which is what lets `curl` and the test suite exercise the same code path
 * the browser does.
 *
 * The stream carries **no part of the plan**. Progress events are stage names, and
 * the itinerary arrives once, whole and already validated. Streaming partial
 * itinerary JSON would mean a renderable half-plan existed, and a half-plan that
 * looks final is the failure this codebase exists to prevent.
 *
 * ## Duration
 *
 * `maxDuration = 120`, against an internal budget of 90 s (`GENERATION_BUDGET_MS`).
 * The internal budget is the real limit: it aborts every model call and every
 * Overpass request together and returns a controlled timeout, rather than letting the
 * platform kill the function and leave the browser with a dead connection.
 *
 * **Deployment limitation, stated plainly.** Vercel's Hobby tier caps a serverless
 * function well below 120 s, and a long generation — a slow local model, a loaded
 * Overpass — can exceed it. When the platform cuts the request the traveller sees a
 * network failure rather than our timeout message, and nothing is saved either way.
 * The mitigations are the deterministic planner, which needs no model call, and
 * Gemini Flash, which is fast. A platform with a longer ceiling removes the issue
 * entirely.
 */

export const maxDuration = 120;

export async function POST(request: Request): Promise<Response> {
  const body = await readJsonBody(request, GenerateTripRequestSchema, {
    maxBytes: GENERATE_MAX_BODY_BYTES,
  });
  if (!body.ok) return body.response;

  const { request: tripRequest, destination, providerPreference, requestId } =
    body.data;

  /**
   * The day cap, enforced before anything expensive.
   *
   * `TripRequestSchema` already refuses more than seven days, so this is defence in
   * depth rather than the primary guard — but it is the guard that protects the
   * *provider* budget, and it costs one comparison.
   */
  const dayCount = tripDayCount(tripRequest);
  if (dayCount > MAX_TRIP_DAYS) {
    return jsonError(
      400,
      "too_many_days",
      `A trip may span at most ${MAX_TRIP_DAYS} days.`,
    );
  }

  // Server-side, so a client cannot choose a trip id that collides with one it
  // already has.
  const tripId = nanoid(10);

  const wantsStream = (request.headers.get("accept") ?? "").includes(
    "text/event-stream",
  );

  if (!wantsStream) {
    try {
      const result = await generateTripPlan({
        tripId,
        request: tripRequest,
        selectedDestination: destination,
        providerPreference,
        signal: request.signal,
      });
      return Response.json(toResponseBody(result, requestId), {
        status: 200,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return toErrorResponse(error, "trip-generation");
    }
  }

  return streamGeneration({
    tripId,
    tripRequest,
    destination,
    providerPreference,
    requestId,
    signal: request.signal,
  });
}

/**
 * The SSE variant.
 *
 * Progress events are enqueued synchronously from the pipeline's `onProgress`
 * callback, which is why that callback is never awaited — a progress report that
 * could apply backpressure would let the UI pace the work, and a slow reader would
 * make generation slower rather than merely less informative.
 *
 * The pipeline never throws for a generation outcome, so the `catch` here is for
 * genuinely unexpected failures only. It still emits a `result` event: a stream that
 * closes without one would leave the browser waiting forever, which is a worse
 * failure than an honest error.
 */
function streamGeneration(context: {
  tripId: string;
  tripRequest: Parameters<typeof generateTripPlan>[0]["request"];
  destination: Parameters<typeof generateTripPlan>[0]["selectedDestination"];
  providerPreference: Parameters<typeof generateTripPlan>[0]["providerPreference"];
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
          // The client went away mid-write. Not an error worth reporting: the
          // caller's abort signal is what actually stops the work.
          closed = true;
        }
      };

      try {
        const result = await generateTripPlan({
          tripId: context.tripId,
          request: context.tripRequest,
          selectedDestination: context.destination,
          providerPreference: context.providerPreference,
          signal: context.signal,
          onProgress: (stage: GenerationStage) => send(SSE_EVENT.progress, { stage }),
        });

        send(SSE_EVENT.result, toResponseBody(result, context.requestId));
      } catch (error) {
        console.error("[roamly] generation stream failed", error);
        send(SSE_EVENT.result, {
          status: "unavailable",
          reason: "unknown",
          userMessage:
            "Something went wrong generating this trip, so nothing was saved. Please try again.",
          requestId: context.requestId,
        } satisfies GenerateTripResponse);
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
      // Proxies that buffer an event stream turn real progress into one burst at
      // the end, which defeats the entire purpose of streaming it.
      "X-Accel-Buffering": "no",
    },
  });
}

/**
 * The pipeline's result → the wire.
 *
 * The narrow point through which everything the browser learns must pass. Note what
 * it drops: the pipeline's internal violation objects keep their `code` and
 * `message` and lose their `dayNumber`/`placeId` context; nothing carries a provider
 * name, a prompt, a raw response or a stack trace. `providerLabel` is a display
 * string from a fixed table, not a model id.
 */
export function toResponseBody(
  result: TripGenerationResult,
  requestId: string,
): GenerateTripResponse {
  switch (result.status) {
    case "success":
      return {
        status: "success",
        plan: result.plan,
        generation: result.generation,
        providerLabel:
          PROVIDER_LABELS[result.generation.provider] ?? "Demo Planner",
        warnings: [],
        requestId,
      };
    case "partial":
      return {
        status: "partial",
        plan: result.plan,
        generation: result.generation,
        providerLabel:
          PROVIDER_LABELS[result.generation.provider] ?? "Demo Planner",
        warnings: result.warnings,
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
        violations: result.violations.map((violation) => ({
          code: violation.code,
          message: violation.message,
        })),
        userMessage: result.userMessage,
        requestId,
      };
  }
}
