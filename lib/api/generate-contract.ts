import { z } from "zod";

import {
  GeocodedDestinationSchema,
  GenerationWarningSchema,
  TripGenerationContextSchema,
  TripPlanSchema,
  TripRequestSchema,
} from "@/lib/schemas";
import { GENERATION_STAGES } from "@/lib/generate/types";

/**
 * The contract for `POST /api/trips/generate`.
 *
 * ## What crosses, and what deliberately does not
 *
 * **In:** the validated request, the destination candidate the traveller picked, a
 * provider preference, and a request id. Small — a couple of kilobytes — so the body
 * ceiling is tight.
 *
 * **Out:** a result arm, a complete `TripPlan`, the generation context carrying the
 * exact pool, warnings, and a provider label fit for a UI.
 *
 * **Never out:** the raw model response, the prompts, the system instruction, the
 * raw Overpass payload, a model's chain of thought, an API key, a provider hostname,
 * an HTTP status from upstream, or a stack trace. The `failed` arm carries our own
 * violation codes and our own sentences; `unavailable` carries a reason code from a
 * closed set. Everything else is logged server-side and stays there.
 *
 * ## Why the destination is sent rather than the raw string
 *
 * Geocoding happens first, as its own step, because "Lisbon" is ambiguous and
 * choosing between Portugal and Ohio is the traveller's decision. By the time this
 * route runs the choice is made, and the coordinates in the request are Nominatim's
 * — which is what lets the pipeline guarantee no coordinate in the finished plan
 * came from a model.
 *
 * `server-only` is deliberately absent: the browser builds these requests and parses
 * these responses. That is safe because this module contains no provider access and
 * no endpoint — only our own shapes.
 */

/** A request is request + destination + two scalars. Nothing legitimate is larger. */
export const GENERATE_MAX_BODY_BYTES = 8 * 1024;

export const AiProviderPreferenceSchema = z.enum([
  "auto",
  "gemini",
  "ollama",
  "deterministic",
]);
export type AiProviderPreferenceInput = z.infer<
  typeof AiProviderPreferenceSchema
>;

export const GenerateTripRequestSchema = z.object({
  request: TripRequestSchema,
  /**
   * The candidate the traveller selected from the geocoder's list. Re-validated
   * here, so a hand-rolled request cannot smuggle in coordinates outside the
   * schema's bounds.
   */
  destination: GeocodedDestinationSchema,
  providerPreference: AiProviderPreferenceSchema.default("auto"),
  /**
   * A client-generated id, echoed back untouched.
   *
   * Not an idempotency key — the server stores nothing, so it has nothing to
   * deduplicate against. It exists so the browser can discard a response that
   * belongs to a superseded request, which is what stops a slow first generation
   * overwriting a fast second one.
   */
  requestId: z.string().min(8).max(64),
});
export type GenerateTripRequest = z.infer<typeof GenerateTripRequestSchema>;

/**
 * The provider, as the UI is allowed to describe it.
 *
 * A display label rather than a model id: "Gemini" is what a traveller understands,
 * and `gemini-2.5-flash` in a headline would be noise. The model id travels inside
 * the generation context for a details panel.
 */
export const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  ollama: "Ollama",
  deterministic: "Demo Planner",
};

const SuccessBase = {
  plan: TripPlanSchema,
  generation: TripGenerationContextSchema,
  providerLabel: z.string().min(1),
  requestId: z.string().min(1),
};

export const GenerateTripResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    ...SuccessBase,
    warnings: z.array(GenerationWarningSchema).length(0),
  }),
  z.object({
    /** A valid, saveable plan that contains visible gaps. Still a 200. */
    status: z.literal("partial"),
    ...SuccessBase,
    warnings: z.array(GenerationWarningSchema).min(1),
  }),
  z.object({
    status: z.literal("refused"),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    status: z.literal("unavailable"),
    reason: z.enum([
      "not_configured",
      "rate_limited",
      "timeout",
      "provider_unavailable",
      "invalid_response",
      "empty_response",
      "aborted",
      "unknown",
    ]),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
  z.object({
    status: z.literal("failed"),
    /** Our codes and our sentences. Never a provider's. */
    violations: z.array(
      z.object({ code: z.string().min(1), message: z.string().min(1) }),
    ),
    userMessage: z.string().min(1),
    requestId: z.string().min(1),
  }),
]);
export type GenerateTripResponse = z.infer<typeof GenerateTripResponseSchema>;

/**
 * A progress event on the server-sent stream.
 *
 * Streamed for one reason: the stages are real. Each event is emitted when that work
 * actually begins, so the progress a traveller watches is a report rather than a
 * timed animation pretending to be one.
 *
 * What is **not** streamed is any part of the plan. No partial model JSON, no
 * half-built day, nothing renderable. The itinerary is buffered, validated in full
 * and delivered once as a `result` event — see ARCHITECTURE §14 — because a partial
 * itinerary shown as though it were final is exactly the failure mode this codebase
 * spends its effort preventing.
 */
export const GenerationProgressEventSchema = z.object({
  stage: z.enum(GENERATION_STAGES),
});
export type GenerationProgressEvent = z.infer<
  typeof GenerationProgressEventSchema
>;

/** SSE event names, so the client and the route cannot disagree about them. */
export const SSE_EVENT = {
  progress: "progress",
  result: "result",
} as const;

/** What `GET /api/ai/status` answers. Booleans about configuration; never values. */
export const AiStatusResponseSchema = z.object({
  geminiConfigured: z.boolean(),
  ollamaConfigured: z.boolean(),
  resolvedProvider: z.enum(["gemini", "ollama", "deterministic"]),
  /** True when a real model can be offered. False means demo-only, honestly. */
  modelAvailable: z.boolean(),
  providerLabel: z.string().min(1),
});
export type AiStatusResponse = z.infer<typeof AiStatusResponseSchema>;
