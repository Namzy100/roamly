import "server-only";

import { RETRY, USER_AGENT } from "./config";
import { ProviderError, toProviderError } from "./errors";
import type { RateLimiter } from "./rate-limit";

/**
 * The single outbound HTTP path for both providers.
 *
 * Responsibilities, in order: pace through the limiter, apply a hard timeout,
 * classify the outcome, and retry **at most once** for transient failures.
 *
 * ## Why 200 is not enough
 *
 * Overpass answers "server too busy" with **HTTP 200 and an HTML body** — verified
 * live while building this. A naive client sees a success, fails to parse, and
 * reports a permanent `invalid_response` for what is really a transient overload.
 * So the body is sniffed: an HTML payload, or a JSON `remark` mentioning a timeout,
 * is classified `unavailable` and becomes retryable.
 */

export type FetchJsonOptions = {
  provider: "nominatim" | "overpass";
  url: string;
  limiter: RateLimiter;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Present for POST form submissions (Overpass). */
  body?: URLSearchParams;
};

export async function fetchProviderJson(
  options: FetchJsonOptions,
): Promise<unknown> {
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= RETRY.maxAttempts; attempt += 1) {
    try {
      return await attemptFetch(options);
    } catch (raw) {
      const error = toProviderError(options.provider, raw);

      // A caller cancelling, a malformed query, or an unreadable-but-stable
      // response will not improve on a second attempt.
      if (!error.isRetryable || attempt === RETRY.maxAttempts) {
        throw error;
      }

      lastError = error;
      await backoff(attempt, error.retryAfterMs, options.signal);
    }
  }

  throw lastError ?? new ProviderError("unknown", options.provider, "Request failed");
}

async function attemptFetch(options: FetchJsonOptions): Promise<unknown> {
  const { provider, url, limiter, timeoutMs, signal, body } = options;

  // Pace first. Waiting for our slot must not count against the request timeout,
  // or a queued request would time out before it was ever sent.
  await limiter.acquire(signal);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new ProviderError("timeout", provider, "Request timed out")),
    timeoutMs,
  );
  const onCallerAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: {
        // Nominatim's policy requires a genuine identifying User-Agent.
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body,
      signal: controller.signal,
      // These are public, cacheable reads; we do our own caching.
      cache: "no-store",
      redirect: "follow",
    });

    if (!response.ok) {
      throw classifyStatus(provider, response);
    }

    const text = await response.text();
    return parseJsonBody(provider, text);
  } catch (raw) {
    // An abort we triggered for timeout should surface as a timeout, not an abort.
    if (raw instanceof ProviderError) throw raw;
    if (controller.signal.aborted && controller.signal.reason instanceof ProviderError) {
      throw controller.signal.reason;
    }
    throw toProviderError(provider, raw);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

function classifyStatus(
  provider: "nominatim" | "overpass",
  response: Response,
): ProviderError {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 429) {
    return new ProviderError("rate_limited", provider, "Provider rate limited us", {
      status: 429,
      retryAfterMs,
    });
  }
  // Overpass uses 504 for its own query timeout and 429 for slot exhaustion.
  if (response.status >= 500) {
    return new ProviderError(
      response.status === 504 ? "timeout" : "unavailable",
      provider,
      `Provider responded ${response.status}`,
      { status: response.status, retryAfterMs },
    );
  }
  if (response.status === 400) {
    return new ProviderError("malformed_query", provider, "Provider rejected the query", {
      status: 400,
    });
  }
  return new ProviderError("unknown", provider, `Provider responded ${response.status}`, {
    status: response.status,
  });
}

/**
 * Parses a 200 body, distinguishing "transiently unavailable" from "unreadable".
 *
 * The distinction matters because only the former is retried.
 */
function parseJsonBody(
  provider: "nominatim" | "overpass",
  text: string,
): unknown {
  const trimmed = text.trimStart();

  // Overpass's busy/error page. Verified live: HTTP 200, HTML body.
  if (trimmed.startsWith("<")) {
    const isBusy = /too busy|timeout|rate.?limit/i.test(text);
    throw new ProviderError(
      isBusy ? "unavailable" : "invalid_response",
      provider,
      isBusy
        ? "Provider returned a busy page instead of JSON"
        : "Provider returned HTML instead of JSON",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new ProviderError(
      "invalid_response",
      provider,
      "Provider response was not valid JSON",
      { cause },
    );
  }

  // Overpass can also report an overload inside a well-formed JSON body.
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "remark" in parsed &&
    typeof (parsed as { remark?: unknown }).remark === "string"
  ) {
    const remark = (parsed as { remark: string }).remark;
    if (/timed out|too busy|out of memory/i.test(remark)) {
      throw new ProviderError("unavailable", provider, `Provider remark: ${remark}`);
    }
  }

  return parsed;
}

/** `Retry-After` may be seconds or an HTTP date. Capped so it cannot hang us. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, RETRY.maxRetryAfterMs);
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), RETRY.maxRetryAfterMs);
  }
  return undefined;
}

/**
 * Fixed short backoff with jitter, or the provider's own `Retry-After` when given.
 *
 * Jitter matters even in a single process: without it, several queued requests
 * that fail together would retry in lockstep.
 */
async function backoff(
  attempt: number,
  retryAfterMs: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const base = retryAfterMs ?? RETRY.baseDelayMs * attempt;
  const jitter = Math.floor(Math.random() * RETRY.maxJitterMs);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, base + jitter);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
