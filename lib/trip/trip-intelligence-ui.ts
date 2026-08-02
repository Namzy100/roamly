import {
  MAX_ENRICHMENT_CALLS,
  type EnrichmentWorkflowResult,
} from "@/lib/api/enrich-workflow";
import { offlineReasonFor } from "@/lib/hooks/use-online-status";
import type { SaveTripIntelligenceResult } from "@/lib/store/trip-intelligence";

/**
 * What a landmark-context control says, and when it may be pressed (Checkpoint 5B, section 11).
 *
 * ## Why this is not in the hook
 *
 * It used to be. Three module-private functions inside `use-trip-intelligence.ts` decided every sentence a traveller
 * reads about enrichment — and none of them could be tested, because the repository has no jsdom and a private function
 * inside a hook has no reachable surface. The copy that matters most was the copy nothing checked.
 *
 * Pure functions over plain values can be checked exhaustively, which is what the requirements here actually need:
 * "never says the place is fake" and "never claims every place was checked" are properties of a mapping, and a test can
 * enumerate the whole mapping.
 *
 * ## Why `lib/trip` rather than `lib/place-intelligence`
 *
 * It reads `EnrichmentWorkflowResult` and `SaveTripIntelligenceResult`, which come from `lib/api` and `lib/store` — and
 * both of those depend on `lib/place-intelligence`. Putting this there would point the contract directory at its own
 * consumers, and that directory's independence is what lets a provider be dropped without touching it. `lib/trip` is
 * where the other pure presentation logic lives (`item-card.ts`, `visible-items.ts`), and it is downstream of everything
 * it needs.
 *
 * ## What is deliberately absent
 *
 * No transport, no fetch, no store call, no React. Every function here takes a finished result and returns text and
 * booleans. The hook keeps the parts that are genuinely about running things: the abort controller, the in-flight guard,
 * the one write.
 *
 * ## The vocabulary these sentences may not use
 *
 * Roamly asked an encyclopaedia about a place and got no useful answer. That is a statement about the encyclopaedia's
 * coverage and nothing more. So no sentence below says or implies that the place is fake, invalid, closed or deleted,
 * that Wikimedia contradicted the itinerary, or that a source is wrong — a missing Wikidata entity is the ordinary case
 * for most of the world, and a traveller told "this place could not be verified" would reasonably delete a real
 * restaurant. The test file asserts the absence of that vocabulary across every outcome.
 */

/**
 * Every state a landmark-context control may be in.
 *
 * Lives here rather than in the hook because these functions produce it and the panel consumes it; the hook re-exports
 * the name so the type's public path is unchanged.
 */
export type TripIntelligenceStatus =
  /** Ready, with something to look up. */
  | "idle"
  /** This trip contains nothing the eligibility policy permits asking about. Not an error. */
  | "no-eligible-landmarks"
  /** The browser cannot reach a network, so a request would fail rather than merely be slow. */
  | "offline"
  /** This deployment has not completed its setup, so the feature is unavailable here. */
  | "unconfigured"
  /** The first request is in flight. */
  | "checking"
  /** A follow-up request is in flight, because the server ran out of time with places outstanding. */
  | "continuing"
  /** Every request is done and the single store write is in progress. Not cancellable. */
  | "saving"
  /** Saved, and every place was answered. */
  | "complete"
  /** Saved, and some places were not answered. The counts say how many. */
  | "partial"
  /** Finished with nothing to write. The trip is untouched — this never erases what was already there. */
  | "empty"
  /**
   * The traveller pressed Cancel. Nothing was saved, whatever the earlier calls had already answered.
   *
   * Distinct from `idle` on purpose. Resetting to `idle` left the panel looking exactly as it had before the run began,
   * so a cancelled lookup was indistinguishable from one that never happened — and somebody who had just watched a
   * progress bar was given no confirmation that stopping it had cost them nothing. It is also distinct from `failed`:
   * nothing went wrong, and a problem tone would be an apology for doing as asked.
   */
  | "cancelled"
  /** Something went wrong and nothing was saved. */
  | "failed"
  /** The trip changed elsewhere before the write, so nothing was saved. */
  | "conflict";

/**
 * What a traveller is told after cancelling a lookup.
 *
 * Two facts and no apology. "Nothing was saved" is the one that matters — the run may have answered several places
 * before it was stopped, and this is the only place a person is told those answers were discarded rather than half
 * written. "Your trip is unchanged" states the same guarantee from the other side, because "nothing was saved" alone
 * could still be read as "something was removed".
 *
 * Deliberately not phrased as a failure. Cancelling is a thing the button is *for*, and copy that treated it as a fault
 * would make the safe choice feel like a mistake.
 */
export const LANDMARK_CANCELLED_MESSAGE =
  "Cancelled. Nothing was saved — your trip is unchanged.";

/** The phases during which a request or a write is in progress. */
const IN_FLIGHT: ReadonlySet<TripIntelligenceStatus> =
  new Set<TripIntelligenceStatus>(["checking", "continuing", "saving"]);

export type TripIntelligenceUiState = {
  phase: TripIntelligenceStatus;
  /** One sentence for the traveller. Never a provider message, a host, a status code or an error string. */
  message: string;
  matched: number;
  unresolved: number;
  /**
   * Whether *this outcome* leaves something worth trying again.
   *
   * A different question from `intelligenceActionIsRecoverable`, and the pair is why both exist. This one asks "would
   * pressing again plausibly achieve anything?" — false after a trip whose every landmark has been answered, true after a
   * lookup that ran out of requests with places outstanding. The other asks "is the control pressable at all from this
   * phase?", which is a question about the phase and not about what happened.
   *
   * A conflict is where they differ most instructively: the action is perfectly pressable, and the honest advice is still
   * to reload rather than retry, because the copy in this browser is behind.
   */
  canRetry: boolean;
};

/**
 * What to tell a traveller about a run that wrote nothing.
 *
 * `failure` is our own route's error code, never a provider's and never an HTTP status. It reaches this function so a
 * deployment that has not finished its setup can be reported as itself instead of as a generic failure.
 */
export function describeWorkflowStop(input: {
  result: EnrichmentWorkflowResult;
  failure: string | null;
}): TripIntelligenceUiState {
  const { result, failure } = input;
  const base = { matched: 0, unresolved: result.unresolved };

  if (failure === "provider_misconfigured") {
    return {
      ...base,
      phase: "unconfigured",
      /*
       * Says that setup is incomplete and stops there. No variable name, no host, no endpoint, no hint about which value
       * is missing — a traveller cannot act on any of it, and a public deployment should not narrate its own
       * configuration to anybody who presses a button.
       */
      message:
        "Landmark photos and context are not set up on this deployment, so there is nothing to look up here.",
      /* Trying again produces the same answer. A button inviting a retry would be a button that lies. */
      canRetry: false,
    };
  }

  if (result.stop === "provider-stopped") {
    return {
      ...base,
      phase: "empty",
      /*
       * "Asked us to slow down" rather than "rate limited" or "429", and it is also the truth about a volunteer service:
       * being asked to wait is a normal part of using one, not a fault on either side.
       */
      message:
        "Wikimedia asked us to slow down, so the lookup stopped early. Nothing in this trip was changed. Try again in a few minutes.",
      canRetry: true,
    };
  }

  if (result.stop === "call-limit") {
    return {
      ...base,
      phase: "empty",
      /*
       * The sentence that must never round up. `unresolved` is the exact number of places left unreached, and claiming a
       * whole trip was checked when the continuation stopped early is the specific dishonesty this checkpoint forbids.
       */
      message: `The lookup stopped after ${MAX_ENRICHMENT_CALLS} requests with ${result.unresolved} ${plural(result.unresolved)} still unchecked. Nothing in this trip was changed. Run it again to continue.`,
      canRetry: true,
    };
  }

  if (result.stop === "no-progress") {
    return {
      ...base,
      phase: "empty",
      message:
        "The lookup stopped without finding anything new. Nothing in this trip was changed.",
      canRetry: true,
    };
  }

  if (result.stop === "failed") {
    return {
      ...base,
      phase: "failed",
      /* Names the consequence rather than the cause, because the cause is a transport detail nobody can act on. */
      message:
        "The landmark lookup did not finish, so nothing in this trip was changed. Try again.",
      canRetry: true,
    };
  }

  /*
   * Every place was asked about, and none of the answers carried anything to keep.
   *
   * The most delicate sentence in the module. It is about *Wikidata's coverage*, not about the places: most of the world
   * has no encyclopaedia entry, and a traveller told their itinerary "could not be verified" would reasonably start
   * deleting real restaurants. So it says what was searched and what was not found, and makes no claim about the places.
   */
  return {
    ...base,
    phase: "empty",
    message:
      "No landmark photos or context were found for this trip. Wikidata and Wikimedia Commons do not cover every place.",
    /* A finished answer rather than an interruption. Asking again would search the same two sources for the same places. */
    canRetry: false,
  };
}

/**
 * What to tell a traveller about the one write.
 *
 * `matched` comes from `saved` rather than from the workflow, because the store's count is what was actually persisted and
 * the workflow's is what was merely received.
 */
export function describeSaveResult(input: {
  saved: SaveTripIntelligenceResult;
  result: EnrichmentWorkflowResult | null;
  failure: string | null;
}): TripIntelligenceUiState {
  const { saved, result, failure } = input;
  const unresolved = result?.unresolved ?? 0;

  switch (saved.status) {
    case "saved": {
      /*
       * The split a single "done" was hiding. A partial result is a real result and is saved — but it is reported as
       * partial, with both counts, because "found details for 8 places" over a twelve-place trip reads as completion.
       */
      const partial = unresolved > 0;
      return {
        phase: partial ? "partial" : "complete",
        matched: saved.matched,
        unresolved,
        message: partial
          ? `Added photos and context for ${saved.matched} ${plural(saved.matched)}. ${unresolved} ${plural(unresolved)} ${unresolved === 1 ? "was" : "were"} not checked — run it again to continue.`
          : `Added photos and context for ${saved.matched} ${plural(saved.matched)}.`,
        canRetry: partial,
      };
    }

    case "unchanged":
      return {
        phase: "empty",
        matched: 0,
        unresolved,
        /*
         * Nothing was written **and** nothing was removed, and the second half has to be said. A refresh that comes back
         * empty must not read as having wiped what was already there — the store was never asked to.
         */
        message:
          "Nothing new was found, so this trip is unchanged. Any landmark details it already had are still there.",
        canRetry: false,
      };

    case "conflict":
      return {
        phase: "conflict",
        matched: 0,
        unresolved,
        /*
         * Explains that the local copy moved, without blaming anything. Roamly stores trips per browser, so "another tab"
         * is the honest and usually correct description, and a reload is the remedy rather than a retry.
         */
        message:
          "This trip changed in another tab while the lookup was running, so nothing was saved. Reload the page and try again.",
        canRetry: false,
      };

    case "missing-trip":
      return {
        phase: "failed",
        matched: 0,
        unresolved,
        message:
          "This trip is no longer saved in this browser, so nothing was saved.",
        canRetry: false,
      };

    case "storage-refused":
      return {
        phase: "failed",
        matched: 0,
        unresolved,
        /*
         * The store's own sentence, passed through. It is written for a traveller and names the one thing that would
         * change the outcome; replacing it here would mean maintaining two versions of the same advice.
         */
        message: saved.reason,
        /* Pressing again before freeing room fails identically, so the reason is the action and a retry is not. */
        canRetry: false,
      };

    case "invalid":
      return {
        phase: "failed",
        matched: 0,
        unresolved,
        message: result
          ? describeWorkflowStop({ result, failure }).message
          : "The landmark details could not be saved, so nothing in this trip was changed.",
        canRetry: true,
      };
  }
}

/**
 * Why the control cannot be pressed, or `null` if it can.
 *
 * Returned as a sentence rather than a code because it has to be rendered and programmatically associated with the
 * button; a panel translating codes into sentences would be this logic again, in the one place it cannot be tested.
 *
 * ## The order is the interesting part
 *
 * Several reasons can hold at once and only one can be shown. They are tested in the order a traveller can act on them:
 *
 *  1. **in flight** — the most immediate truth, and the only one that will change on its own in a moment
 *  2. **unconfigured** — a property of the deployment. Nothing done to the trip or the network helps
 *  3. **no eligible landmarks** — a property of the itinerary. Above `offline` deliberately: reconnecting would not help,
 *     so naming the network would send somebody to fix the wrong thing
 *  4. **offline** — transient, and the one reason with an obvious remedy
 *  5. **nothing left to check** — applies only to `enrich`, and it points at `refresh` as the way forward
 */
export function intelligenceDisabledReason(input: {
  phase: TripIntelligenceStatus;
  action: "enrich" | "refresh";
  online: boolean;
  eligibleCount: number;
  uncheckedCount: number;
}): string | null {
  const { phase, action, online, eligibleCount, uncheckedCount } = input;

  if (IN_FLIGHT.has(phase)) {
    return phase === "saving"
      ? "Saving the landmark details found so far."
      : "A landmark lookup is already running.";
  }

  if (phase === "unconfigured") {
    return "Landmark photos and context are not set up on this deployment.";
  }

  if (eligibleCount === 0) {
    /*
     * States the scope as well as the refusal, because the absence looks like a bug otherwise. A traveller whose trip is
     * three restaurants and a hotel should learn that those are not queried by design.
     */
    return "This trip has no public landmarks to look up. Restaurants and ordinary hotels are not queried.";
  }

  if (!online) return offlineReasonFor("enrich-landmarks");

  if (action === "enrich" && uncheckedCount === 0) {
    return "Every landmark in this trip has already been looked up. Use refresh to check them again.";
  }

  return null;
}

/**
 * Whether the control is pressable at all from this phase.
 *
 * The phase-level counterpart to `TripIntelligenceUiState.canRetry`, and the two answer different questions — see the
 * note on that field. This one is about mechanics: a run is already going, or the deployment cannot do this, or there is
 * nothing eligible, or there is no network.
 *
 * `conflict` is `true` here. The revision is re-read on the next press, so pressing again *can* succeed — the advice to
 * reload is advice, not a lock, and disabling the button would strand a traveller whose other tab has since closed.
 */
export function intelligenceActionIsRecoverable(
  phase: TripIntelligenceStatus,
): boolean {
  if (IN_FLIGHT.has(phase)) return false;
  return (
    phase !== "unconfigured" &&
    phase !== "no-eligible-landmarks" &&
    phase !== "offline"
  );
}

/** "place" or "places". Here rather than in the hook so every sentence in this module agrees. */
export function plural(count: number): string {
  return count === 1 ? "place" : "places";
}
