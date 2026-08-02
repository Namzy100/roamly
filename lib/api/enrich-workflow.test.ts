import { describe, expect, it, vi } from "vitest";

import { FIXTURE_PLACES } from "@/lib/generate/test-fixtures";
import {
  fact,
  identity,
  sidecar,
} from "@/lib/place-intelligence/test-fixtures";
import type { TripPlace } from "@/lib/schemas";

import {
  persistableEntries,
  runEnrichmentWorkflow,
  MAX_ENRICHMENT_CALLS,
  type EnrichmentPost,
  type EnrichmentWorkflowProgress,
} from "./enrich-workflow";
import type {
  EnrichOutcome,
  EnrichTripPlacesRequest,
  EnrichTripPlacesResponse,
} from "./place-intelligence-contract";

/**
 * The bounded continuation workflow.
 *
 * One user action, at most three requests, and no branch that can repeat itself. The properties worth pinning are the
 * ones that fail silently: a follow-up that re-asks about a place already answered wastes a volunteer service's time, a
 * loop that never terminates burns a traveller's battery, and a `rate_limited` response treated as a reason to try again
 * is how a soft block becomes a hard one.
 */

const MUSEUM = FIXTURE_PLACES.museumOne;
const GALLERY = FIXTURE_PLACES.museumTwo;
const HOTEL = FIXTURE_PLACES.hotel;

const PLACES: TripPlace[] = [MUSEUM, GALLERY, HOTEL];

function matched(place: TripPlace): EnrichOutcome {
  const canonicalPlaceId = place.placeId;
  return {
    status: "matched",
    canonicalPlaceId,
    intelligence: sidecar({
      canonicalPlaceId,
      identities: [identity({ canonicalPlaceId })],
      facts: [
        fact({ kind: "inception-year", value: 1509, provider: "wikidata" }),
      ],
    }),
    summary: null,
    partial: false,
    notes: [],
  };
}

function review(place: TripPlace): EnrichOutcome {
  const canonicalPlaceId = place.placeId;
  return {
    status: "review",
    canonicalPlaceId,
    intelligence: sidecar({
      canonicalPlaceId,
      identities: [identity({ canonicalPlaceId, method: "name-and-proximity" })],
      facts: [],
    }),
    reason: "The name and the coordinates agreed, but by a heuristic.",
    notes: [],
  };
}

function failed(place: TripPlace): EnrichOutcome {
  return {
    status: "failed",
    canonicalPlaceId: place.placeId,
    code: "wikimedia_invalid_response",
  };
}

function response(
  outcomes: EnrichOutcome[],
  abandoned: EnrichTripPlacesResponse["abandoned"] = null,
): EnrichTripPlacesResponse {
  return {
    expectedRevision: 3,
    requestId: "req-workflow-0001",
    outcomes,
    abandoned,
  };
}

type PostMock = ReturnType<typeof vi.fn>;

function requestsFrom(post: PostMock) {
  return post.mock.calls.map((call) => call[0] as EnrichTripPlacesRequest);
}

function run(
  post: PostMock,
  signal?: AbortSignal,
  onProgress?: (progress: EnrichmentWorkflowProgress) => void,
) {
  return runEnrichmentWorkflow({
    places: PLACES,
    expectedRevision: 3,
    requestId: "req-workflow-0001",
    /*
     * A cast, because an untyped `vi.fn()` is a constructable-or-callable union that no specific signature satisfies.
     * Typing each mock at its creation site would be the alternative, and it would put the noise in twelve places
     * instead of one — the assertions below are what check the shape.
     */
    post: post as unknown as EnrichmentPost,
    signal,
    onProgress,
  });
}

/** Runs, collecting every emission, so a test can assert the whole sequence rather than only the last line. */
async function withProgress(post: PostMock, signal?: AbortSignal) {
  const seen: EnrichmentWorkflowProgress[] = [];
  const result = await run(post, signal, (progress) => {
    seen.push(progress);
  });
  return { result, seen };
}

describe("a complete run", () => {
  it("makes one call and reports what matched", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(
        response([matched(MUSEUM), matched(GALLERY), review(HOTEL)]),
      );

    const result = await run(post);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe("complete");
    expect(result.matched).toBe(2);
    expect(result.unresolved).toBe(0);
    expect(result.expectedRevision).toBe(3);
  });
});

describe("continuation", () => {
  it("asks again only for the places still unanswered", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValueOnce(response([matched(GALLERY), matched(HOTEL)]));

    const result = await run(post);

    expect(post).toHaveBeenCalledTimes(2);
    expect(requestsFrom(post)[1].places.map((place) => place.placeId)).toEqual([
      GALLERY.placeId,
      HOTEL.placeId,
    ]);
    expect(result.stop).toBe("complete");
    expect(result.matched).toBe(3);
  });

  it("sends whole places, so a cold server answers the same", async () => {
    /* A continuation carrying only ids would need the server to remember the previous call. It may have restarted. */
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValueOnce(response([matched(GALLERY), matched(HOTEL)]));

    await run(post);

    const second = requestsFrom(post)[1];
    expect(second.places[0]).toEqual(GALLERY);
    expect(second.places[0].coordinates).toBeDefined();
  });

  it("never re-asks about a place already answered", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValueOnce(
        response([matched(GALLERY)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValueOnce(response([matched(HOTEL)]));

    await run(post);

    const asked = requestsFrom(post).map((request) =>
      request.places.map((place) => place.placeId),
    );

    expect(asked).toEqual([
      [MUSEUM.placeId, GALLERY.placeId, HOTEL.placeId],
      [GALLERY.placeId, HOTEL.placeId],
      [HOTEL.placeId],
    ]);
  });

  it("keeps the first answer when a later call repeats a place", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([review(MUSEUM)], { code: "budget_exhausted", attempted: 1 }),
      )
      /* A server that answered the museum again must not overwrite the accepted review. */
      .mockResolvedValueOnce(
        response([matched(MUSEUM), matched(GALLERY), matched(HOTEL)]),
      );

    const result = await run(post);

    const museum = result.outcomes.find(
      (outcome) => outcome.canonicalPlaceId === MUSEUM.placeId,
    );
    expect(museum?.status).toBe("review");
  });
});

describe("the loop is bounded", () => {
  it("stops at the call ceiling", async () => {
    /* A server perpetually out of time, making one place of progress each time. */
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValueOnce(
        response([matched(GALLERY)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValue(
        response([matched(HOTEL)], { code: "budget_exhausted", attempted: 1 }),
      );

    const result = await run(post);

    expect(post).toHaveBeenCalledTimes(MAX_ENRICHMENT_CALLS);
    expect(result.calls).toBe(MAX_ENRICHMENT_CALLS);
    expect(result.stop).toBe("complete");
    expect(result.matched).toBe(3);
  });

  /**
   * The ceiling reached with places still outstanding.
   *
   * The test above hits the same ceiling but happens to answer every place on the way, so it settles as `complete` and
   * says nothing about the cap's own outcome. This is the case a traveller actually sees when a trip is too slow to
   * finish: three calls spent, one place still unknown, and a result that must not claim otherwise.
   */
  it("reports the cap without claiming completion, keeping the unresolved count", async () => {
    const places = [MUSEUM, GALLERY, HOTEL, FIXTURE_PLACES.restaurantOne];
    /* One place of progress per call, and a fourth place that is never reached. */
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], { code: "budget_exhausted", attempted: 1 }),
      )
      .mockResolvedValueOnce(
        response([matched(GALLERY)], { code: "budget_exhausted", attempted: 1 }),
      )
      .mockResolvedValue(
        response([matched(HOTEL)], { code: "budget_exhausted", attempted: 1 }),
      );

    const result = await runEnrichmentWorkflow({
      places,
      expectedRevision: 3,
      requestId: "req-workflow-0001",
      post: post as unknown as EnrichmentPost,
    });

    expect(result.calls).toBe(MAX_ENRICHMENT_CALLS);
    /* Not `complete`: three calls were spent and a place is still unanswered. */
    expect(result.stop).toBe("call-limit");
    expect(result.matched).toBe(3);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedPlaceIds).toEqual([
      FIXTURE_PLACES.restaurantOne.placeId,
    ]);

    /* Each call carried only what was still outstanding, and the last still had a place left over. */
    expect(requestsFrom(post).map((request) => request.places.length)).toEqual([
      4, 3, 2,
    ]);
  });

  it("stops immediately when a call makes no progress", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(
        response([], { code: "budget_exhausted", attempted: 0 }),
      );

    const result = await run(post);

    /* One repetition proves the point; two more would be asking the same question three times. */
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe("no-progress");
    expect(result.unresolved).toBe(3);
  });

  it("does not continue when the provider said stop", async () => {
    const post = vi.fn().mockResolvedValue(
      response([matched(MUSEUM)], {
        code: "wikimedia_rate_limited",
        retryAfterMs: 30_000,
        attempted: 1,
      }),
    );

    const result = await run(post);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe("provider-stopped");
    expect(result.matched).toBe(1);
  });
});

describe("abort and failure", () => {
  it("makes no call at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const post = vi.fn();

    const result = await run(post, controller.signal);

    expect(post).not.toHaveBeenCalled();
    expect(result.stop).toBe("aborted");
    expect(result.unresolved).toBe(3);
  });

  it("stops the pending continuation when aborted mid-workflow", async () => {
    const controller = new AbortController();
    const post = vi.fn().mockImplementation(async () => {
      controller.abort();
      return response([matched(MUSEUM)], {
        code: "budget_exhausted",
        attempted: 1,
      });
    });

    const result = await run(post, controller.signal);

    /* The first call completed and its answer is kept; the continuation never went out. */
    expect(post).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe("aborted");
    expect(result.matched).toBe(1);
  });

  /**
   * An abort that arrives as a rejection from inside the call, which is what `fetch` actually does.
   *
   * The test above aborts the signal and lets the call resolve, so it exercises the between-calls check. This exercises
   * the other branch: `post` rejects with an `AbortError`, and the workflow must read that as the traveller changing
   * their mind rather than as a transport failure. The two are told apart by `stop`, and only `aborted` suppresses the
   * save — so misclassifying an abort as `failed` would write a sidecar for a run somebody cancelled.
   */
  it("treats an AbortError thrown by the call itself as an abort, not a failure", async () => {
    const controller = new AbortController();
    const post = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });

    const result = await run(post, controller.signal);

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.stop).toBe("aborted");
    expect(result.matched).toBe(0);
    /* Nothing was answered, so every place is still outstanding and none is claimed as checked. */
    expect(result.unresolved).toBe(PLACES.length);
    expect(result.outcomes).toEqual([]);
  });

  /**
   * The same rejection without the signal ever being aborted is still an abort.
   *
   * A caller can pass no signal at all and have its transport abort for its own reasons — a navigation, a closed tab.
   * `isAbort(error)` is what covers that, independently of `signal.aborted`, and without this test the two halves of
   * that condition could not be distinguished.
   */
  it("recognises an AbortError even when no signal was given", async () => {
    const post = vi.fn().mockRejectedValue(
      new DOMException("The operation was aborted.", "AbortError"),
    );

    const result = await run(post);

    expect(result.stop).toBe("aborted");
    expect(result.calls).toBe(1);
  });

  it("treats a response that fails the contract as a failure, keeping earlier answers", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], {
          code: "budget_exhausted",
          attempted: 1,
        }),
      )
      .mockResolvedValueOnce({ outcomes: "not an array" });

    const result = await run(post);

    expect(result.stop).toBe("failed");
    expect(result.matched).toBe(1);
    expect(result.unresolved).toBe(2);
  });

  it("treats a transport failure as a failure", async () => {
    const post = vi.fn().mockRejectedValue(new Error("network down"));

    const result = await run(post);

    expect(result.stop).toBe("failed");
    expect(result.unresolved).toBe(3);
  });
});

describe("the final report", () => {
  it("counts a failed outcome as unresolved, and unmatched as an answer", async () => {
    const post = vi.fn().mockResolvedValue(
      response([
        matched(MUSEUM),
        failed(GALLERY),
        {
          status: "unmatched",
          canonicalPlaceId: HOTEL.placeId,
          reason: "A hotel is commercial premises rather than a landmark.",
        },
      ]),
    );

    const result = await run(post);

    expect(result.matched).toBe(1);
    /* `unmatched` is an answer; `failed` is a gap. */
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedPlaceIds).toEqual([GALLERY.placeId]);
  });

  it("agrees with the last progress emission it reported", async () => {
    /*
     * The one invariant tying the two together. A progress line and a final line that counted differently would look
     * like the last call had undone something, and a reader would trust whichever they happened to see.
     */
    const post = vi
      .fn()
      .mockResolvedValue(response([matched(MUSEUM), failed(GALLERY)]));

    const { result, seen } = await withProgress(post);
    const last = seen[seen.length - 1];

    expect(last.matched).toBe(result.matched);
    expect(last.unresolved).toBe(result.unresolved);
    expect(last.remainingPlaceIds).toEqual([HOTEL.placeId]);
    expect(result.unresolvedPlaceIds).toEqual([GALLERY.placeId, HOTEL.placeId]);
  });

  it("offers only sidecar-bearing outcomes for persistence", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(
        response([matched(MUSEUM), review(GALLERY), failed(HOTEL)]),
      );

    const entries = persistableEntries(await run(post));

    expect(entries.map((entry) => entry.canonicalPlaceId)).toEqual([
      MUSEUM.placeId,
      GALLERY.placeId,
    ]);
  });
});

/**
 * Progress, which exists so a panel can say what is happening without opening an unvalidated response.
 *
 * Two properties carry the weight, and both are about *not* reporting: nothing is emitted for a response that failed the
 * contract, because those numbers would be read out of a body the schema rejected; and nothing a listener does can change
 * what the workflow decides or costs a traveller a validated answer.
 */
describe("progress reporting", () => {
  it("reports once per validated call, naming the call that finished", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], { code: "budget_exhausted", attempted: 1 }),
      )
      .mockResolvedValueOnce(response([matched(GALLERY), review(HOTEL)]));

    const { seen } = await withProgress(post);

    expect(seen).toHaveLength(2);
    expect(seen.map((entry) => entry.phase)).toEqual([
      "checking",
      "continuing",
    ]);
    expect(seen.map((entry) => entry.call)).toEqual([1, 2]);
    expect(seen.map((entry) => entry.maximumCalls)).toEqual([
      MAX_ENRICHMENT_CALLS,
      MAX_ENRICHMENT_CALLS,
    ]);
    /* The second call asked about the two still outstanding, which is the number a "checking 2 places" line needs. */
    expect(seen.map((entry) => entry.requestedThisCall)).toEqual([3, 2]);
  });

  it("counts up towards a total that never moves", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], { code: "budget_exhausted", attempted: 1 }),
      )
      .mockResolvedValueOnce(response([matched(GALLERY), matched(HOTEL)]));

    const { seen } = await withProgress(post);

    expect(seen.map((entry) => entry.checked)).toEqual([1, 3]);
    expect(seen.map((entry) => entry.total)).toEqual([3, 3]);
    expect(seen.map((entry) => entry.remainingPlaceIds)).toEqual([
      [GALLERY.placeId, HOTEL.placeId],
      [],
    ]);
  });

  it("counts each kind of answer separately", async () => {
    const post = vi.fn().mockResolvedValue(
      response([
        matched(MUSEUM),
        review(GALLERY),
        {
          status: "unmatched",
          canonicalPlaceId: HOTEL.placeId,
          reason: "A hotel is commercial premises rather than a landmark.",
        },
      ]),
    );

    const { seen } = await withProgress(post);

    expect(seen[0].matched).toBe(1);
    expect(seen[0].review).toBe(1);
    expect(seen[0].unmatched).toBe(1);
    expect(seen[0].failed).toBe(0);
    /* `unmatched` and `review` are answers, so nothing is unresolved even though only one place matched. */
    expect(seen[0].unresolved).toBe(0);
  });

  it("counts a failed outcome as both failed and unresolved", async () => {
    const post = vi
      .fn()
      .mockResolvedValue(
        response([matched(MUSEUM), failed(GALLERY), failed(HOTEL)]),
      );

    const { seen } = await withProgress(post);

    expect(seen[0].checked).toBe(3);
    expect(seen[0].failed).toBe(2);
    /* Checked and still unknown: the place was asked about and cannot be described. Both numbers are true at once. */
    expect(seen[0].unresolved).toBe(2);
    expect(seen[0].remainingPlaceIds).toEqual([]);
  });

  it("ignores an outcome for a place nobody asked about", async () => {
    /*
     * A progress bar reading 4 of 3 is a bug report from a traveller, and it is reachable from a response that answers a
     * canonical id outside the request. Counting from the *requested* set makes it unreachable.
     */
    const post = vi.fn().mockResolvedValue(
      response([
        matched(MUSEUM),
        matched(GALLERY),
        matched(HOTEL),
        {
          status: "unmatched",
          canonicalPlaceId: "osm:node/999999999",
          reason: "A place nobody asked about.",
        },
      ]),
    );

    const { seen } = await withProgress(post);

    expect(seen[0].checked).toBe(3);
    expect(seen[0].total).toBe(3);
    expect(seen[0].matched).toBe(3);
    expect(seen[0].unmatched).toBe(0);
  });

  it("reports nothing for a response that failed the contract", async () => {
    /*
     * The reason progress lives in this module rather than in the hook. These counts would have to come out of a body
     * the schema rejected — which is the data the schema exists to refuse.
     */
    const post = vi
      .fn()
      .mockResolvedValueOnce(
        response([matched(MUSEUM)], { code: "budget_exhausted", attempted: 1 }),
      )
      .mockResolvedValueOnce({ outcomes: "not an array" });

    const { result, seen } = await withProgress(post);

    expect(result.stop).toBe("failed");
    /* One emission, for the one call that parsed. */
    expect(seen).toHaveLength(1);
    expect(seen[0].call).toBe(1);
  });

  it("reports nothing for a transport failure or an abort before any call", async () => {
    const failing = vi.fn().mockRejectedValue(new Error("network down"));
    expect((await withProgress(failing)).seen).toEqual([]);

    const controller = new AbortController();
    controller.abort();
    const never = vi.fn();
    expect((await withProgress(never, controller.signal)).seen).toEqual([]);
  });

  it("still reports the answers of a call that ended the run", async () => {
    /* A rate-limited response that answered one place established something. Discarding the count would hide it. */
    const post = vi.fn().mockResolvedValue(
      response([matched(MUSEUM)], {
        code: "wikimedia_rate_limited",
        retryAfterMs: 30_000,
        attempted: 1,
      }),
    );

    const { result, seen } = await withProgress(post);

    expect(result.stop).toBe("provider-stopped");
    expect(seen).toHaveLength(1);
    expect(seen[0].matched).toBe(1);
    expect(seen[0].unresolved).toBe(2);
  });

  it("does not let a throwing listener cost the run its results", async () => {
    /*
     * The one deliberate swallow in the module. Progress is decoration; a reporter that throws must not turn "the
     * progress line crashed" into "the enrichment you waited for was thrown away".
     */
    const post = vi
      .fn()
      .mockResolvedValue(
        response([matched(MUSEUM), matched(GALLERY), matched(HOTEL)]),
      );

    const result = await run(post, undefined, () => {
      throw new Error("a listener misbehaved");
    });

    expect(result.stop).toBe("complete");
    expect(result.matched).toBe(3);
  });

  it("reports nothing at all when no listener was given", async () => {
    /* The default path, and the one every existing caller takes. The workflow must behave identically. */
    const post = vi
      .fn()
      .mockResolvedValue(
        response([matched(MUSEUM), matched(GALLERY), matched(HOTEL)]),
      );

    const result = await runEnrichmentWorkflow({
      places: PLACES,
      expectedRevision: 3,
      requestId: "req-workflow-0001",
      post: post as unknown as EnrichmentPost,
    });

    expect(result.stop).toBe("complete");
    expect(result.matched).toBe(3);
  });
});
