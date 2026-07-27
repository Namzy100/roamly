import type {
  AiUnavailableReason,
  StructuredGenerationResult,
} from "./types";

/**
 * The two audiences, kept apart.
 *
 * Internally an adapter knows the HTTP status, the provider host and the body it
 * could not parse. None of that crosses the boundary. What crosses is a reason
 * code the pipeline can branch on and a sentence a traveller can read — no
 * provider name, no status code, no stack trace, no prompt fragment.
 *
 * The messages are deliberately about *what to do next* rather than *what broke*,
 * for the same reason `lib/providers/osm/errors.ts` is vague: a user cannot act
 * on "429 from generativelanguage.googleapis.com", and telling them our
 * infrastructure shape helps nobody.
 */

const UNAVAILABLE_MESSAGES: Record<AiUnavailableReason, string> = {
  not_configured:
    "No AI planner is configured, so this trip cannot be generated with a model. You can still build it with the demo planner.",
  rate_limited:
    "The AI planner is rate limited right now. Free tiers have hourly and daily caps — wait a moment and try again, or use the demo planner.",
  timeout:
    "The AI planner took too long to answer, so nothing was saved. Please try again.",
  provider_unavailable:
    "The AI planner is temporarily unreachable, so nothing was saved. Please try again shortly.",
  invalid_response:
    "The AI planner returned something we could not verify, so nothing was saved. Please try again.",
  empty_response:
    "The AI planner returned an empty answer, so nothing was saved. Please try again.",
  aborted: "Trip generation was cancelled, so nothing was saved.",
  unknown:
    "Trip generation failed unexpectedly, so nothing was saved. Please try again.",
};

export function unavailable<T>(
  reason: AiUnavailableReason,
): Extract<StructuredGenerationResult<T>, { status: "unavailable" }> {
  return {
    status: "unavailable",
    reason,
    userMessage: UNAVAILABLE_MESSAGES[reason],
  };
}

/**
 * A safety refusal.
 *
 * Separate from `unavailable` because it is not a failure of ours and is not
 * worth retrying: the same prompt will be refused again. The default message
 * says so without speculating about which part of the request was the problem,
 * since the providers do not reliably tell us.
 */
export function refused<T>(
  userMessage = "The AI planner declined to plan this trip. Try rephrasing your notes, or build it with the demo planner.",
): Extract<StructuredGenerationResult<T>, { status: "refused" }> {
  return { status: "refused", userMessage };
}

/**
 * Maps a thrown value onto a reason code.
 *
 * `AbortError` is kept distinct from a timeout — one is the traveller changing
 * their mind and the other is the provider being slow, and only the second is
 * worth mentioning as a fault. A `TypeError` from `fetch` means the host could
 * not be reached at all, which for a local Ollama is the overwhelmingly common
 * case and deserves `provider_unavailable` rather than `unknown`.
 */
export function reasonFromThrown(cause: unknown): AiUnavailableReason {
  if (cause instanceof Error) {
    if (cause.name === "AbortError") return "aborted";
    if (cause.name === "TimeoutError") return "timeout";
    if (cause.name === "TypeError") return "provider_unavailable";
  }
  return "unknown";
}

/**
 * Reason codes mapped to HTTP statuses for the generation route.
 *
 * `not_configured` is a 200 outcome carried in the response body rather than a
 * 4xx: the request was perfectly valid and the honest answer is "there is no
 * planner, here is the alternative". The route decides; this is the table.
 */
export function httpStatusForReason(reason: AiUnavailableReason): number {
  switch (reason) {
    case "rate_limited":
      return 429;
    case "timeout":
      return 504;
    case "provider_unavailable":
    case "invalid_response":
    case "empty_response":
      return 502;
    case "aborted":
      return 499;
    case "not_configured":
      return 200;
    default:
      return 500;
  }
}
