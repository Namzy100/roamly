import {
  PROVIDER_LABELS,
  type AiStatusResponse,
} from "@/lib/api/generate-contract";
import { describeAvailability, resolveAiConfig } from "@/lib/providers/ai";

/**
 * `GET /api/ai/status` — whether an AI planner can be offered at all.
 *
 * ## Why the browser needs to ask
 *
 * The interface must not offer "Generate with AI" on a deployment where no model is
 * configured. Offering it and then failing is a worse experience than not offering
 * it, and pre-rendering the answer into the page is not possible: the trip builder is
 * a client component and configuration is a server-side fact.
 *
 * ## What it does not reveal
 *
 * Booleans and one display label. No key, no host, no model id, no environment
 * variable value, no fragment of one. "Gemini is configured" is not a secret — it is
 * the same thing the enabled button already tells the visitor — while
 * `gemini-2.5-flash` and a base URL are deployment details with no business in a
 * browser.
 *
 * Nothing here contacts a provider. The answer is a function of configuration alone,
 * so it is instant, cannot fail, and cannot be used to probe whether someone's local
 * Ollama is running.
 */

export async function GET(): Promise<Response> {
  const availability = describeAvailability(resolveAiConfig());

  const body: AiStatusResponse = {
    ...availability,
    providerLabel:
      PROVIDER_LABELS[availability.resolvedProvider] ?? "Demo Planner",
  };

  return Response.json(body, {
    status: 200,
    // Configuration is per-deployment, but a cached "no model" would survive an
    // operator adding a key. Cheap to compute, so never cache it.
    headers: { "Cache-Control": "no-store" },
  });
}
