import "server-only";

/**
 * The AI provider layer's public surface. Server-only, like every other provider
 * directory: an adapter reads environment variables and holds a key, and neither
 * belongs in a browser bundle.
 *
 * Nothing outside this directory names Gemini or Ollama. The pipeline asks
 * `createStructuredGenerator` for something that satisfies `StructuredGenerator`
 * and does not learn what it got beyond the provenance label it prints.
 */

export {
  AI_TIMEOUT_MS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OLLAMA_MODEL,
  DETERMINISTIC_MODEL_LABEL,
  describeAvailability,
  resolveAiConfig,
  resolveProviderId,
  type AiAvailability,
  type AiConfig,
  type GeminiConfig,
  type OllamaConfig,
} from "./config";

export {
  createStructuredGenerator,
  type ProviderSelection,
} from "./create-provider";

export { createDeterministicGenerator } from "./deterministic/generate";
export { createGeminiGenerator } from "./gemini/generate";
export { createOllamaGenerator } from "./ollama/generate";
