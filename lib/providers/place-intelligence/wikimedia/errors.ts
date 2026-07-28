/**
 * Typed Wikimedia failures.
 *
 * ## Why not reuse `lib/providers/osm/errors.ts`
 *
 * `ProviderError` hard-codes `provider: "nominatim" | "overpass"` and every `userMessage` string it returns says
 * "Place search". Widening that union would give every OSM call site a case it cannot reach and would put
 * enrichment wording into the discovery error surface. The shape is copied deliberately instead — same
 * two-audience split, same "never leak a payload" rule — because the shape is right and the vocabulary is not
 * shared.
 *
 * ## Two audiences, and the second one is *silence*
 *
 * OSM discovery failing is something a traveller must be told about: they asked for places and got none.
 * Wikimedia enrichment failing is not. An absent photograph and an absent founding date are indistinguishable
 * from a place that simply has neither, so there is nothing useful to say and no reason to spend a traveller's
 * attention on it. That is why there is no `userMessage` here: a failure is logged, the place is reported
 * `failed` to the orchestrator, and the interface renders what it renders for a place with no enrichment —
 * nothing.
 *
 * ## What must never be on one of these
 *
 * No response body, no fragment of one, no full request URL. `endpoint` is a category, not an address. These
 * messages are read by a developer in a log line, and `lib/providers/log.ts` only ever emits `errorCode`, so a
 * message that named a host would be a leak waiting for the first person to widen the allowlist.
 */

/**
 * Which of the five researched endpoints failed.
 *
 * A closed category rather than a URL, for the reason above, and one arm per row of the endpoint table in
 * `docs/PROVIDER_RESEARCH.md` — so a log showing `wikidata-sparql` timing out while `commons-api` is healthy
 * reads immediately as "WDQS is loaded again" rather than "Wikimedia is down".
 */
export type WikimediaEndpoint =
  | "wikidata-entity"
  | "wikidata-api"
  | "wikidata-sparql"
  | "wikipedia-api"
  | "commons-api";

export type WikimediaErrorKind =
  /**
   * Roamly's own configuration is wrong, so no request was made.
   *
   * The one kind that is *our* fault, and it exists because of the hardest requirement in the research: a
   * Wikimedia request without a descriptive `User-Agent` receives HTTP 403, and the client may be blocked
   * without notice. Refusing locally turns "we got mysteriously blocked in production" into "this deployment is
   * misconfigured", which is the same information a day earlier.
   */
  | "misconfigured"
  /** 403. Either the `User-Agent` was rejected upstream or we have been blocked. Never retried. */
  | "forbidden"
  /** 429. Carries `retryAfterMs` when Wikimedia said one. Never retried — see `retryable`. */
  | "rate_limited"
  | "timeout"
  /** A transient 5xx, or a 200 body that says "busy". The only kind worth a second attempt. */
  | "unavailable"
  /** HTML where JSON belonged, unparseable JSON, or a payload that failed its schema. */
  | "invalid_response"
  /** The body exceeded `maxResponseBytes` and was abandoned part-read. */
  | "response_too_large"
  /** A redirect pointing somewhere the allowlist does not permit. */
  | "unsafe_redirect"
  /** 404, or a documented "missing" marker inside a 200. A real answer rather than a failure of ours. */
  | "not_found"
  | "aborted"
  | "unknown";

export class WikimediaError extends Error {
  readonly kind: WikimediaErrorKind;
  readonly endpoint: WikimediaEndpoint;
  /** Upstream HTTP status, when there was a response. Internal only, never rendered. */
  readonly status?: number;
  /** What Wikimedia asked us to wait, when it said. Bounded by the caller that parses it. */
  readonly retryAfterMs?: number;

  constructor(
    kind: WikimediaErrorKind,
    endpoint: WikimediaEndpoint,
    message: string,
    options: { status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "WikimediaError";
    this.kind = kind;
    this.endpoint = endpoint;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * Whether a second attempt is justified. **Transient 5xx only.**
   *
   * Narrower than the OSM client's rule, and narrower than Wikimedia's own etiquette page, which asks clients to
   * "back off exponentially and honour `Retry-After`" on 429. Both narrowings are deliberate:
   *
   *  - **429 is not retried.** Wikimedia publishes no numeric read limit, so a 429 is the only concrete signal
   *    that Roamly is asking for too much — and the right response to that signal is to stop, not to wait and
   *    ask again. `retryAfterMs` is still carried, and the orchestrator uses it to abandon the *rest* of the
   *    trip's enrichment rather than to schedule a retry. Honouring `Retry-After` by asking less is honouring it.
   *  - **A timeout is not retried.** A slow answer from a volunteer service means the service is under load, and
   *    a second request is more load. Enrichment is optional, so the cheap answer is to go without.
   *
   * A missing photograph is a cost Roamly can absorb. Being blocked is not.
   */
  get retryable(): boolean {
    return this.kind === "unavailable";
  }

  /**
   * Whether the whole enrichment run should stop, not just this place.
   *
   * `misconfigured` and `forbidden` are properties of the *deployment*, so the next eleven places would fail
   * identically — issuing those requests would be eleven requests to learn one thing. `rate_limited` is
   * Wikimedia telling us to ask less, which is about the run rather than about the place.
   *
   * Everything else is about one place: a malformed payload for one entity says nothing about the next.
   */
  get abandonsRun(): boolean {
    return (
      this.kind === "misconfigured" ||
      this.kind === "forbidden" ||
      this.kind === "rate_limited"
    );
  }

  /** The `errorCode` for `logOperation`. A kind, never a message — messages can name a host. */
  get logCode(): string {
    return `wikimedia_${this.kind}`;
  }
}

export function isWikimediaError(value: unknown): value is WikimediaError {
  return value instanceof WikimediaError;
}

/**
 * Maps an unknown thrown value onto a `WikimediaError`.
 *
 * `AbortError` stays distinct from `timeout` for the reason the OSM client separates them: one is the caller
 * changing their mind — a traveller navigating away mid-enrichment, which is the common case for optional work —
 * and the other is Wikimedia being slow. Only the second is worth a log line anybody should act on.
 *
 * An unknown `Error`'s message is kept because at this point it is a transport failure ("getaddrinfo ENOTFOUND")
 * rather than a provider payload. Nothing that has read a response body reaches here.
 */
export function toWikimediaError(
  endpoint: WikimediaEndpoint,
  cause: unknown,
): WikimediaError {
  if (isWikimediaError(cause)) return cause;

  if (cause instanceof Error) {
    if (cause.name === "AbortError") {
      return new WikimediaError("aborted", endpoint, "Request aborted", {
        cause,
      });
    }
    if (cause.name === "TimeoutError") {
      return new WikimediaError("timeout", endpoint, "Request timed out", {
        cause,
      });
    }
    return new WikimediaError("unknown", endpoint, cause.message, { cause });
  }

  return new WikimediaError("unknown", endpoint, "Unknown failure", { cause });
}
