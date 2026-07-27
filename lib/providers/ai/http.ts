import "server-only";

import type { AiUnavailableReason } from "@/lib/ai";
import { reasonFromThrown } from "@/lib/ai";

/**
 * The one outbound HTTP path for AI providers.
 *
 * ## Why it returns instead of throwing
 *
 * Every failure here has to become a `StructuredGenerationResult` arm anyway, and
 * a thrown error would have to be caught and re-classified in both adapters —
 * which is how the two would eventually disagree about what a 429 means. So the
 * classification happens once, here, and the adapters read a tagged result.
 *
 * ## No retry
 *
 * Deliberate. The pipeline already allows one repair per stage, and a transient
 * retry underneath that would multiply: two HTTP attempts × two pipeline passes is
 * four model calls for one generation, against providers whose free tiers are
 * rate-limited per minute. A 429 that is retried immediately also tends to become a
 * second 429. The honest response is to report it and let the traveller decide.
 *
 * ## The HTML case
 *
 * A proxy, a captive portal or a misconfigured base URL answers with HTML and a
 * 200. Sniffing for it is what turns "the JSON parser failed" into "the provider is
 * unreachable", which is both true and actionable — the same lesson
 * `lib/providers/osm/http.ts` learned from Overpass's busy page.
 */

export type ProviderHttpResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: AiUnavailableReason; detail: string };

export type ProviderHttpRequest = {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
};

export async function postProviderJson(
  request: ProviderHttpRequest,
): Promise<ProviderHttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Provider timed out", "TimeoutError"));
  }, request.timeoutMs);

  const onCallerAbort = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...request.headers,
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
      cache: "no-store",
      redirect: "follow",
    });

    const text = await response.text();

    if (!response.ok) {
      return {
        ok: false,
        reason: classifyStatus(response.status),
        // Truncated and logged server-side only. A provider body can contain the
        // echoed prompt, and none of it may reach the browser.
        detail: `status ${response.status}: ${text.slice(0, 400)}`,
      };
    }

    if (text.trim().length === 0) {
      return { ok: false, reason: "empty_response", detail: "empty body" };
    }

    if (text.trimStart().startsWith("<")) {
      return {
        ok: false,
        reason: "provider_unavailable",
        detail: "provider returned HTML instead of JSON",
      };
    }

    try {
      return { ok: true, json: JSON.parse(text) };
    } catch {
      return {
        ok: false,
        reason: "invalid_response",
        detail: `envelope was not valid JSON: ${text.slice(0, 200)}`,
      };
    }
  } catch (cause) {
    // An abort we raised for a timeout must surface as a timeout, not as the
    // traveller cancelling.
    if (
      controller.signal.aborted &&
      !request.signal?.aborted &&
      controller.signal.reason instanceof DOMException &&
      controller.signal.reason.name === "TimeoutError"
    ) {
      return { ok: false, reason: "timeout", detail: "provider timed out" };
    }
    if (request.signal?.aborted) {
      return { ok: false, reason: "aborted", detail: "cancelled by the caller" };
    }
    return {
      ok: false,
      reason: reasonFromThrown(cause),
      detail: cause instanceof Error ? cause.message : "unknown transport failure",
    };
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onCallerAbort);
  }
}

function classifyStatus(status: number): AiUnavailableReason {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "not_configured";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "provider_unavailable";
  // 400 from a model API is almost always our request — a schema the provider
  // rejects, or a context overflow. Not the traveller's problem to retry.
  return "invalid_response";
}
