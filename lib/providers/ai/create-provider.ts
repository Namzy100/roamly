import "server-only";

import type { AiProviderPreference, StructuredGenerator } from "@/lib/ai";

import { resolveAiConfig, resolveProviderId, type AiConfig } from "./config";
import { createDeterministicGenerator } from "./deterministic/generate";
import { createGeminiGenerator } from "./gemini/generate";
import { createOllamaGenerator } from "./ollama/generate";

/**
 * Provider selection — the whole of it, in one function.
 *
 * ## The only rule that matters
 *
 * An explicit request that cannot be met returns `not_configured`. It does not
 * fall back.
 *
 * That is the difference between "free by default" and "quietly dishonest": a
 * traveller who chose "Generate with AI" and received a template itinerary
 * labelled as AI output has been misled about how their plan was made. So the
 * fallback chain exists only inside `auto`, where the caller has explicitly said
 * they do not mind, and `resolveProviderId` is where that distinction lives.
 *
 * ## No probing
 *
 * Nothing here makes a network call. Selection is a function of configuration
 * only, so choosing a provider costs nothing and cannot fail — which is what lets
 * the status route answer instantly and lets `auto` be the default without a
 * latency penalty on every request.
 *
 * The cost is that a configured-but-stopped Ollama is selected and then fails at
 * the first call. That is the right trade: the failure is reported honestly with a
 * reason code, and it happens once per generation rather than adding a speculative
 * request to every one.
 */

export type ProviderSelection =
  | { ok: true; generator: StructuredGenerator }
  | { ok: false; reason: "not_configured" };

export function createStructuredGenerator(input: {
  preference?: AiProviderPreference;
  config?: AiConfig;
} = {}): ProviderSelection {
  const config = input.config ?? resolveAiConfig();
  const providerId = resolveProviderId(config, input.preference);

  if (providerId === null) return { ok: false, reason: "not_configured" };

  switch (providerId) {
    case "gemini":
      // Non-null by construction: `resolveProviderId` only returns `gemini` when
      // the config carries one.
      return { ok: true, generator: createGeminiGenerator(config.gemini!) };
    case "ollama":
      return { ok: true, generator: createOllamaGenerator(config.ollama!) };
    case "deterministic":
      return { ok: true, generator: createDeterministicGenerator() };
  }
}
