import "server-only";

import type { z } from "zod";

import {
  jsonSchemaText,
  refused,
  unavailable,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type StructuredGenerator,
} from "@/lib/ai";

import { AI_TIMEOUT_MS, type GeminiConfig } from "../config";
import { postProviderJson } from "../http";
import { parseModelJson } from "../parse";
import { GeminiResponseSchema, type GeminiCandidate } from "./schemas";

/**
 * The Gemini adapter.
 *
 * Reached over `fetch` against the REST API rather than through an SDK. Every
 * other provider in this codebase — Nominatim, Overpass, Valhalla — is a
 * hand-written adapter over one endpoint, for the same reasons: the request is a
 * dozen lines, the response is Zod-parsed at the boundary anyway, and a dependency
 * whose types leaked into the domain is exactly what this layer exists to prevent.
 *
 * ## Structured output, and why the schema is in the prompt
 *
 * `responseMimeType: "application/json"` is set, which reliably suppresses prose
 * and markdown fences. The JSON *schema* is embedded in the system instruction
 * rather than passed as `responseJsonSchema`.
 *
 * That is a considered trade. Provider-side schema enforcement is stricter, but
 * the accepted schema dialect is a moving subset — nested `anyOf`, `const`,
 * `minLength` and `additionalProperties` are variously supported across model
 * versions — and a rejected schema is a hard 400 that takes down the whole feature
 * for everyone on that model. A prompt-embedded schema degrades instead: a model
 * that drifts produces output our own validator catches, and the repair pass
 * corrects. Since `outputSchema` is the authority either way, the only thing given
 * up is one round trip in the rare drift case.
 *
 * ## What never leaves this module
 *
 * The `GeminiResponse` shape, `finishReason`, `promptFeedback`, `safetyRatings`,
 * HTTP statuses and the raw body. The caller gets a validated value, a refusal, or
 * a reason code.
 */

/**
 * Output ceilings, per operation.
 *
 * Sized to the answer rather than set to one generous number: truncation is treated
 * as a hard failure here (a half itinerary is not a shorter itinerary), so a limit
 * that is too low turns working output into `invalid_response`. A refinement returns
 * one stop or one day and needs a fraction of an assembly's room.
 */
const MAX_OUTPUT_TOKENS: Record<string, number> = {
  strategy: 8_192,
  assembly: 32_768,
  repair: 32_768,
  refinement: 8_192,
};

export function createGeminiGenerator(config: GeminiConfig): StructuredGenerator {
  return {
    id: "gemini",
    model: config.model,
    generate: (request) => generateWithGemini(config, request),
  };
}

async function generateWithGemini<TSchema extends z.ZodType>(
  config: GeminiConfig,
  request: StructuredGenerationRequest<TSchema>,
): Promise<StructuredGenerationResult<unknown>> {
  const url = `${config.baseUrl}/v1beta/models/${encodeURIComponent(config.model)}:generateContent`;

  const http = await postProviderJson({
    url,
    // The key goes in a header, never in the query string: a URL is logged by
    // proxies and appears in error messages, and a header does not.
    headers: { "x-goog-api-key": config.apiKey },
    body: {
      systemInstruction: {
        parts: [{ text: request.systemInstruction }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: buildUserTurn(request) }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        // Deterministic as the API allows. Planning benefits from consistency far
        // more than from variety, and a reproducible failure is debuggable.
        temperature: 0,
        maxOutputTokens: MAX_OUTPUT_TOKENS[request.operation],
      },
    },
    timeoutMs: AI_TIMEOUT_MS[request.operation],
    signal: request.signal,
  });

  if (!http.ok) {
    logFailure(request.operation, http.reason, http.detail);
    return unavailable(http.reason);
  }

  const envelope = GeminiResponseSchema.safeParse(http.json);
  if (!envelope.success) {
    logFailure(
      request.operation,
      "invalid_response",
      `envelope did not match: ${envelope.error.issues[0]?.message ?? "unknown"}`,
    );
    return unavailable("invalid_response");
  }

  /**
   * A prompt-level block. This arrives as HTTP 200 with **no candidates at all**,
   * so it has to be checked before anything indexes into the array — an
   * unconditional `candidates[0]` is the single most likely production crash in a
   * pipeline like this one.
   */
  if (envelope.data.promptFeedback?.blockReason) {
    logFailure(
      request.operation,
      "refused",
      `prompt blocked: ${envelope.data.promptFeedback.blockReason}`,
    );
    return refused();
  }

  const candidate = envelope.data.candidates?.[0];
  if (!candidate) {
    logFailure(request.operation, "empty_response", "no candidates returned");
    return unavailable("empty_response");
  }

  const verdict = classifyFinish(candidate);
  if (verdict === "refused") {
    logFailure(
      request.operation,
      "refused",
      `finishReason ${candidate.finishReason}`,
    );
    return refused();
  }
  if (verdict === "truncated") {
    // Truncation is not a parse problem to be worked around: the object is
    // genuinely incomplete, and salvaging a prefix would produce a plan missing
    // whatever came after the cut.
    logFailure(
      request.operation,
      "invalid_response",
      "output truncated at the token limit",
    );
    return unavailable("invalid_response");
  }

  const text = candidate.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim();

  const parsed = parseModelJson(text);
  if (!parsed.ok) {
    logFailure(request.operation, parsed.reason, parsed.detail);
    return unavailable(parsed.reason);
  }

  /**
   * The raw object, unparsed and unstripped.
   *
   * `request.outputSchema` is not applied here on purpose — see
   * `StructuredGenerator` in `lib/ai/types.ts`. The prohibited-field scan has to
   * see keys that Zod would silently strip, so the pipeline's validators own the
   * verdict and this adapter owns only transport.
   */
  return {
    status: "success",
    value: parsed.value,
    provider: "gemini",
    model: config.model,
    ...(usageOf(envelope.data.usageMetadata) ?? {}),
  };
}

/**
 * `finishReason`, read as three outcomes rather than a dozen strings.
 *
 * `STOP` and an absent reason are both normal completion. The safety family is a
 * refusal. `MAX_TOKENS` is truncation. Anything else is treated as normal and left
 * to the parser, which will reject genuinely unusable output — guessing at an
 * unfamiliar reason code would be inventing provider behaviour.
 */
function classifyFinish(
  candidate: GeminiCandidate,
): "ok" | "refused" | "truncated" {
  const reason = candidate.finishReason;
  if (!reason || reason === "STOP") return "ok";
  if (reason === "MAX_TOKENS") return "truncated";
  if (
    reason === "SAFETY" ||
    reason === "PROHIBITED_CONTENT" ||
    reason === "BLOCKLIST" ||
    reason === "SPII" ||
    reason === "IMAGE_SAFETY" ||
    reason === "RECITATION"
  ) {
    return "refused";
  }
  return "ok";
}

function usageOf(
  metadata: { promptTokenCount?: number; candidatesTokenCount?: number } | undefined,
) {
  if (!metadata) return undefined;
  const usage = {
    ...(metadata.promptTokenCount !== undefined
      ? { inputTokens: metadata.promptTokenCount }
      : {}),
    ...(metadata.candidatesTokenCount !== undefined
      ? { outputTokens: metadata.candidatesTokenCount }
      : {}),
  };
  return Object.keys(usage).length > 0 ? { usage } : undefined;
}

/**
 * The user turn: the trip, and a restatement of the contract.
 *
 * The schema appears twice — once in the cached system instruction and once here.
 * That is not an oversight: a long candidate list between the instruction and the
 * answer measurably increases drift, and repeating the contract immediately before
 * the answer is the cheapest correction available. The system copy is what a
 * provider caches; this copy is what the model read most recently.
 */
function buildUserTurn<TSchema extends z.ZodType>(
  request: StructuredGenerationRequest<TSchema>,
): string {
  return [
    `Produce one JSON object of type ${request.schemaName}.`,
    "",
    "Input:",
    JSON.stringify(request.input, null, 2),
    "",
    `Required shape (${request.schemaName}):`,
    jsonSchemaText(request.outputSchema),
    "",
    "Respond with the JSON object only.",
  ].join("\n");
}

/** Server-side only. Never returned, never rendered. */
function logFailure(operation: string, kind: string, detail: string): void {
  console.error(
    `[roamly] gemini ${operation} ${kind}`,
    detail.replace(/\s+/g, " ").slice(0, 400),
  );
}
