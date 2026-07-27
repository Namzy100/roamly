import "server-only";

import type { z } from "zod";

import {
  toProviderJsonSchema,
  unavailable,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
  type StructuredGenerator,
} from "@/lib/ai";

import { AI_TIMEOUT_MS, type OllamaConfig } from "../config";
import { postProviderJson } from "../http";
import { parseModelJson } from "../parse";
import { OllamaChatResponseSchema } from "./schemas";

/**
 * The Ollama adapter — a fully local, keyless planner.
 *
 * The most genuinely free option in the project: no account, no key, no quota, and
 * no request leaving the machine. That makes it worth supporting properly rather
 * than as an afterthought, and it also makes it the slowest, which is why its
 * timeout is the longest of the three.
 *
 * ## `format` does real work here
 *
 * Unlike the Gemini adapter, the JSON Schema *is* sent — as `format`. Ollama
 * compiles it to a GBNF grammar and constrains sampling, so the output is
 * structurally valid by construction. That matters far more for a small local
 * model than for a large hosted one: an 8B model asked politely for JSON drifts,
 * and an 8B model grammar-constrained to a schema does not.
 *
 * `json-schema.ts` inlines `$ref`s and rewrites `oneOf` to `anyOf` for exactly this
 * consumer — the grammar compiler handles neither pointer resolution nor `oneOf`
 * reliably.
 *
 * Note what this does *not* buy: a schema-valid object can still name a `placeId`
 * that was never discovered. Grammar constraints police shape, not truth. The
 * no-invention gate is `validate-assembly.ts` and it runs regardless of provider.
 *
 * ## No availability probe
 *
 * Nothing here calls `/api/tags` to check whether the server is up. A probe would
 * double the request count on the happy path and add a speculative network call on
 * a path chosen for being offline. If the server is not there, the POST fails and
 * says so.
 */

export function createOllamaGenerator(config: OllamaConfig): StructuredGenerator {
  return {
    id: "ollama",
    model: config.model,
    generate: (request) => generateWithOllama(config, request),
  };
}

async function generateWithOllama<TSchema extends z.ZodType>(
  config: OllamaConfig,
  request: StructuredGenerationRequest<TSchema>,
): Promise<StructuredGenerationResult<unknown>> {
  const http = await postProviderJson({
    url: `${config.baseUrl}/api/chat`,
    headers: {},
    body: {
      model: config.model,
      stream: false,
      // Constrained decoding. The single biggest reliability win available to a
      // local model, and the reason the schema is sent here but not to Gemini.
      format: toProviderJsonSchema(request.outputSchema),
      messages: [
        { role: "system", content: request.systemInstruction },
        { role: "user", content: buildUserTurn(request) },
      ],
      options: {
        temperature: 0,
        /**
         * A generous context. An assembly prompt is a long instruction plus up to
         * 120 candidates, and the default 2048-token window would silently
         * truncate the candidate list — producing a model that references places
         * it can no longer see, which validation would then reject as
         * fabrication. It is not fabrication; it is a window that was too small.
         */
        num_ctx: 32_768,
      },
    },
    timeoutMs: AI_TIMEOUT_MS[request.operation],
    signal: request.signal,
  });

  if (!http.ok) {
    logFailure(request.operation, http.reason, http.detail);
    return unavailable(http.reason);
  }

  const envelope = OllamaChatResponseSchema.safeParse(http.json);
  if (!envelope.success) {
    logFailure(
      request.operation,
      "invalid_response",
      `envelope did not match: ${envelope.error.issues[0]?.message ?? "unknown"}`,
    );
    return unavailable("invalid_response");
  }

  /**
   * A 200 carrying an error string. Overwhelmingly "model not found, try pulling
   * it first", which is a configuration problem the operator can fix — so it is
   * logged in full server-side and reported as unavailable rather than as a
   * mysterious empty answer.
   */
  if (envelope.data.error) {
    logFailure(
      request.operation,
      "provider_unavailable",
      `ollama error: ${envelope.data.error}`,
    );
    return unavailable("provider_unavailable");
  }

  const content = envelope.data.message?.content;
  const parsed = parseModelJson(content);
  if (!parsed.ok) {
    logFailure(request.operation, parsed.reason, parsed.detail);
    return unavailable(parsed.reason);
  }

  return {
    status: "success",
    value: parsed.value,
    provider: "ollama",
    model: config.model,
    ...usageOf(envelope.data),
  };
}

function usageOf(response: {
  prompt_eval_count?: number;
  eval_count?: number;
}): { usage?: { inputTokens?: number; outputTokens?: number } } {
  const usage = {
    ...(response.prompt_eval_count !== undefined
      ? { inputTokens: response.prompt_eval_count }
      : {}),
    ...(response.eval_count !== undefined
      ? { outputTokens: response.eval_count }
      : {}),
  };
  return Object.keys(usage).length > 0 ? { usage } : {};
}

/**
 * The user turn.
 *
 * The schema is not repeated in the text the way the Gemini adapter repeats it:
 * `format` already constrains the output grammatically, and a local model's
 * context is the scarce resource. Spending a thousand tokens restating a contract
 * the sampler cannot violate would push the candidate list closer to the window
 * edge for no gain.
 */
function buildUserTurn<TSchema extends z.ZodType>(
  request: StructuredGenerationRequest<TSchema>,
): string {
  return [
    `Produce one JSON object of type ${request.schemaName}.`,
    "",
    "Input:",
    JSON.stringify(request.input, null, 2),
  ].join("\n");
}

function logFailure(operation: string, kind: string, detail: string): void {
  console.error(
    `[roamly] ollama ${operation} ${kind}`,
    detail.replace(/\s+/g, " ").slice(0, 400),
  );
}
