"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  persistableEntries,
  runEnrichmentWorkflow,
  MAX_ENRICHMENT_CALLS,
} from "@/lib/api/enrich-workflow";
import type { EnrichTripPlacesRequest } from "@/lib/api/place-intelligence-contract";
import { useOnlineStatus } from "@/lib/hooks/use-online-status";
import { selectLandmarkCandidates } from "@/lib/place-intelligence";
import { useTripRecord, useTripStore } from "@/lib/store/trip-store";
import {
  describeSaveResult,
  describeWorkflowStop,
  type TripIntelligenceStatus,
  type TripIntelligenceUiState,
} from "@/lib/trip/trip-intelligence-ui";

/**
 * The "look up these landmarks" workflow.
 *
 * ## Nothing happens until somebody asks
 *
 * No request on mount, on render, on trip open, or on plan change. Wikimedia is volunteer-funded infrastructure and
 * enrichment is optional decoration, so the traveller has to press something — the rule `use-trip-routing.ts` follows for
 * the donated routing server, applied here for a stronger reason: routing is fast, and a serial enrichment pass takes
 * the better part of a minute.
 *
 * The in-flight guard is a ref rather than the rendered status, because React has not re-rendered when a second click
 * lands in the same tick and a disabled attribute alone would let it through.
 *
 * ## One action, many requests, one write
 *
 * `runEnrichmentWorkflow` may make up to three bounded HTTP calls — the server stops itself at its budget and reports
 * what it managed. All of them belong to one user action, and the store is written **once**, at the end, from whatever
 * the workflow accumulated.
 *
 * That ordering is the whole design. Saving after each call would leave a trip half-enriched if the second failed, and it
 * would make the number of server calls visible in the traveller's revision history. So:
 *
 *  - an **abort** saves nothing, whatever the earlier calls returned
 *  - a **stale revision** saves nothing, and says the trip changed elsewhere
 *  - a **storage refusal** saves nothing, and says to free some room
 *  - a **partial** result — some places answered, some not — saves once, because those answers are real
 *
 * ## `enrich` and `refresh` differ only in what they ask about
 *
 * `enrich` sends the candidates with no sidecar entry yet; `refresh` sends every candidate. Neither is a different
 * pipeline — the second is the first with the "already known" filter removed, for when a traveller thinks an entry is
 * wrong or stale.
 */

/**
 * The twelve states a control may be in — defined in `lib/trip/trip-intelligence-ui.ts` and re-exported here so the name
 * keeps its original public path.
 *
 * ## Why it replaced a five-value union
 *
 * The first version had `running`, `done` and `unchanged`, which is enough to drive a spinner and not enough to tell a
 * traveller the truth. Each of the three was hiding distinctions that matter to the person reading the screen:
 *
 *  - `running` is three different situations — a first call, a continuation, and a store write. Only the middle can say
 *    "still going, 2 of 3 calls used", and only the last must not be cancelled.
 *  - `done` is two — every place answered, or some answered and some not. Reporting the second as the first is the
 *    specific dishonesty of claiming a trip was fully checked when the continuation stopped early.
 *  - `unchanged` is three — nothing eligible to ask about, nothing *new* to ask about, and a refresh that found nothing.
 *    The first is a property of the trip and the last is a property of the world, and the remedies differ.
 *
 * Two of the twelve are never produced by a run at all: `no-eligible-landmarks` and `offline` are conditions that hold
 * *before* anything is pressed, so they are derived at the end of this hook rather than stored — a stored value would go
 * out of date the moment a traveller reconnected. `unconfigured` is the opposite: once a deployment has said it cannot do
 * this, the answer sticks, because trying again would produce the same 503.
 */
export type { TripIntelligenceStatus };

/**
 * How far one action has got, from responses that passed the contract.
 *
 * Mapped from `EnrichmentWorkflowProgress` rather than re-derived, so a panel and the workflow cannot disagree. Only the
 * fields a control actually renders are carried across — `remainingPlaceIds` stays in the workflow, because a panel
 * holding it would be tempted to list places mid-run and that list reshuffles as answers arrive.
 */
export type TripIntelligenceProgress = {
  /** Requested places that now have an answer of some kind. Never above `total`. */
  checked: number;
  /** The de-duplicated place count for this action. Constant for its whole duration. */
  total: number;
  matched: number;
  /** No answer yet, plus the places that were asked about and failed. */
  unresolved: number;
  /**
   * How many requests have **completed**, not how many are planned.
   *
   * Deliberately a count of the past. The hook cannot know whether another call will go out — that depends on what the
   * server says next — so a field naming the in-flight call would be a prediction. `status` already distinguishes
   * `checking` from `continuing`, which is the part a reader needs live.
   */
  call: number;
  /** The ceiling in force, so a control can say "2 of 3 used" without importing the constant. */
  maximumCalls: number;
};

export type TripIntelligenceState = {
  status: TripIntelligenceStatus;
  /** How many places came back with facts. Reported after a save, from what was actually written. */
  matched: number;
  /** How many places Roamly still cannot say anything about. */
  unresolved: number;
  /** One sentence for the traveller, or `null`. Never a provider message. */
  message: string | null;
  /** Present once an action has started; `null` before the first one. */
  progress: TripIntelligenceProgress | null;
  /**
   * Whether the last outcome left something worth trying again.
   *
   * From `TripIntelligenceUiState.canRetry`, so a panel offers a retry exactly when one would achieve something — not
   * merely whenever a run ended badly. A conflict, for instance, ends badly and wants a reload.
   */
  canRetry: boolean;
};

const IDLE: TripIntelligenceState = {
  status: "idle",
  matched: 0,
  unresolved: 0,
  message: null,
  progress: null,
  canRetry: false,
};

export function useTripIntelligence(tripId: string) {
  const record = useTripRecord(tripId);
  const saveTripIntelligence = useTripStore(
    (state) => state.saveTripIntelligence,
  );
  const clearTripIntelligence = useTripStore(
    (state) => state.clearTripIntelligence,
  );

  const [state, setState] = useState<TripIntelligenceState>(IDLE);
  const online = useOnlineStatus();

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  /**
   * Which places this trip permits asking about, decided at render time.
   *
   * Hoisted out of the click handler because a control has to be able to say *why* it is disabled before anybody presses
   * it, and "this trip has no eligible landmarks" is not knowable from the run state. Safe to compute on every render:
   * `selectLandmarkCandidates` is a pure filter over the plan and the pool, and the memo is about avoiding a new array
   * identity rather than about cost.
   */
  const candidates = useMemo(
    () =>
      record
        ? selectLandmarkCandidates({
            plan: record.plan,
            pool: record.generation?.placePool ?? null,
          }).map((candidate) => candidate.place)
        : [],
    [record],
  );

  /** Candidates with no sidecar entry yet — what `enrich` would ask about, and nothing more. */
  const unchecked = useMemo(() => {
    const known = record?.intelligence?.byCanonicalPlaceId ?? {};
    return candidates.filter((place) => !known[place.placeId]);
  }, [candidates, record]);

  /*
   * Abort on unmount, so navigating away does not leave a serial run going against a volunteer service for a trip
   * nobody is looking at.
   */
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (mode: "enrich" | "refresh") => {
      if (inFlight.current) return;

      const current = record;
      if (!current) return;

      /*
       * Refused rather than attempted while offline, which is the same rule every other provider-backed action follows.
       * A control is disabled in this state, so reaching here means the state changed between render and click — and
       * starting a request that cannot succeed would spend a spinner to arrive at the answer we already have.
       */
      if (!online) return;

      /*
       * Which places to ask about. The eligibility policy decided the candidate list — see `candidates` above, capped at
       * twelve in itinerary-first order — and the route applies both rules again, because a bound in one place is a bound
       * somebody can forget.
       */
      const places = mode === "refresh" ? candidates : unchecked;

      if (places.length === 0) {
        /*
         * Two different nothings, and the split is the reason `unchanged` was retired.
         *
         * "Nothing eligible in this trip" is a property of the itinerary that no amount of trying changes, so it reads as
         * a statement rather than a result. "Everything already looked up" is a finished action with nothing left to do,
         * which is what `empty` means everywhere else in this union.
         */
        const nothingEligible = candidates.length === 0;

        setState({
          status: nothingEligible ? "no-eligible-landmarks" : "empty",
          matched: 0,
          unresolved: 0,
          message: nothingEligible
            ? "This trip has no landmarks to look up."
            : "Every landmark in this trip has already been looked up.",
          progress: null,
          canRetry: false,
        });
        return;
      }

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      /* The revision read *before* the first request. The store refuses the write if it moved. */
      const expectedRevision = current.revision;

      /*
       * The opening progress line: the total is known, and nothing has been checked.
       *
       * Set before the first request rather than waiting for the first response, because "checking 12 places" is the one
       * thing a traveller wants to see immediately and it is already true. `call: 0` says no request has completed —
       * the count is of the past throughout.
       */
      setState({
        ...IDLE,
        status: "checking",
        unresolved: places.length,
        progress: {
          checked: 0,
          total: places.length,
          matched: 0,
          unresolved: places.length,
          call: 0,
          maximumCalls: MAX_ENRICHMENT_CALLS,
        },
      });

      /** The last non-2xx code, so a misconfigured deployment can be reported as itself. */
      let httpFailure: string | null = null;

      try {
        const result = await runEnrichmentWorkflow({
          places,
          expectedRevision,
          requestId: `enrich-${nanoid(12)}`,
          signal: controller.signal,
          onProgress: (progress) => {
            /*
             * Reported from validated responses only — the workflow guarantees that, which is why these counts are not
             * derived here from the raw body.
             *
             * `continuing` while places remain is a statement about the run not being finished, not a promise that
             * another request will go out: the workflow may stop itself on the server's say-so, and the settled status
             * then replaces this one. The alternative — waiting to see whether a continuation happens — would leave the
             * panel claiming a first call is still in flight after it has returned.
             */
            setState((previous) => ({
              ...previous,
              status:
                progress.checked < progress.total ? "continuing" : "checking",
              matched: progress.matched,
              unresolved: progress.unresolved,
              progress: {
                checked: progress.checked,
                total: progress.total,
                matched: progress.matched,
                unresolved: progress.unresolved,
                call: progress.call,
                maximumCalls: progress.maximumCalls,
              },
            }));
          },
          post: async (request: EnrichTripPlacesRequest, signal) => {
            const response = await fetch("/api/place-intelligence/enrich", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              signal,
            });

            if (!response.ok) {
              const body = await response.json().catch(() => null);
              httpFailure = body?.error?.code ?? `http_${response.status}`;
              throw new Error("Enrichment request failed");
            }

            return response.json();
          },
        });

        if (result.stop === "aborted") {
          /* The traveller changed their mind. Nothing is written, even though earlier calls may have answered. */
          setState(IDLE);
          return;
        }

        const entries = persistableEntries(result);

        if (entries.length === 0) {
          const outcome = describeWorkflowStop({
            result,
            failure: httpFailure,
          });
          /* Progress is kept, so a panel can still say how much of the trip was reached before it came to nothing. */
          setState((previous) => toState(outcome, previous.progress));
          return;
        }

        /*
         * The write is its own visible state, and it is the one that must not be interrupted.
         *
         * A control showing "checking" through the save would offer a Cancel button that cannot honour itself: the
         * requests are already finished, and there is nothing left to abort but a synchronous store call.
         */
        setState((previous) => ({ ...previous, status: "saving" }));

        /* The one write. Everything before this was in memory. */
        const saved = saveTripIntelligence({
          tripId,
          expectedRevision,
          entries,
          fetchedAt: new Date().toISOString(),
        });

        const outcome = describeSaveResult({
          saved,
          result,
          failure: httpFailure,
        });
        setState((previous) => toState(outcome, previous.progress));
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }
    },
    [candidates, online, record, saveTripIntelligence, tripId, unchecked],
  );

  const enrich = useCallback(() => run("enrich"), [run]);
  const refresh = useCallback(() => run("refresh"), [run]);

  /**
   * Forgets every landmark lookup for this trip.
   *
   * Its own guarded action rather than a mode of `run`, because it makes no provider request and needs no workflow — and
   * because "forget what you found" is a decision a traveller makes for its own reasons, most often after seeing an entry
   * they believe is wrong.
   */
  const clear = useCallback((): boolean => {
    const current = record;
    if (!current || inFlight.current) return false;

    const result = clearTripIntelligence({
      tripId,
      expectedRevision: current.revision,
    });

    setState(
      result.status === "saved"
        ? {
            /*
             * Back to `idle`, not to a finished state. Nothing was looked up, so there is no outcome to report — and the
             * control the traveller sees next should be the one that offers to look things up again.
             */
            ...IDLE,
            message: "Landmark details were removed from this trip.",
          }
        : toState(describeSaveResult({ saved: result, result: null, failure: null })),
    );

    /**
     * Whether the trip is now without landmark context, answered synchronously.
     *
     * Returned because the only caller is a confirmation dialog, and a dialog has to decide *in the click* whether to
     * close or to stay open and show what went wrong. Deriving that from the next render — "close when the sidecar is
     * gone" — reads the same but cascades a render to do it, and it cannot tell a refusal from a slow update.
     *
     * True for three different endings, because all three leave nothing to clear: the entries were removed, there
     * were none, or the trip itself is no longer here. False only when the sidecar is still in place — a stale
     * revision or a full store — which are exactly the cases with something to report.
     */
    return (
      result.status === "saved" ||
      result.status === "unchanged" ||
      result.status === "missing-trip"
    );
  }, [clearTripIntelligence, record, tripId]);

  /**
   * The two conditions that are true before anything is pressed, layered over the run state.
   *
   * Derived rather than stored, because both change without any action of ours: a traveller reconnects, or edits the
   * itinerary until a museum is in it. A `useEffect` mirroring them into state would render once with the stale answer
   * every time either changed.
   *
   * Only `idle` is overridden. A settled run keeps its result — going offline after a successful lookup does not unsay
   * what was found — and an in-flight run keeps its progress, because the request either completes or fails on its own.
   *
   * `no-eligible-landmarks` outranks `offline` when both hold: reconnecting would not help, so naming the network would
   * send a traveller to fix the wrong thing.
   */
  const status: TripIntelligenceStatus =
    state.status === "idle"
      ? candidates.length === 0
        ? "no-eligible-landmarks"
        : online
          ? "idle"
          : "offline"
      : state.status;

  /**
   * Whether this trip already holds landmark context.
   *
   * The question that decides which panel a traveller sees — "add" or "refresh and clear" — and it is about the
   * *stored* sidecar rather than about the last run: a trip enriched yesterday and reloaded today has context and no
   * outcome to report. Counted rather than tested for presence, because `reconcileTripIntelligence` can leave an
   * empty record behind when every entry's place has left the itinerary, and an empty sidecar has nothing to clear.
   */
  const hasIntelligence =
    Object.keys(record?.intelligence?.byCanonicalPlaceId ?? {}).length > 0;

  return {
    ...state,
    status,
    hasIntelligence,
    /**
     * How many places this trip permits asking about at all, and how many of those are still unknown.
     *
     * Exposed so a control can label itself honestly before it is pressed — "Check 4 landmarks" is a different button
     * from "Check 12 landmarks", and a disabled one owes the traveller the reason.
     */
    eligibleCount: candidates.length,
    uncheckedCount: unchecked.length,
    enrich,
    refresh,
    clear,
    cancel,
  } as const;
}

/**
 * A settled outcome, as the hook's own state.
 *
 * The two shapes differ in exactly two ways: the copy module calls the discriminant `phase`, because to it the value is
 * the answer rather than a status; and it knows nothing about `progress`, because progress belongs to the run. Both
 * differences are intentional, so this adapter is where they meet rather than a reason to make the shapes identical.
 */
function toState(
  outcome: TripIntelligenceUiState,
  progress: TripIntelligenceProgress | null = null,
): TripIntelligenceState {
  return {
    status: outcome.phase,
    matched: outcome.matched,
    unresolved: outcome.unresolved,
    message: outcome.message,
    progress,
    canRetry: outcome.canRetry,
  };
}

