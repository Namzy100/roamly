import type { RouteUnavailableReason } from "@/lib/routing";

/**
 * Typed routing failures.
 *
 * Same two-audience discipline as the OSM provider's `ProviderError`: internally
 * we keep the HTTP status, the provider's own error code and the cause so a
 * developer can diagnose; at the route boundary only a vague `userMessage` and
 * an HTTP status cross over.
 *
 * A separate class rather than a shared one, because the two providers fail in
 * genuinely different ways. `no_route` — "we looked, there is no path" — is a
 * *successful* answer here and has no analogue in place discovery, and
 * `unsupported_mode` is a refusal we make before any request exists.
 */

export type RoutingErrorKind = RouteUnavailableReason;

export class RoutingProviderError extends Error {
  readonly kind: RoutingErrorKind;
  readonly provider = "valhalla" as const;
  /** Provider HTTP status, when there was a response. Internal only. */
  readonly status?: number;
  /** Valhalla's own `error_code`. Internal only — never returned to a client. */
  readonly providerCode?: number;
  /** Milliseconds the provider asked us to wait, when it said. */
  readonly retryAfterMs?: number;

  constructor(
    kind: RoutingErrorKind,
    message: string,
    options: {
      status?: number;
      providerCode?: number;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "RoutingProviderError";
    this.kind = kind;
    this.status = options.status;
    this.providerCode = options.providerCode;
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * What the browser is allowed to see.
   *
   * Vague about our infrastructure, specific about what the traveller can do.
   * Note that none of these imply a route exists, and none mention traffic.
   */
  get userMessage(): string {
    return routingUserMessage(this.kind);
  }

  get httpStatus(): number {
    switch (this.kind) {
      case "rate_limited":
        return 429;
      case "timeout":
        return 504;
      case "provider_unavailable":
      case "invalid_response":
        return 502;
      case "invalid_locations":
      case "unsupported_mode":
        return 400;
      // "There is no path between these two points" is a correct answer to a
      // well-formed question, not a server error.
      case "no_route":
        return 200;
      case "aborted":
        return 499;
      default:
        return 500;
    }
  }

  /**
   * Transient failures are worth exactly one retry.
   *
   * `no_route` is emphatically not retryable: the answer will be identical, and
   * re-asking a volunteer-run service the same unanswerable question is the
   * definition of abuse. Neither is `invalid_locations` — our input will not
   * improve on its own.
   */
  get isRetryable(): boolean {
    return (
      this.kind === "timeout" ||
      this.kind === "provider_unavailable" ||
      this.kind === "rate_limited"
    );
  }
}

export function isRoutingProviderError(
  value: unknown,
): value is RoutingProviderError {
  return value instanceof RoutingProviderError;
}

/**
 * The single source of user-facing wording for every failure reason.
 *
 * Lives outside the class so an `UnavailableRouteSegment` built without an
 * exception — a normalisation rejection, say — carries the same sentence as one
 * built from a thrown error.
 */
export function routingUserMessage(reason: RouteUnavailableReason): string {
  switch (reason) {
    case "no_route":
      return "No route could be found between these two places.";
    case "provider_unavailable":
      return "Routing is temporarily unavailable. Please try again shortly.";
    case "timeout":
      return "Routing took too long. Please try again.";
    case "rate_limited":
      return "Routing is busy right now. Please try again in a moment.";
    case "invalid_locations":
      return "Those locations could not be routed between.";
    case "unsupported_mode":
      return "That travel mode is not supported.";
    case "invalid_response":
      return "Routing returned something we could not read. Please try again.";
    case "aborted":
      return "Routing was cancelled.";
    default:
      return "Routing failed unexpectedly. Please try again.";
  }
}

/**
 * Maps an unknown thrown value onto a `RoutingProviderError`.
 *
 * `AbortError` is distinguished from a timeout: one is the caller changing their
 * mind, the other is the provider being too slow, and only the latter is worth a
 * retry.
 */
export function toRoutingError(cause: unknown): RoutingProviderError {
  if (isRoutingProviderError(cause)) return cause;

  if (cause instanceof Error) {
    if (cause.name === "AbortError") {
      return new RoutingProviderError("aborted", "Request aborted by the caller", {
        cause,
      });
    }
    if (cause.name === "TimeoutError") {
      return new RoutingProviderError("timeout", "Request timed out", { cause });
    }
    return new RoutingProviderError("unknown", cause.message, { cause });
  }

  return new RoutingProviderError("unknown", "Unknown routing failure", { cause });
}
