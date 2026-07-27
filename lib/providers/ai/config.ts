import "server-only";

import type { AiProviderPreference } from "@/lib/ai";

/**
 * The only module that reads AI environment variables.
 *
 * ## Free by default, and that is a design constraint rather than a fallback
 *
 * The production build must work with none of these set. So the resolution order
 * below is not "try the good one, degrade to the bad one" — it is three equally
 * supported modes, one of which happens to need no configuration:
 *
 *  1. `GEMINI_API_KEY` present → Gemini (free tier, rate-limited)
 *  2. `OLLAMA_BASE_URL` present → Ollama (local, no key, no network egress)
 *  3. neither → the deterministic planner
 *
 * ## Why Ollama needs an explicit base URL
 *
 * There is a well-known default (`http://127.0.0.1:11434`) and it is deliberately
 * *not* assumed. Assuming it means every request on a machine with nothing
 * listening on that port pays a connection failure before falling back, and the
 * only way to avoid that is to probe — which means a speculative outbound request
 * on a path that is supposed to be free and offline. Requiring the variable makes
 * the choice explicit and costs one line in `.env.local`.
 *
 * Nothing here is exposed to the client. `describeAvailability` returns booleans
 * about *configuration*, never a key, a host or a model id, and that is what the
 * status route serves.
 */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_OLLAMA_MODEL = "qwen3:8b";
export const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com";

/** The label shown for the deterministic planner. Not a model name. */
export const DETERMINISTIC_MODEL_LABEL = "demo-planner-1";

export const AI_TIMEOUT_MS = {
  /** Short: one structured object, a few hundred output tokens. */
  strategy: 45_000,
  /** Longer: a whole itinerary, and local models are slower per token. */
  assembly: 90_000,
  repair: 60_000,
  /**
   * Shorter than assembly: a refinement returns one stop or one day, and a
   * traveller waiting on an edit has less patience than one waiting on a whole
   * trip. Long enough for a local model to finish a small answer.
   */
  refinement: 45_000,
} as const;

export type GeminiConfig = {
  apiKey: string;
  model: string;
  baseUrl: string;
};

export type OllamaConfig = {
  baseUrl: string;
  model: string;
};

export type AiConfig = {
  preference: AiProviderPreference;
  gemini: GeminiConfig | null;
  ollama: OllamaConfig | null;
};

const PREFERENCES: readonly AiProviderPreference[] = [
  "auto",
  "gemini",
  "ollama",
  "deterministic",
];

/**
 * Reads the environment on every call rather than at module load.
 *
 * Module-scope capture would freeze the configuration into the first import,
 * which makes the whole thing untestable without module-registry surgery and
 * behaves surprisingly under Next's dev-time module reloading. The reads are
 * trivial.
 */
export function resolveAiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const raw = env.ROAMLY_AI_PROVIDER?.trim().toLowerCase();
  // An unrecognised value falls back to `auto` rather than throwing. A typo in a
  // deployment variable should not take down a feature that has a working
  // keyless path.
  const preference = PREFERENCES.includes(raw as AiProviderPreference)
    ? (raw as AiProviderPreference)
    : "auto";

  const apiKey = env.GEMINI_API_KEY?.trim();
  const ollamaBaseUrl = env.OLLAMA_BASE_URL?.trim();

  return {
    preference,
    gemini: apiKey
      ? {
          apiKey,
          model: env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
          baseUrl: stripTrailingSlash(
            env.GEMINI_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL,
          ),
        }
      : null,
    ollama: ollamaBaseUrl
      ? {
          baseUrl: stripTrailingSlash(ollamaBaseUrl),
          model: env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL,
        }
      : null,
  };
}

/**
 * Which provider a preference resolves to, or `null` when the demand cannot be met.
 *
 * `null` for an explicit-but-unconfigured demand is the important case: asking for
 * Gemini without a key must report "not configured", not silently produce a demo
 * itinerary labelled as AI output.
 */
export function resolveProviderId(
  config: AiConfig,
  requested?: AiProviderPreference,
): "gemini" | "ollama" | "deterministic" | null {
  const preference = requested ?? config.preference;

  switch (preference) {
    case "deterministic":
      return "deterministic";
    case "gemini":
      return config.gemini ? "gemini" : null;
    case "ollama":
      return config.ollama ? "ollama" : null;
    case "auto":
      if (config.gemini) return "gemini";
      if (config.ollama) return "ollama";
      return "deterministic";
  }
}

/**
 * What the browser is allowed to know: booleans, and a display label.
 *
 * No key, no host, no model id. The UI needs exactly enough to decide whether to
 * offer "Generate with AI" and what to call it.
 */
export type AiAvailability = {
  geminiConfigured: boolean;
  ollamaConfigured: boolean;
  /** What `auto` would pick right now. */
  resolvedProvider: "gemini" | "ollama" | "deterministic";
  /** True when a real model is reachable, so the AI action can be offered. */
  modelAvailable: boolean;
};

export function describeAvailability(config: AiConfig): AiAvailability {
  const resolved = resolveProviderId(config) ?? "deterministic";
  return {
    geminiConfigured: config.gemini !== null,
    ollamaConfigured: config.ollama !== null,
    resolvedProvider: resolved,
    modelAvailable: resolved !== "deterministic",
  };
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
