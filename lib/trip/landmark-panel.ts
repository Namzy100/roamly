import {
  intelligenceActionIsRecoverable,
  intelligenceDisabledReason,
  plural,
  type TripIntelligenceStatus,
} from "./trip-intelligence-ui";

/**
 * Everything the landmark-context panel renders, decided without a DOM (Checkpoint 5B, section 10B).
 *
 * ## Why the panel is a view model rather than a component with branches
 *
 * The panel has twelve states, two actions, a cancel that must appear for two of those states and not the third
 * in-flight one, a disabled reason that has to be programmatically associated with the control, and a progress
 * region that must never round up. In a component every one of those is a `?:` inside JSX, and this repository has
 * no jsdom — so the branches that matter most would be the branches nothing checks.
 *
 * So the component above this is deliberately dull: it reads fields and renders them. Everything that could be
 * *wrong* — which button, which label, whether cancel is offered, what percentage is honest — is decided here,
 * where a test can enumerate all twelve states.
 *
 * ## What it does not decide
 *
 * No copy that `trip-intelligence-ui.ts` already owns. The outcome sentence is passed straight through from the
 * hook, and the disabled reason comes from `intelligenceDisabledReason`. Re-wording either here would be a second
 * copy policy in the one place the first one cannot see it — which is exactly what section 11 forbids.
 *
 * What is added here is *panel* vocabulary: the heading, the button labels, and the progress lines. None of it
 * describes a place, so none of it can make a claim about one.
 */

export type LandmarkPanelAction = "enrich" | "refresh";

/** How a settled outcome should read. Not a colour — the component picks those. */
export type LandmarkPanelTone = "success" | "notice" | "problem";

export type LandmarkPanelProgress = {
  checked: number;
  total: number;
  matched: number;
  unresolved: number;
  /** Requests that have **finished**. Never the one in flight — see `callLine`. */
  completedCalls: number;
  maximumCalls: number;
  /**
   * An integer 0–100, capped at 99 while anything is unresolved.
   *
   * The cap is the whole reason this is computed here. `checked / total` reaches 1 the moment every place has an
   * answer — including the places whose answer was "we could not reach this one" — so a run that gave up on four
   * of twelve would render a full bar. A traveller reading 100% has been told the trip was checked.
   */
  percent: number;
  /** "Checking 12 places." / "Another bounded check is underway." / "Saving…" — the three are visibly different. */
  phaseLine: string;
  /** "3 of 12 places checked". */
  countLine: string;
  /** "2 places with photos or context · 9 still to reach". Omits a zero rather than printing it. */
  resultLine: string;
  /**
   * "1 of 3 requests completed".
   *
   * Says *completed* and means it. Labelling this "request 2 of 3" would be a claim that a second request is
   * happening, which the hook cannot know: whether another goes out depends on what the server says next.
   */
  callLine: string;
};

export type LandmarkPanelViewModel = {
  heading: string;
  /** The standing explanation of what a lookup does and does not do. Always rendered. */
  supporting: string;
  primary: {
    action: LandmarkPanelAction;
    /**
     * Fixed for a given action, in flight or not.
     *
     * A label that becomes "Checking…" changes the control's accessible name mid-operation, which reads to a
     * screen reader as a different button appearing. The busy state is `busy` plus the progress region instead.
     */
    label: string;
    /** A sentence when the control cannot be pressed, `null` when it can. Rendered, and referenced by the button. */
    disabledReason: string | null;
    busy: boolean;
  };
  /** The clear control, present only when there is something to clear. */
  clear: { label: string; disabled: boolean } | null;
  /** Offered only while a request is in flight. Absent during the save, which cannot be interrupted. */
  cancel: { label: string } | null;
  progress: LandmarkPanelProgress | null;
  outcome: { tone: LandmarkPanelTone; message: string } | null;
  /**
   * What a screen reader is told, once, from the live region.
   *
   * Assembled here rather than left to the markup so that the announcement and the visible text cannot describe
   * different situations — and so an idle panel announces nothing at all rather than an empty string's worth of
   * churn every render.
   */
  announcement: string;
  /** Whether pressing the primary again would plausibly achieve something. */
  retry: boolean;
};

export type LandmarkPanelInput = {
  status: TripIntelligenceStatus;
  message: string | null;
  matched: number;
  unresolved: number;
  progress: {
    checked: number;
    total: number;
    matched: number;
    unresolved: number;
    /** Completed calls, as the hook reports them. */
    call: number;
    maximumCalls: number;
  } | null;
  canRetry: boolean;
  eligibleCount: number;
  uncheckedCount: number;
  /** Whether this trip already holds landmark context, which is what decides the action. */
  hasIntelligence: boolean;
  online: boolean;
  /** A clear is being carried out. Disables both the clear trigger and its confirmation. */
  clearing?: boolean;
};

/** The phases during which a request or a write is running. */
const BUSY: ReadonlySet<TripIntelligenceStatus> =
  new Set<TripIntelligenceStatus>(["checking", "continuing", "saving"]);

/** The two phases a traveller may interrupt. `saving` is deliberately absent. */
const CANCELLABLE: ReadonlySet<TripIntelligenceStatus> =
  new Set<TripIntelligenceStatus>(["checking", "continuing"]);

/**
 * The supporting sentence, verbatim from the checkpoint.
 *
 * Four claims and a limit, and every one of them is load-bearing: which two projects are queried, that ordinary
 * hospitality is not, that the result is expected to have gaps, that images carry credits, and that no rating or
 * review is ever added. A traveller who reads this and then sees three of twelve stops enriched has been told in
 * advance that this is the normal outcome rather than a failure.
 */
export const LANDMARK_PANEL_SUPPORTING =
  "Check eligible public landmarks using Wikidata and Wikimedia Commons. Restaurants and ordinary hotels are not queried. Results may be incomplete. Images include licence and attribution. Ratings and reviews are not added.";

export function describeLandmarkPanel(
  input: LandmarkPanelInput,
): LandmarkPanelViewModel {
  const {
    status,
    message,
    progress,
    canRetry,
    eligibleCount,
    uncheckedCount,
    hasIntelligence,
    online,
    clearing = false,
  } = input;

  const action: LandmarkPanelAction = hasIntelligence ? "refresh" : "enrich";
  const busy = BUSY.has(status);

  /*
   * Two reasons a control may be unpressable, and they are different in kind.
   *
   * `intelligenceDisabledReason` answers "is there a reason to say out loud?" — offline, nothing eligible, a
   * deployment that cannot do this. `intelligenceActionIsRecoverable` answers "is this phase pressable at all?".
   * A phase can be unpressable with nothing worth saying (there is none today, and the fallback below exists so
   * that a thirteenth status added later cannot produce a silently dead button).
   */
  const reason = intelligenceDisabledReason({
    phase: status,
    action,
    online,
    eligibleCount,
    uncheckedCount,
  });

  const recoverable = intelligenceActionIsRecoverable(status);
  const disabledReason =
    reason ?? (recoverable ? null : "This lookup is not available right now.");

  return {
    heading: hasIntelligence
      ? "Landmark photos and context"
      : "Add landmark photos and context",
    supporting: LANDMARK_PANEL_SUPPORTING,
    primary: {
      action,
      /* Named for what it does, not for what state it is in. See the note on `label`. */
      label: hasIntelligence ? "Refresh landmark context" : "Check landmarks",
      disabledReason,
      busy,
    },
    /*
     * Offered only when there is something to forget.
     *
     * A "Clear landmark context" button on a trip with none would open a confirmation dialog to perform a no-op,
     * and its presence would suggest the trip holds something it does not.
     */
    clear: hasIntelligence
      ? { label: "Clear landmark context", disabled: busy || clearing }
      : null,
    cancel: CANCELLABLE.has(status) ? { label: "Cancel" } : null,
    progress: progress ? describeProgress(status, progress) : null,
    outcome: message ? { tone: toneFor(status), message } : null,
    announcement: announcementFor(status, message, progress),
    /*
     * Both halves have to hold. `canRetry` is about the last outcome and `recoverable` about the phase, and a
     * retry offered while a run is in flight would be a second run — which the hook refuses anyway, silently.
     */
    retry: canRetry && recoverable,
  };
}

function describeProgress(
  status: TripIntelligenceStatus,
  progress: NonNullable<LandmarkPanelInput["progress"]>,
): LandmarkPanelProgress {
  const { checked, total, matched, unresolved, call, maximumCalls } = progress;

  return {
    checked,
    total,
    matched,
    unresolved,
    completedCalls: call,
    maximumCalls,
    percent: honestPercent(checked, total, unresolved),
    phaseLine: phaseLineFor(status, total),
    countLine: `${checked} of ${total} ${plural(total)} checked`,
    resultLine: resultLine(matched, unresolved),
    callLine: `${call} of ${maximumCalls} requests completed`,
  };
}

/**
 * A percentage that cannot claim a finished trip.
 *
 * Capped at 99 whenever anything is unresolved, including after the run has settled: a lookup that stopped at its
 * call limit with four places unreached is not 100% of anything, and the bar is the fastest-read element in the
 * panel. Floored rather than rounded for the same reason — 11 of 12 should not read as 92% when it can read as 91%.
 */
function honestPercent(
  checked: number,
  total: number,
  unresolved: number,
): number {
  if (total <= 0) return 0;
  const raw = Math.floor((Math.min(checked, total) / total) * 100);
  return unresolved > 0 ? Math.min(raw, 99) : Math.min(raw, 100);
}

function phaseLineFor(status: TripIntelligenceStatus, total: number): string {
  switch (status) {
    case "checking":
      return `Checking ${total} ${plural(total)} against Wikidata and Wikimedia Commons.`;
    case "continuing":
      /* Says a *further bounded* check, so the wait reads as finite rather than as a stall. */
      return "Another bounded check is underway for the places not yet reached.";
    case "saving":
      /* Visibly a different activity from checking, because the Cancel button has just gone away. */
      return "Saving the landmark details found so far.";
    default:
      /* Settled. The counts stay on screen, and describing them as an activity would be untrue. */
      return "This is how far the last lookup got.";
  }
}

/** Counts, with a zero omitted rather than printed. A "0 still to reach" row is noise on a finished run. */
function resultLine(matched: number, unresolved: number): string {
  const parts: string[] = [
    `${matched} ${plural(matched)} with photos or context`,
  ];
  if (unresolved > 0) {
    parts.push(`${unresolved} still to reach`);
  }
  return parts.join(" · ");
}

function toneFor(status: TripIntelligenceStatus): LandmarkPanelTone {
  switch (status) {
    case "complete":
    case "partial":
      /*
       * A partial result is a success. It saved real answers for real places, and presenting it as a problem would
       * teach a traveller to distrust an outcome that is simply how a bounded lookup ends.
       */
      return "success";
    case "failed":
    case "conflict":
      return "problem";
    default:
      /* Everything else is a statement rather than a fault: nothing eligible, nothing new, not set up here. */
      return "notice";
  }
}

/**
 * The one sentence a screen reader hears.
 *
 * In flight it is the phase plus the counts, because "checking" alone leaves a non-visual reader with no idea
 * whether anything is happening. Settled it is the outcome, which the copy module already wrote. Idle it is empty,
 * so an untouched panel does not announce itself.
 */
function announcementFor(
  status: TripIntelligenceStatus,
  message: string | null,
  progress: LandmarkPanelInput["progress"],
): string {
  if (BUSY.has(status)) {
    const phase = phaseLineFor(status, progress?.total ?? 0);
    if (!progress) return phase;
    return `${phase} ${progress.checked} of ${progress.total} ${plural(progress.total)} checked.`;
  }
  return message ?? "";
}
