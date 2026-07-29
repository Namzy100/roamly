import { describe, expect, it } from "vitest";

import { MAX_ENRICHMENT_CALLS } from "@/lib/api/enrich-workflow";

import {
  LANDMARK_PANEL_SUPPORTING,
  describeLandmarkPanel,
  type LandmarkPanelInput,
} from "./landmark-panel";
import type { TripIntelligenceStatus } from "./trip-intelligence-ui";

/**
 * The panel's decisions, enumerated.
 *
 * Every state a traveller can see is reachable from a plain object here, which is the point of the view model: the
 * component has no branches left to get wrong, so a suite with no DOM can still assert that `saving` offers no
 * Cancel, that a call-limited run never renders a full bar, and that a trip with nothing to clear offers no clear
 * button. What is left for the browser is focus, Escape, ARIA wiring and the requests themselves.
 */

/** All twelve, so a sweep cannot quietly skip one. */
const ALL_STATUSES: TripIntelligenceStatus[] = [
  "idle",
  "no-eligible-landmarks",
  "offline",
  "unconfigured",
  "checking",
  "continuing",
  "saving",
  "complete",
  "partial",
  "empty",
  "failed",
  "conflict",
];

function input(
  overrides: Partial<LandmarkPanelInput> = {},
): LandmarkPanelInput {
  return {
    status: "idle",
    message: null,
    matched: 0,
    unresolved: 0,
    progress: null,
    canRetry: false,
    eligibleCount: 4,
    uncheckedCount: 4,
    hasIntelligence: false,
    online: true,
    ...overrides,
  };
}

function progress(
  overrides: Partial<NonNullable<LandmarkPanelInput["progress"]>> = {},
) {
  return {
    checked: 0,
    total: 12,
    matched: 0,
    unresolved: 12,
    call: 0,
    maximumCalls: MAX_ENRICHMENT_CALLS,
    ...overrides,
  };
}

describe("the two shapes of the panel", () => {
  it("offers to add context, with the standing explanation, when there is none", () => {
    const panel = describeLandmarkPanel(input());

    expect(panel.heading).toBe("Add landmark photos and context");
    expect(panel.supporting).toBe(LANDMARK_PANEL_SUPPORTING);
    expect(panel.primary.action).toBe("enrich");
    expect(panel.primary.disabledReason).toBeNull();
    /* Nothing to forget, so nothing offers to forget it. */
    expect(panel.clear).toBeNull();
  });

  it("offers refresh and clear once the trip holds context", () => {
    const panel = describeLandmarkPanel(
      input({ hasIntelligence: true, uncheckedCount: 0 }),
    );

    expect(panel.heading).toBe("Landmark photos and context");
    expect(panel.primary.action).toBe("refresh");
    expect(panel.primary.label).toBe("Refresh landmark context");
    expect(panel.clear).toEqual({
      label: "Clear landmark context",
      disabled: false,
    });
  });

  /**
   * The supporting copy states the scope in both directions and rules out the one thing travellers most expect a
   * "photos and context" feature to add.
   */
  it("says what is queried, what is not, and what is never added", () => {
    for (const claim of [
      "Wikidata",
      "Wikimedia Commons",
      "Restaurants and ordinary hotels are not queried",
      "may be incomplete",
      "licence and attribution",
      "Ratings and reviews are not added",
    ]) {
      expect(LANDMARK_PANEL_SUPPORTING, claim).toContain(claim);
    }
  });

  it("keeps the standing explanation in every state", () => {
    for (const status of ALL_STATUSES) {
      const panel = describeLandmarkPanel(input({ status }));
      expect(panel.supporting, status).toBe(LANDMARK_PANEL_SUPPORTING);
    }
  });
});

describe("the states that cannot be acted on", () => {
  it("explains a trip with no public landmarks without naming the network", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "no-eligible-landmarks",
        eligibleCount: 0,
        uncheckedCount: 0,
      }),
    );

    expect(panel.primary.disabledReason).toContain("no public landmarks");
    expect(panel.primary.disabledReason).toContain("Restaurants");
    expect(panel.primary.disabledReason).not.toContain("connection");
    expect(panel.retry).toBe(false);
  });

  it("names the two services a lookup needs when offline", () => {
    const panel = describeLandmarkPanel(
      input({ status: "offline", online: false }),
    );

    expect(panel.primary.disabledReason).toContain("needs a connection");
    expect(panel.primary.disabledReason).toContain("Wikidata");
  });

  /**
   * A trip whose landmarks are all ineligible must still be told the itinerary is the problem when it is —
   * reconnecting cannot put a museum into a trip of restaurants.
   */
  it("prefers the itinerary explanation to the network one when both hold", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "no-eligible-landmarks",
        eligibleCount: 0,
        uncheckedCount: 0,
        online: false,
      }),
    );

    expect(panel.primary.disabledReason).toContain("no public landmarks");
  });

  it("says setup is incomplete without naming a single configuration value", () => {
    const panel = describeLandmarkPanel(input({ status: "unconfigured" }));
    const reason = panel.primary.disabledReason ?? "";

    expect(reason).toContain("not set up on this deployment");
    for (const leak of ["ROAMLY", "env", "variable", "key", "http"]) {
      expect(reason.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
    expect(panel.retry).toBe(false);
  });

  it("points an already-checked trip at refresh rather than at nothing", () => {
    const panel = describeLandmarkPanel(input({ uncheckedCount: 0 }));

    expect(panel.primary.disabledReason).toContain("already been looked up");
    expect(panel.primary.disabledReason).toContain("refresh");
  });

  /** No status may produce a button that is unpressable with nothing said about why. */
  it("never leaves a control dead and silent", () => {
    for (const status of ALL_STATUSES) {
      const panel = describeLandmarkPanel(
        input({ status, online: status !== "offline", eligibleCount: 4 }),
      );
      const pressable = panel.primary.disabledReason === null;
      expect(
        pressable || (panel.primary.disabledReason ?? "").length > 20,
        status,
      ).toBe(true);
    }
  });
});

describe("while a lookup is running", () => {
  it("reports the first call as checking, with the total it will cover", () => {
    const panel = describeLandmarkPanel(
      input({ status: "checking", progress: progress() }),
    );

    expect(panel.primary.busy).toBe(true);
    expect(panel.progress?.phaseLine).toContain("Checking 12 places");
    expect(panel.progress?.countLine).toBe("0 of 12 places checked");
    expect(panel.cancel).toEqual({ label: "Cancel" });
  });

  it("says a continuation is a further bounded check", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "continuing",
        progress: progress({ checked: 6, matched: 4, unresolved: 6, call: 1 }),
      }),
    );

    expect(panel.progress?.phaseLine).toContain("bounded check is underway");
    expect(panel.cancel).not.toBeNull();
  });

  /** The save is a different activity, and it is the one that must not be interrupted. */
  it("makes saving distinct from checking and withdraws Cancel", () => {
    const checking = describeLandmarkPanel(
      input({ status: "checking", progress: progress() }),
    );
    const saving = describeLandmarkPanel(
      input({
        status: "saving",
        progress: progress({ checked: 12, matched: 5, unresolved: 0, call: 2 }),
      }),
    );

    expect(saving.progress?.phaseLine).toContain("Saving");
    expect(saving.progress?.phaseLine).not.toBe(checking.progress?.phaseLine);
    expect(saving.primary.busy).toBe(true);
    expect(saving.cancel).toBeNull();
  });

  it("offers Cancel in exactly the two interruptible states", () => {
    const cancellable = ALL_STATUSES.filter(
      (status) =>
        describeLandmarkPanel(input({ status, progress: progress() }))
          .cancel !== null,
    );

    expect(cancellable).toEqual(["checking", "continuing"]);
  });

  it("disables clearing while a run is in flight", () => {
    for (const status of ["checking", "continuing", "saving"] as const) {
      const panel = describeLandmarkPanel(
        input({ status, hasIntelligence: true }),
      );
      expect(panel.clear?.disabled, status).toBe(true);
    }
  });

  it("disables clearing while a clear is being carried out", () => {
    const panel = describeLandmarkPanel(
      input({ hasIntelligence: true, clearing: true }),
    );

    expect(panel.clear?.disabled).toBe(true);
  });

  it("offers no retry mid-run, whatever the last outcome said", () => {
    for (const status of ["checking", "continuing", "saving"] as const) {
      const panel = describeLandmarkPanel(input({ status, canRetry: true }));
      expect(panel.retry, status).toBe(false);
    }
  });

  it("keeps the button's name the same in flight as at rest", () => {
    const rest = describeLandmarkPanel(input({ hasIntelligence: true }));
    const running = describeLandmarkPanel(
      input({
        hasIntelligence: true,
        status: "continuing",
        progress: progress(),
      }),
    );

    expect(running.primary.label).toBe(rest.primary.label);
  });
});

describe("the progress figures", () => {
  it("labels the call count as completed requests, never as the current one", () => {
    const panel = describeLandmarkPanel(
      input({ status: "continuing", progress: progress({ call: 1 }) }),
    );

    expect(panel.progress?.callLine).toBe(
      `1 of ${MAX_ENRICHMENT_CALLS} requests completed`,
    );
    expect(panel.progress?.completedCalls).toBe(1);
    expect(panel.progress?.callLine).not.toMatch(/current|request 1|now/i);
  });

  /**
   * The single most important number in the panel. Every place has an answer and four of those answers were
   * "we could not reach this" — a full bar there is the claim this checkpoint forbids.
   */
  it("never reaches 100% while anything is unresolved", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "partial",
        progress: progress({
          checked: 12,
          total: 12,
          matched: 8,
          unresolved: 4,
        }),
      }),
    );

    expect(panel.progress?.percent).toBe(99);
  });

  it("reaches 100% only when nothing is left unresolved", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "complete",
        progress: progress({
          checked: 12,
          total: 12,
          matched: 12,
          unresolved: 0,
        }),
      }),
    );

    expect(panel.progress?.percent).toBe(100);
  });

  it("floors the percentage rather than rounding it up", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "continuing",
        progress: progress({ checked: 11, total: 12, unresolved: 1 }),
      }),
    );

    /* 11/12 is 91.6%, and 92% would be a rounded-up claim about a place not yet reached. */
    expect(panel.progress?.percent).toBe(91);
  });

  it("reports zero rather than dividing by an empty total", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "checking",
        progress: progress({ total: 0, unresolved: 0 }),
      }),
    );

    expect(panel.progress?.percent).toBe(0);
  });

  it("shows the exact counts a partial run produced", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "partial",
        matched: 8,
        unresolved: 4,
        progress: progress({
          checked: 8,
          total: 12,
          matched: 8,
          unresolved: 4,
          call: 3,
        }),
      }),
    );

    expect(panel.progress?.countLine).toBe("8 of 12 places checked");
    expect(panel.progress?.resultLine).toBe(
      "8 places with photos or context · 4 still to reach",
    );
    expect(panel.progress?.matched).toBe(8);
    expect(panel.progress?.unresolved).toBe(4);
  });

  it("drops the unresolved half of the line when nothing is outstanding", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "complete",
        progress: progress({ checked: 3, total: 3, matched: 3, unresolved: 0 }),
      }),
    );

    expect(panel.progress?.resultLine).toBe("3 places with photos or context");
    expect(panel.progress?.resultLine).not.toContain("0");
  });

  it("says place in the singular when there is one", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "complete",
        progress: progress({ checked: 1, total: 1, matched: 1, unresolved: 0 }),
      }),
    );

    expect(panel.progress?.countLine).toBe("1 of 1 place checked");
    expect(panel.progress?.resultLine).toBe("1 place with photos or context");
  });

  it("renders no progress region before anything has been pressed", () => {
    expect(describeLandmarkPanel(input()).progress).toBeNull();
  });

  /** After a settled run the counts stay, but they stop describing an activity. */
  it("stops calling the figures live once the run has settled", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "empty",
        progress: progress({ checked: 4, total: 12, unresolved: 8, call: 3 }),
      }),
    );

    expect(panel.progress?.phaseLine).toContain("how far the last lookup got");
    expect(panel.progress?.checked).toBe(4);
  });
});

describe("the settled outcomes", () => {
  it("reads a complete run as a success", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "complete",
        message: "Added photos and context for 3 places.",
      }),
    );

    expect(panel.outcome).toEqual({
      tone: "success",
      message: "Added photos and context for 3 places.",
    });
  });

  /** A partial run saved real answers for real places. Presenting it as a fault teaches distrust. */
  it("reads a partial run as a success too", () => {
    const panel = describeLandmarkPanel(
      input({ status: "partial", message: "…", canRetry: true }),
    );

    expect(panel.outcome?.tone).toBe("success");
    expect(panel.retry).toBe(true);
  });

  it("reads nothing-found as a notice rather than a fault", () => {
    const panel = describeLandmarkPanel(
      input({ status: "empty", message: "…" }),
    );

    expect(panel.outcome?.tone).toBe("notice");
  });

  it("reads a failure and a conflict as problems", () => {
    for (const status of ["failed", "conflict"] as const) {
      const panel = describeLandmarkPanel(input({ status, message: "…" }));
      expect(panel.outcome?.tone, status).toBe("problem");
    }
  });

  /**
   * A conflict is pressable and still offers no retry: the honest advice is to reload, because the copy in this
   * browser is behind. The pair `canRetry` / recoverable is what carries that distinction.
   */
  it("presses a conflict without inviting a retry", () => {
    const panel = describeLandmarkPanel(
      input({ status: "conflict", message: "…", canRetry: false }),
    );

    expect(panel.primary.disabledReason).toBeNull();
    expect(panel.retry).toBe(false);
  });

  it("passes the outcome sentence through untouched", () => {
    const message =
      "The lookup stopped after 3 requests with 5 places still unchecked.";
    const panel = describeLandmarkPanel(input({ status: "empty", message }));

    expect(panel.outcome?.message).toBe(message);
  });

  it("renders no outcome region when there is nothing to report", () => {
    expect(describeLandmarkPanel(input()).outcome).toBeNull();
  });
});

describe("what a retry does", () => {
  /** The action follows the trip, not the failure: a trip with context refreshes, a trip without it enriches. */
  it("retries with enrich when the trip holds no context yet", () => {
    const panel = describeLandmarkPanel(
      input({ status: "failed", message: "…", canRetry: true }),
    );

    expect(panel.retry).toBe(true);
    expect(panel.primary.action).toBe("enrich");
  });

  it("retries with refresh when the trip already holds context", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "failed",
        message: "…",
        canRetry: true,
        hasIntelligence: true,
        uncheckedCount: 0,
      }),
    );

    expect(panel.retry).toBe(true);
    expect(panel.primary.action).toBe("refresh");
  });

  /** A refresh is never blocked by "everything is already looked up" — that is what it is for. */
  it("leaves refresh pressable when every landmark is already known", () => {
    const panel = describeLandmarkPanel(
      input({ hasIntelligence: true, uncheckedCount: 0, eligibleCount: 6 }),
    );

    expect(panel.primary.disabledReason).toBeNull();
  });

  it("offers no retry from a state that cannot act at all", () => {
    for (const status of [
      "unconfigured",
      "no-eligible-landmarks",
      "offline",
    ] as const) {
      const panel = describeLandmarkPanel(
        input({ status, canRetry: true, online: status !== "offline" }),
      );
      expect(panel.retry, status).toBe(false);
    }
  });
});

describe("what a screen reader hears", () => {
  it("announces the phase and the counts while running", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "continuing",
        progress: progress({ checked: 6, total: 12, unresolved: 6, call: 1 }),
      }),
    );

    expect(panel.announcement).toContain("bounded check");
    expect(panel.announcement).toContain("6 of 12 places checked");
  });

  it("announces the outcome once the run settles", () => {
    const panel = describeLandmarkPanel(
      input({
        status: "complete",
        message: "Added photos and context for 2 places.",
      }),
    );

    expect(panel.announcement).toBe("Added photos and context for 2 places.");
  });

  it("announces nothing at all before anything is pressed", () => {
    expect(describeLandmarkPanel(input()).announcement).toBe("");
  });

  it("still announces a phase when a run has no figures yet", () => {
    const panel = describeLandmarkPanel(
      input({ status: "saving", progress: null }),
    );

    expect(panel.announcement).toContain("Saving");
  });
});

describe("every state produces something renderable", () => {
  it("gives all twelve a heading, a label and a coherent busy flag", () => {
    for (const status of ALL_STATUSES) {
      const panel = describeLandmarkPanel(
        input({ status, progress: progress(), message: "…" }),
      );

      expect(panel.heading.length, status).toBeGreaterThan(10);
      expect(panel.primary.label.length, status).toBeGreaterThan(5);
      /* Cancel is only ever offered while something is running. */
      expect(panel.cancel === null || panel.primary.busy, status).toBe(true);
      /* And a busy panel is never simultaneously pressable. */
      expect(
        !panel.primary.busy || panel.primary.disabledReason !== null,
        status,
      ).toBe(true);
    }
  });

  /** Nothing the panel adds may name a code, a host or an identifier. */
  it("keeps panel vocabulary free of codes, hosts and identifiers", () => {
    const sentences = ALL_STATUSES.flatMap((status) => {
      const panel = describeLandmarkPanel(
        input({
          status,
          progress: progress({
            checked: 4,
            matched: 2,
            unresolved: 8,
            call: 1,
          }),
        }),
      );
      return [
        panel.heading,
        panel.supporting,
        panel.primary.label,
        panel.clear?.label ?? "",
        panel.cancel?.label ?? "",
        panel.progress?.phaseLine ?? "",
        panel.progress?.countLine ?? "",
        panel.progress?.resultLine ?? "",
        panel.progress?.callLine ?? "",
      ];
    });

    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/\b(4\d\d|5\d\d)\b/);
      expect(sentence).not.toMatch(/https?:\/\//);
      expect(sentence).not.toMatch(/[a-z]+_[a-z]+/);
      expect(sentence.toLowerCase()).not.toContain("token");
    }
  });
});
