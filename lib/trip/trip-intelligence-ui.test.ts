import { describe, expect, it } from "vitest";

import {
  MAX_ENRICHMENT_CALLS,
  type EnrichmentWorkflowResult,
  type EnrichmentWorkflowStop,
} from "@/lib/api/enrich-workflow";
import type { SaveTripIntelligenceResult } from "@/lib/store/trip-intelligence";

import {
  describeSaveResult,
  describeWorkflowStop,
  intelligenceActionIsRecoverable,
  intelligenceDisabledReason,
  type TripIntelligenceStatus,
  type TripIntelligenceUiState,
} from "./trip-intelligence-ui";

/**
 * The sentences a traveller reads about landmark enrichment.
 *
 * These were three private functions inside a hook, where nothing could reach them. That is the point of the extraction,
 * and the reason this file leads with an exhaustive sweep rather than a happy path: the requirement is not "the wording is
 * nice", it is "no outcome, however it arose, can accuse a real place of being fake". A property like that is worth
 * something only if it is checked over *every* branch, and a private function admits no such check.
 */

const ALL_STOPS: EnrichmentWorkflowStop[] = [
  "complete",
  "call-limit",
  "provider-stopped",
  "no-progress",
  "aborted",
  "failed",
];

const ALL_SAVES: SaveTripIntelligenceResult[] = [
  { status: "saved", revision: 4, matched: 3 },
  { status: "saved", revision: 4, matched: 1 },
  { status: "unchanged", revision: 3 },
  { status: "conflict", actualRevision: 9 },
  { status: "missing-trip" },
  { status: "invalid", reason: "The landmark details did not parse." },
  {
    status: "storage-refused",
    reason: "This browser is out of room. Delete an old trip and try again.",
  },
];

const ALL_PHASES: TripIntelligenceStatus[] = [
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

function workflowResult(
  overrides: Partial<EnrichmentWorkflowResult> = {},
): EnrichmentWorkflowResult {
  return {
    outcomes: [],
    matched: 0,
    unresolved: 0,
    unresolvedPlaceIds: [],
    calls: 1,
    stop: "complete",
    expectedRevision: 3,
    ...overrides,
  };
}

/** Every sentence the module can produce, for the sweeps that must hold across all of them. */
function everyOutcome(): TripIntelligenceUiState[] {
  const stops = ALL_STOPS.flatMap((stop) => [
    describeWorkflowStop({
      result: workflowResult({ stop, unresolved: 0 }),
      failure: null,
    }),
    describeWorkflowStop({
      result: workflowResult({ stop, unresolved: 1 }),
      failure: null,
    }),
    describeWorkflowStop({
      result: workflowResult({ stop, unresolved: 5 }),
      failure: null,
    }),
    describeWorkflowStop({
      result: workflowResult({ stop }),
      failure: "provider_misconfigured",
    }),
  ]);

  const saves = ALL_SAVES.flatMap((saved) => [
    describeSaveResult({ saved, result: null, failure: null }),
    describeSaveResult({
      saved,
      result: workflowResult({ unresolved: 4 }),
      failure: null,
    }),
  ]);

  return [...stops, ...saves];
}

describe("no outcome blames the place, the trip, or the source", () => {
  /**
   * The vocabulary a landmark lookup may never use.
   *
   * Roamly asked an encyclopaedia and got no useful answer. Most of the world has no Wikidata entity, so an absence is the
   * ordinary case — and a traveller told their itinerary "could not be verified" would reasonably start deleting real
   * restaurants they had chosen on purpose.
   */
  const FORBIDDEN = [
    "fake",
    "invalid",
    "does not exist",
    "doesn't exist",
    "no such place",
    "closed",
    "deleted",
    "could not be verified",
    "unverified",
    "wrong",
    "incorrect",
    "not a real",
    "made up",
  ];

  it("never uses a word that accuses the itinerary", () => {
    for (const outcome of everyOutcome()) {
      const lower = outcome.message.toLowerCase();
      for (const word of FORBIDDEN) {
        expect(lower, outcome.message).not.toContain(word);
      }
    }
  });

  it("never leaks a status code, a host, or a provider error", () => {
    /*
     * The traveller-facing half of the security requirement. `provider_misconfigured` is our own route's code and it must
     * stay ours: no number, no URL and no snake_case identifier reaches a sentence.
     */
    for (const outcome of everyOutcome()) {
      expect(outcome.message).not.toMatch(/\b(4\d\d|5\d\d)\b/);
      expect(outcome.message).not.toMatch(/https?:\/\//);
      expect(outcome.message).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it("never names an environment variable or a configuration value", () => {
    /* "Setup is incomplete" is the whole permitted content. A deployment does not narrate its own configuration. */
    for (const outcome of everyOutcome()) {
      const lower = outcome.message.toLowerCase();
      expect(lower).not.toContain("env");
      expect(lower).not.toContain("variable");
      expect(lower).not.toContain("roamly_");
      expect(lower).not.toContain("api key");
      expect(lower).not.toContain("token");
    }
  });

  it("gives every outcome a sentence a person could read aloud", () => {
    for (const outcome of everyOutcome()) {
      expect(outcome.message.length).toBeGreaterThan(20);
      expect(outcome.message.trim()).toBe(outcome.message);
      expect(outcome.message).toMatch(/[.!]$/);
    }
  });
});

describe("a run that wrote nothing", () => {
  it("reports an incomplete deployment as itself, and does not invite a retry", () => {
    const outcome = describeWorkflowStop({
      result: workflowResult({ stop: "failed" }),
      failure: "provider_misconfigured",
    });

    expect(outcome.phase).toBe("unconfigured");
    expect(outcome.message).toContain("not set up");
    /* The same answer every time, so a retry button would be a button that lies. */
    expect(outcome.canRetry).toBe(false);
  });

  it("states the exact number of places a call limit left unchecked", () => {
    /* The sentence that must never round up. Claiming a whole trip was checked is the dishonesty forbidden here. */
    const outcome = describeWorkflowStop({
      result: workflowResult({ stop: "call-limit", unresolved: 5 }),
      failure: null,
    });

    expect(outcome.message).toContain("5 places");
    expect(outcome.message).toContain(String(MAX_ENRICHMENT_CALLS));
    expect(outcome.message).toContain("Nothing in this trip was changed");
    expect(outcome.canRetry).toBe(true);
  });

  it("uses the singular when exactly one place was left", () => {
    const outcome = describeWorkflowStop({
      result: workflowResult({ stop: "call-limit", unresolved: 1 }),
      failure: null,
    });

    expect(outcome.message).toContain("1 place ");
    expect(outcome.message).not.toContain("1 places");
  });

  it("describes a rate limit as being asked to slow down", () => {
    const outcome = describeWorkflowStop({
      result: workflowResult({ stop: "provider-stopped", unresolved: 2 }),
      failure: null,
    });

    expect(outcome.phase).toBe("empty");
    expect(outcome.message).toContain("slow down");
    /* Not a fault on either side. Being asked to wait is a normal part of using a volunteer service. */
    expect(outcome.message.toLowerCase()).not.toContain("error");
    expect(outcome.canRetry).toBe(true);
  });

  it("names Wikidata's coverage rather than the places, when nothing was found", () => {
    const outcome = describeWorkflowStop({
      result: workflowResult({ stop: "complete", unresolved: 0 }),
      failure: null,
    });

    expect(outcome.phase).toBe("empty");
    expect(outcome.message).toContain("do not cover every place");
    /* A finished answer, not an interruption: asking again searches the same two sources for the same places. */
    expect(outcome.canRetry).toBe(false);
  });

  it("never reports a stop as saved, because nothing was written", () => {
    /*
     * `partial` means "saved, with gaps". A run that wrote nothing has no saved half to report, and calling it partial
     * would claim a write that never happened.
     */
    for (const stop of ALL_STOPS) {
      const outcome = describeWorkflowStop({
        result: workflowResult({ stop, unresolved: 3 }),
        failure: null,
      });
      expect(outcome.phase, stop).not.toBe("partial");
      expect(outcome.phase, stop).not.toBe("complete");
      expect(outcome.matched, stop).toBe(0);
    }
  });
});

describe("the one write", () => {
  it("reports a full save as complete", () => {
    const outcome = describeSaveResult({
      saved: { status: "saved", revision: 4, matched: 3 },
      result: workflowResult({ unresolved: 0 }),
      failure: null,
    });

    expect(outcome.phase).toBe("complete");
    expect(outcome.matched).toBe(3);
    expect(outcome.message).toContain("3 places");
    expect(outcome.canRetry).toBe(false);
  });

  it("reports a save with gaps as partial, with both counts", () => {
    const outcome = describeSaveResult({
      saved: { status: "saved", revision: 4, matched: 8 },
      result: workflowResult({ unresolved: 4 }),
      failure: null,
    });

    expect(outcome.phase).toBe("partial");
    expect(outcome.message).toContain("8 places");
    expect(outcome.message).toContain("4 places");
    /* Something is left to try, which is the difference between this and a complete run. */
    expect(outcome.canRetry).toBe(true);
  });

  it("counts what the store wrote, not what the workflow received", () => {
    /* A workflow can receive an outcome the store refuses to persist. The traveller is told the saved number. */
    const outcome = describeSaveResult({
      saved: { status: "saved", revision: 4, matched: 2 },
      result: workflowResult({ matched: 5, unresolved: 0 }),
      failure: null,
    });

    expect(outcome.matched).toBe(2);
    expect(outcome.message).toContain("2 places");
    expect(outcome.message).not.toContain("5");
  });

  it("says an empty refresh removed nothing", () => {
    /*
     * The requirement behind this sentence: an empty refresh must not read as having erased what was already there. The
     * store was never asked to remove anything, and a traveller cannot see that for themselves.
     */
    const outcome = describeSaveResult({
      saved: { status: "unchanged", revision: 3 },
      result: workflowResult(),
      failure: null,
    });

    expect(outcome.phase).toBe("empty");
    expect(outcome.message).toContain("still there");
    expect(outcome.canRetry).toBe(false);
  });

  it("explains a conflict as the local trip having changed, and advises a reload", () => {
    const outcome = describeSaveResult({
      saved: { status: "conflict", actualRevision: 9 },
      result: workflowResult({ unresolved: 2 }),
      failure: null,
    });

    expect(outcome.phase).toBe("conflict");
    expect(outcome.message).toContain("changed in another tab");
    expect(outcome.message).toContain("nothing was saved");
    /* Reload, not retry — the copy in this browser is behind. */
    expect(outcome.canRetry).toBe(false);
  });

  it("passes the storage refusal's own sentence through", () => {
    const reason =
      "This browser is out of room. Delete an old trip and try again.";
    const outcome = describeSaveResult({
      saved: { status: "storage-refused", reason },
      result: workflowResult(),
      failure: null,
    });

    expect(outcome.message).toBe(reason);
    /* Pressing again before freeing room fails identically. */
    expect(outcome.canRetry).toBe(false);
  });

  it("never claims a save that did not happen", () => {
    for (const saved of ALL_SAVES) {
      const outcome = describeSaveResult({
        saved,
        result: workflowResult({ unresolved: 2 }),
        failure: null,
      });

      if (saved.status !== "saved") {
        expect(outcome.matched, saved.status).toBe(0);
        expect(outcome.phase, saved.status).not.toBe("complete");
        expect(outcome.phase, saved.status).not.toBe("partial");
      }
    }
  });
});

describe("why a control is disabled", () => {
  const ready = {
    phase: "idle" as const,
    action: "enrich" as const,
    online: true,
    eligibleCount: 4,
    uncheckedCount: 4,
  };

  it("gives no reason when the action is available", () => {
    expect(intelligenceDisabledReason(ready)).toBeNull();
  });

  it("names the run in progress before anything else", () => {
    for (const phase of ["checking", "continuing"] as const) {
      expect(intelligenceDisabledReason({ ...ready, phase })).toContain(
        "already running",
      );
    }
    expect(intelligenceDisabledReason({ ...ready, phase: "saving" })).toContain(
      "Saving",
    );
  });

  it("prefers the trip's own limitation over the network", () => {
    /*
     * Both hold, and only one is actionable. Reconnecting does not put a museum into an itinerary of restaurants, so
     * naming the network would send somebody to fix the wrong thing.
     */
    const reason = intelligenceDisabledReason({
      ...ready,
      online: false,
      eligibleCount: 0,
      uncheckedCount: 0,
    });

    expect(reason).toContain("no public landmarks");
    expect(reason).not.toContain("connection");
  });

  it("explains that ordinary hotels and restaurants are out of scope", () => {
    /* Otherwise the absence reads as a bug rather than as the deliberate scope it is. */
    const reason = intelligenceDisabledReason({
      ...ready,
      eligibleCount: 0,
      uncheckedCount: 0,
    });

    expect(reason).toContain("Restaurants and ordinary hotels are not queried");
  });

  it("names both services when offline", () => {
    const reason = intelligenceDisabledReason({ ...ready, online: false });

    expect(reason).toContain("Wikidata");
    expect(reason).toContain("Wikimedia Commons");
  });

  it("points at refresh when there is nothing new to check", () => {
    const reason = intelligenceDisabledReason({ ...ready, uncheckedCount: 0 });

    expect(reason).toContain("already been looked up");
    expect(reason).toContain("refresh");
  });

  it("does not disable refresh merely because everything is already known", () => {
    /* Refresh exists precisely for the case where an entry is already there and a traveller believes it is wrong. */
    expect(
      intelligenceDisabledReason({
        ...ready,
        action: "refresh",
        uncheckedCount: 0,
      }),
    ).toBeNull();
  });

  it("explains an incomplete deployment without naming any configuration", () => {
    const reason = intelligenceDisabledReason({
      ...ready,
      phase: "unconfigured",
    });

    expect(reason).toContain("not set up");
    expect(reason?.toLowerCase()).not.toContain("env");
    expect(reason?.toLowerCase()).not.toContain("key");
  });
});

describe("whether the control may be pressed at all", () => {
  it("refuses while a request or a write is in flight", () => {
    for (const phase of ["checking", "continuing", "saving"] as const) {
      expect(intelligenceActionIsRecoverable(phase), phase).toBe(false);
    }
  });

  it("refuses when pressing could not possibly work", () => {
    for (const phase of [
      "unconfigured",
      "no-eligible-landmarks",
      "offline",
    ] as const) {
      expect(intelligenceActionIsRecoverable(phase), phase).toBe(false);
    }
  });

  it("allows a retry after every settled outcome, including a conflict", () => {
    /*
     * A conflict is where this and `canRetry` deliberately disagree. The revision is re-read on the next press, so
     * pressing again *can* succeed — the advice to reload is advice, not a lock, and disabling the button would strand a
     * traveller whose other tab has since closed.
     */
    for (const phase of [
      "idle",
      "complete",
      "partial",
      "empty",
      "failed",
      "conflict",
    ] as const) {
      expect(intelligenceActionIsRecoverable(phase), phase).toBe(true);
    }
  });

  it("has an answer for every phase", () => {
    /* No phase falls through to `undefined`, which a panel would render as an enabled button. */
    for (const phase of ALL_PHASES) {
      expect(typeof intelligenceActionIsRecoverable(phase), phase).toBe(
        "boolean",
      );
    }
  });
});
