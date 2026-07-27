import "server-only";

/**
 * Structured server logging, with no travel data in it.
 *
 * ## What is logged, and why so little
 *
 * A request id, an operation name, a provider category, a result category, a duration, a cache flag, a
 * retry count. Enough to answer "is Overpass slow today", "how often does discovery come back partial",
 * "did that timeout come from us or from them".
 *
 * Nothing about the trip. Not the destination, not a place name, not an itinerary, not a note the
 * traveller typed, not a prompt, not a model's output, not a provider's raw payload. That is not
 * squeamishness: server logs on a hosting platform are readable by anyone with project access and are
 * retained beyond the request, and travel plans are personal. A destination plus dates is enough to
 * know when someone's house is empty.
 *
 * Place ids are also omitted. They are not personal on their own, but a full set of them *is* an
 * itinerary, and "just the ids" is how a log becomes one by accident.
 *
 * ## One line, machine-readable
 *
 * A single JSON object per line, so Vercel's log viewer can filter on it and a human can still read it.
 * No log-shipping SDK, no analytics: `console.log` is the interface a serverless platform already
 * collects.
 */

export type ProviderCategory = "geocode" | "places" | "routing" | "model";

export type ResultCategory =
  | "ok"
  | "partial"
  | "empty"
  | "refused"
  | "timeout"
  | "rate_limited"
  | "unavailable"
  | "invalid"
  | "aborted";

export type OperationLog = {
  operation: string;
  provider?: ProviderCategory;
  result: ResultCategory;
  durationMs: number;
  /** The client's own request id. Not derived from anything about the traveller. */
  requestId?: string;
  cacheHit?: boolean;
  retries?: number;
  /** True when a result is real but thinner than asked for. */
  partial?: boolean;
  /** Our own error code, never a provider's message. */
  errorCode?: string;
};

/**
 * A hard allowlist, applied on the way out.
 *
 * The alternative — remembering not to pass the wrong thing — fails the first time someone adds a
 * field in a hurry. Anything not named here is dropped rather than logged, so a future caller who
 * passes `{ destination }` gets a log line without it instead of a leak.
 */
const ALLOWED_FIELDS = new Set<keyof OperationLog>([
  "operation",
  "provider",
  "result",
  "durationMs",
  "requestId",
  "cacheHit",
  "retries",
  "partial",
  "errorCode",
]);

export function logOperation(entry: OperationLog): void {
  const safe: Record<string, unknown> = { at: new Date().toISOString() };

  for (const [key, value] of Object.entries(entry)) {
    if (!ALLOWED_FIELDS.has(key as keyof OperationLog)) continue;
    if (value === undefined) continue;
    safe[key] = value;
  }

  // Rounded: sub-millisecond precision is noise, and a distinctive duration is a weak fingerprint.
  if (typeof safe.durationMs === "number") {
    safe.durationMs = Math.round(safe.durationMs);
  }

  console.log(JSON.stringify(safe));
}

/** Times an operation and logs it once, whichever way it ends. */
export async function timed<T>(
  descriptor: Omit<OperationLog, "result" | "durationMs">,
  run: () => Promise<{ value: T; result: ResultCategory; partial?: boolean }>,
): Promise<T> {
  const started = Date.now();

  try {
    const outcome = await run();
    logOperation({
      ...descriptor,
      result: outcome.result,
      durationMs: Date.now() - started,
      ...(outcome.partial === undefined ? {} : { partial: outcome.partial }),
    });
    return outcome.value;
  } catch (error) {
    logOperation({
      ...descriptor,
      result:
        error instanceof Error && error.name === "AbortError" ? "aborted" : "unavailable",
      durationMs: Date.now() - started,
      // A class name, not a message: a provider's message can name a host.
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
}
