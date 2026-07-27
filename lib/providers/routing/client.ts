import "server-only";

import { createRateLimiter, type RateLimiter } from "@/lib/providers/osm/rate-limit";

import {
  ROUTING_CLIENT_ID,
  ROUTING_LIMITS,
  ROUTING_RETRY,
  ROUTING_USER_AGENT,
  VALHALLA_BASE_URL,
} from "./config";
import {
  RoutingProviderError,
  toRoutingError,
} from "./errors";
import { ValhallaErrorResponseSchema } from "./valhalla/schemas";
import {
  INVALID_INPUT_ERROR_CODES,
  NO_ROUTE_ERROR_CODES,
} from "./valhalla/schemas";

/**
 * The single outbound HTTP path to the routing provider.
 *
 * Responsibilities, in order: pace through the limiter, apply a hard timeout,
 * classify the outcome, and retry **at most once** for transient failures. Same
 * shape as the OSM client, and for the same reasons — but a separate module,
 * because the classification rules genuinely differ.
 *
 * ## Why HTTP 400 is not simply an error
 *
 * Valhalla answers "there is no path between these points" with **HTTP 400** and
 * `error_code: 170`, and "your locations are nonsense" with HTTP 400 too. The
 * first is a correct answer to a well-formed question and must become an
 * `unavailable` segment with reason `no_route`; the second is our bug. Only the
 * body distinguishes them, so the body is always parsed before the status is
 * acted on.
 *
 * ## Why HTTP 200 is not enough either
 *
 * A busy or misconfigured instance can answer with an HTML error page, an empty
 * body, or a well-formed JSON trip whose `status` is non-zero. A client that
 * trusts the status code reads all three as success. Each is classified here.
 */

/**
 * Shared, module-scoped: one limiter per process, not per call.
 *
 * Reuses the OSM adapter's promise-chain limiter rather than reimplementing it.
 * Two concurrent callers checking a clock would both see enough time elapsed and
 * both fire; chaining makes them queue by construction.
 */
const limiter: RateLimiter = createRateLimiter(ROUTING_LIMITS.minIntervalMs);

export function routingLimiterState() {
  return limiter.state();
}

export type PostJsonOptions = {
  /** Path relative to the configured base URL. Never a full URL from a caller. */
  path: string;
  body: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export async function postRoutingJson(
  options: PostJsonOptions,
): Promise<unknown> {
  let lastError: RoutingProviderError | null = null;

  for (let attempt = 1; attempt <= ROUTING_RETRY.maxAttempts; attempt += 1) {
    try {
      return await attemptPost(options);
    } catch (raw) {
      const error = toRoutingError(raw);

      // A caller cancelling, a bad request, or a genuine no-route will not
      // improve on a second attempt — and re-asking a volunteer-run service an
      // unanswerable question is exactly the abuse the limiter exists to stop.
      if (!error.isRetryable || attempt === ROUTING_RETRY.maxAttempts) {
        throw error;
      }

      lastError = error;
      await backoff(attempt, error.retryAfterMs, options.signal);
    }
  }

  throw lastError ?? new RoutingProviderError("unknown", "Request failed");
}

async function attemptPost(options: PostJsonOptions): Promise<unknown> {
  const { path, body, signal } = options;
  const timeoutMs = options.timeoutMs ?? ROUTING_LIMITS.requestTimeoutMs;

  // Pace first. Waiting for our slot must not count against the request timeout,
  // or a queued request would time out before it was ever sent.
  await limiter.acquire(signal);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new RoutingProviderError("timeout", "Request timed out")),
    timeoutMs,
  );
  const onCallerAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    const response = await fetch(`${VALHALLA_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Identifies this project to the demo server's operator, as fair use of
        // shared infrastructure requires. Nothing personal is included.
        "X-Client-Id": ROUTING_CLIENT_ID,
        "User-Agent": ROUTING_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      // A public, cacheable read; we do our own caching.
      cache: "no-store",
      redirect: "follow",
    });

    const text = await response.text();

    if (!response.ok) {
      throw classifyFailure(response, text);
    }

    return parseJsonBody(text);
  } catch (raw) {
    // An abort we triggered for timeout should surface as a timeout, not an abort.
    if (raw instanceof RoutingProviderError) throw raw;
    if (
      controller.signal.aborted &&
      controller.signal.reason instanceof RoutingProviderError
    ) {
      throw controller.signal.reason;
    }
    throw toRoutingError(raw);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

/**
 * Classifies a non-2xx response, reading the body before trusting the status.
 *
 * The `error_code` in a 400 body is the only thing that separates "no route
 * exists" from "your request was malformed", and the two must not be conflated:
 * one is a cacheable answer, the other is a bug.
 */
function classifyFailure(response: Response, text: string): RoutingProviderError {
  const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));

  if (response.status === 429) {
    return new RoutingProviderError("rate_limited", "Provider rate limited us", {
      status: 429,
      retryAfterMs,
    });
  }

  const providerError = readProviderError(text);

  if (providerError) {
    if (NO_ROUTE_ERROR_CODES.has(providerError.error_code)) {
      return new RoutingProviderError("no_route", providerError.error, {
        status: response.status,
        providerCode: providerError.error_code,
      });
    }
    if (INVALID_INPUT_ERROR_CODES.has(providerError.error_code)) {
      return new RoutingProviderError("invalid_locations", providerError.error, {
        status: response.status,
        providerCode: providerError.error_code,
      });
    }
  }

  if (response.status >= 500) {
    return new RoutingProviderError(
      response.status === 504 ? "timeout" : "provider_unavailable",
      `Provider responded ${response.status}`,
      { status: response.status, retryAfterMs },
    );
  }

  if (response.status === 400) {
    // A 400 whose body we could not read as a Valhalla error is our problem to
    // fix, not something to retry.
    return new RoutingProviderError(
      "invalid_locations",
      providerError?.error ?? "Provider rejected the request",
      { status: 400, providerCode: providerError?.error_code },
    );
  }

  return new RoutingProviderError(
    "unknown",
    `Provider responded ${response.status}`,
    { status: response.status, providerCode: providerError?.error_code },
  );
}

function readProviderError(
  text: string,
): { error_code: number; error: string } | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{")) return null;

  try {
    const parsed = ValhallaErrorResponseSchema.safeParse(JSON.parse(text));
    return parsed.success
      ? { error_code: parsed.data.error_code, error: parsed.data.error }
      : null;
  } catch {
    return null;
  }
}

/**
 * Parses a 200 body, distinguishing "transiently unavailable" from "unreadable".
 *
 * The distinction matters because only the former is retried.
 */
function parseJsonBody(text: string): unknown {
  const trimmed = text.trimStart();

  if (trimmed.length === 0) {
    // An empty 200 is a proxy or a service under load truncating, not a route.
    throw new RoutingProviderError(
      "provider_unavailable",
      "Provider returned an empty body with HTTP 200",
    );
  }

  // A busy or fronted instance answers with an HTML error page under HTTP 200.
  // Treated as transient: the same request usually succeeds moments later.
  if (trimmed.startsWith("<")) {
    const isBusy = /too busy|timeout|rate.?limit|502|503|504|gateway/i.test(text);
    throw new RoutingProviderError(
      isBusy ? "provider_unavailable" : "invalid_response",
      isBusy
        ? "Provider returned a busy page instead of JSON"
        : "Provider returned HTML instead of JSON",
    );
  }

  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new RoutingProviderError(
      "invalid_response",
      "Provider response was not valid JSON",
      { cause },
    );
  }
}

/** `Retry-After` may be seconds or an HTTP date. Capped so it cannot hang us. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, ROUTING_RETRY.maxRetryAfterMs);
  }

  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - Date.now()), ROUTING_RETRY.maxRetryAfterMs);
  }
  return undefined;
}

/**
 * Fixed short backoff with jitter, or the provider's own `Retry-After`.
 *
 * Jitter matters even in a single process: a batch of legs that fails together
 * would otherwise retry in lockstep, turning one bad moment into a thundering
 * herd against a demo server.
 */
async function backoff(
  attempt: number,
  retryAfterMs: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const base = retryAfterMs ?? ROUTING_RETRY.baseDelayMs * attempt;
  const jitter = Math.floor(Math.random() * ROUTING_RETRY.maxJitterMs);

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
