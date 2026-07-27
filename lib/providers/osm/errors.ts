/**
 * Typed provider failures.
 *
 * Two audiences, deliberately separated. Internally we keep the provider status,
 * the URL shape and the cause so a developer can diagnose. At the route boundary
 * only `userMessage` and an HTTP status cross over — never a stack trace, never a
 * provider hostname, never a raw response body.
 *
 * A provider failure is never converted into a place. If discovery cannot answer,
 * it says so; it does not return something plausible.
 */

export type ProviderErrorKind =
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "invalid_response"
  | "malformed_query"
  | "empty_result"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly provider: "nominatim" | "overpass";
  /** Provider HTTP status, when there was a response. Internal only. */
  readonly status?: number;
  /** Seconds the provider asked us to wait, when it said. */
  readonly retryAfterMs?: number;

  constructor(
    kind: ProviderErrorKind,
    provider: "nominatim" | "overpass",
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.kind = kind;
    this.provider = provider;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * What the browser is allowed to see. Vague on purpose: the caller learns what
   * to do, not what our infrastructure looks like.
   */
  get userMessage(): string {
    switch (this.kind) {
      case "rate_limited":
        return "Place search is busy right now. Please try again in a moment.";
      case "timeout":
        return "Place search took too long. Please try again.";
      case "unavailable":
        return "Place search is temporarily unavailable. Please try again shortly.";
      case "empty_result":
        return "No matching places were found. Try a wider radius or different categories.";
      case "malformed_query":
        return "That search could not be run. Please adjust your input and retry.";
      case "invalid_response":
        return "Place search returned something we could not read. Please try again.";
      case "aborted":
        return "Place search was cancelled.";
      default:
        return "Place search failed unexpectedly. Please try again.";
    }
  }

  get httpStatus(): number {
    switch (this.kind) {
      case "rate_limited":
        return 429;
      case "timeout":
        return 504;
      case "unavailable":
      case "invalid_response":
        return 502;
      case "malformed_query":
        return 400;
      // An empty result is a successful answer, not an error, at the HTTP layer.
      case "empty_result":
        return 200;
      case "aborted":
        return 499;
      default:
        return 500;
    }
  }

  /** Transient failures are worth exactly one retry. Client errors are not. */
  get isRetryable(): boolean {
    return (
      this.kind === "timeout" ||
      this.kind === "unavailable" ||
      this.kind === "rate_limited"
    );
  }
}

export function isProviderError(value: unknown): value is ProviderError {
  return value instanceof ProviderError;
}

/**
 * Maps an unknown thrown value onto a `ProviderError`.
 *
 * `AbortError` is distinguished from a timeout: one is the caller changing their
 * mind, the other is the provider being too slow, and only the latter is worth a
 * retry.
 */
export function toProviderError(
  provider: "nominatim" | "overpass",
  cause: unknown,
): ProviderError {
  if (isProviderError(cause)) return cause;

  if (cause instanceof Error) {
    if (cause.name === "AbortError") {
      return new ProviderError(
        "aborted",
        provider,
        "Request aborted by the caller",
        { cause },
      );
    }
    if (cause.name === "TimeoutError") {
      return new ProviderError("timeout", provider, "Request timed out", {
        cause,
      });
    }
    return new ProviderError("unknown", provider, cause.message, { cause });
  }

  return new ProviderError("unknown", provider, "Unknown provider failure", {
    cause,
  });
}
