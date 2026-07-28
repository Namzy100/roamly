import type { TripPlace } from "@/lib/schemas";

import {
  EnrichTripPlacesResponseSchema,
  type EnrichOutcome,
  type EnrichTripPlacesRequest,
} from "./place-intelligence-contract";

/**
 * The bounded client workflow: ask, and if the server ran out of time, ask again for the rest.
 *
 * ## Why this is a plain function and not the hook
 *
 * Every rule below is a rule about *control flow* — how many calls, which places go in the next one, what an abort
 * stops, when a result may be written. None of them is about React, and all of them are the kind of rule that goes wrong
 * quietly. So the transport is a parameter: `post` does the fetching, this decides what to post and when to stop, and a
 * test can drive every branch without a component or a network.
 *
 * `use-trip-intelligence.ts` is the thin wrapper that supplies `fetch` and does the saving.
 *
 * ## Nothing is persisted here
 *
 * The function returns results and writes nothing. That is the sequencing the checkpoint asks for: partial results may be
 * persisted only after the whole bounded workflow has finished and every response has been validated. A controller that
 * saved after each call would leave a trip half-enriched if the second call failed — and worse, would make the *number of
 * server calls* visible in the traveller's undo history.
 *
 * ## Why a continuation exists at all
 *
 * Enrichment is serial by Wikimedia's etiquette, so a twelve-place trip may not fit in one request; the server stops
 * itself at its budget and reports `budget_exhausted`. Asking again for the remainder is the honest completion of one
 * user action — and it is cheap, because the places already done are in the server's cache.
 *
 * But *only* `budget_exhausted` continues. `rate_limited`, `forbidden` and `wikimedia_misconfigured` are Wikimedia or
 * our deployment telling us to stop, and asking again would be the opposite of honouring that.
 */

/**
 * The most requests one user action may make.
 *
 * Three: an initial call and at most two continuations. Twelve places at a 90 s server budget fit comfortably in that
 * many even when every lookup is slow, and a fixed ceiling is what makes "one click cannot loop" true by construction
 * rather than by the loop condition happening to terminate.
 *
 * The count is of *calls*, not of continuations, because that is the number a reader needs when asking "what is the worst
 * this button can do".
 */
export const MAX_ENRICHMENT_CALLS = 3;

export type EnrichmentWorkflowStop =
  /** Every place got an answer. */
  | "complete"
  /** The server was still out of time when the call ceiling was reached. */
  | "call-limit"
  /** Wikimedia or the deployment said stop — rate limited, blocked, or misconfigured. */
  | "provider-stopped"
  /** A call produced no new answer, so asking again would repeat it. */
  | "no-progress"
  | "aborted"
  /** A transport failure or a response that failed the contract. */
  | "failed";

export type EnrichmentWorkflowResult = {
  /** One outcome per place that got an answer, in the order the places were given. */
  outcomes: EnrichOutcome[];
  /** How many places came back matched — the number a traveller is told. */
  matched: number;
  /**
   * How many places Roamly still does not know about.
   *
   * Counts a place that received no outcome at all **and** a place whose outcome was `failed`. Both mean the same thing
   * to the person reading it: we asked, or meant to, and cannot say. Deliberately excludes `unmatched` and `review`,
   * which are answers — "no encyclopaedia entry exists" and "this needs a person to confirm" are results, not gaps.
   */
  unresolved: number;
  /** The place ids behind `unresolved`, so a caller can offer to try again later. */
  unresolvedPlaceIds: string[];
  /** How many requests were made. Bounded by `MAX_ENRICHMENT_CALLS`. */
  calls: number;
  stop: EnrichmentWorkflowStop;
  /** Echoed from the request, untouched, for the guarded save. */
  expectedRevision: number;
};

export type EnrichmentPost = (
  request: EnrichTripPlacesRequest,
  signal: AbortSignal | undefined,
) => Promise<unknown>;

export async function runEnrichmentWorkflow(input: {
  places: readonly TripPlace[];
  expectedRevision: number;
  /** One id for the whole workflow, so a continuation is traceable to the action that started it. */
  requestId: string;
  post: EnrichmentPost;
  signal?: AbortSignal;
  /** Lowered by tests. Raised by nothing — the ceiling is the guarantee. */
  maxCalls?: number;
}): Promise<EnrichmentWorkflowResult> {
  const maxCalls = Math.max(1, input.maxCalls ?? MAX_ENRICHMENT_CALLS);

  /* De-duplicated, and the order of first appearance is preserved so the report reads like the itinerary. */
  const byPlaceId = new Map<string, TripPlace>();
  for (const place of input.places) {
    if (!byPlaceId.has(place.placeId)) byPlaceId.set(place.placeId, place);
  }

  const answered = new Map<string, EnrichOutcome>();
  let calls = 0;
  let stop: EnrichmentWorkflowStop = "complete";

  while (calls < maxCalls) {
    if (input.signal?.aborted) {
      stop = "aborted";
      break;
    }

    /*
     * The next request carries whole places, not ids.
     *
     * This is what "correctness does not depend on a warm server cache" means concretely: a continuation that sent only
     * canonical ids would need the server to still remember the places from the previous call — and a serverless
     * instance is free to have restarted between the two. Sending the places again costs a few kilobytes and makes a
     * cold instance produce the same answer as a warm one, just more slowly.
     */
    const pending = [...byPlaceId.values()].filter(
      (place) => !answered.has(place.placeId),
    );
    if (pending.length === 0) {
      stop = "complete";
      break;
    }

    calls += 1;

    let payload: unknown;
    try {
      payload = await input.post(
        {
          expectedRevision: input.expectedRevision,
          places: pending,
          requestId: input.requestId,
        },
        input.signal,
      );
    } catch (error) {
      /* An abort surfaces as a thrown `AbortError`; anything else is a transport failure. Both stop the workflow. */
      stop = isAbort(error) || input.signal?.aborted ? "aborted" : "failed";
      break;
    }

    const parsed = EnrichTripPlacesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      /*
       * A response that fails the contract is not partially believed.
       *
       * Reading the outcomes that happen to parse would mean persisting data from a response Roamly could not verify,
       * which is the thing the schema exists to prevent. Whatever earlier calls established is kept; this call is not.
       */
      stop = "failed";
      break;
    }

    const before = answered.size;
    for (const outcome of parsed.data.outcomes) {
      /* First answer wins. A later call must not overwrite a result already accepted. */
      if (!answered.has(outcome.canonicalPlaceId)) {
        answered.set(outcome.canonicalPlaceId, outcome);
      }
    }

    const abandoned = parsed.data.abandoned;

    if (!abandoned) {
      stop = answered.size < byPlaceId.size ? "no-progress" : "complete";
      break;
    }

    if (abandoned.code !== "budget_exhausted") {
      /* Rate limited, blocked, or misconfigured. Asking again is how a soft block becomes a hard one. */
      stop = "provider-stopped";
      break;
    }

    if (answered.size === before) {
      /*
       * The anti-loop guard that matters.
       *
       * The call ceiling already bounds this, but a server that reports `budget_exhausted` having answered nothing would
       * otherwise be asked two more times for exactly the same thing. One repetition proves the point.
       */
      stop = "no-progress";
      break;
    }

    if (answered.size >= byPlaceId.size) {
      stop = "complete";
      break;
    }

    /* Out of time, with progress made and places outstanding. Continue, unless the ceiling is the next thing we hit. */
    if (calls >= maxCalls) {
      stop = "call-limit";
      break;
    }
  }

  const outcomes: EnrichOutcome[] = [];
  const unresolvedPlaceIds: string[] = [];
  let matched = 0;

  for (const placeId of byPlaceId.keys()) {
    const outcome = answered.get(placeId);

    if (!outcome) {
      unresolvedPlaceIds.push(placeId);
      continue;
    }

    outcomes.push(outcome);
    if (outcome.status === "matched") matched += 1;
    if (outcome.status === "failed") unresolvedPlaceIds.push(placeId);
  }

  return {
    outcomes,
    matched,
    unresolved: unresolvedPlaceIds.length,
    unresolvedPlaceIds,
    calls,
    stop,
    expectedRevision: input.expectedRevision,
  };
}

/**
 * The sidecar entries a finished workflow may persist.
 *
 * Only `matched` and `review` carry a sidecar, and both are worth keeping: a match holds the facts, and a review holds
 * the identity a person needs in order to confirm it. `unmatched` and `failed` carry nothing, so there is nothing to
 * write — an entry recording "we found nothing" would be an empty panel with a timestamp.
 *
 * Separate from `runEnrichmentWorkflow` so the ordering is explicit at the call site: run the whole thing, then persist
 * once. A caller cannot accidentally save mid-workflow, because there is nothing to save until this is called.
 */
export function persistableEntries(result: EnrichmentWorkflowResult) {
  return result.outcomes
    .filter(
      (outcome) => outcome.status === "matched" || outcome.status === "review",
    )
    .map((outcome) => outcome.intelligence);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
