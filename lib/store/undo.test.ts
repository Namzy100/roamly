import { describe, expect, it } from "vitest";

import { mockTripPlan } from "@/lib/mock/lisbon-trip";
import { FIXTURE_GENERATION } from "@/lib/refinement/test-fixtures";
import type { TripPlan } from "@/lib/schemas";

import { MAX_HISTORY_ENTRIES } from "./history";
import {
  TripRecordSchema,
  createTripRecord,
  nextRevision,
  parseStoredRecord,
  withRestoredState,
  withoutHistory,
} from "./trip-record";

/**
 * Undo at the record level.
 *
 * `./history.test.ts` covers the stacks themselves — trimming, stepping, the byte budget. This file
 * covers the questions only the *record* can answer, and the first two pull in opposite directions:
 *
 *  - a reversible change must capture the state it replaced, in the same write, so a trip can never
 *    exist in a state where it was changed and the way back was lost
 *  - a **routing** write must not consume a step, because undoing a route calculation would discard
 *    real measurements for nothing and would cost the traveller a step they earned elsewhere
 *
 * `nextRevision`'s last argument is the whole mechanism, which is why both of its values are tested.
 *
 * Then the question that is new in v3: a browser not opened since the schema changed still holds a
 * v2 record, and its owner must not lose the undo they already had.
 */

const NOW = "2026-07-27T10:00:00.000Z";
const LATER = "2026-07-27T10:05:00.000Z";

/** A plan that differs from the mock, so a restore is visible. */
const CHANGED_PLAN: TripPlan = {
  ...mockTripPlan,
  practicalNotes: ["Refined — this note replaced the original set."],
};

describe("recording a step", () => {
  it("is empty on a new trip", () => {
    const record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);

    expect(record.history).toEqual({ past: [], future: [] });
  });

  it("captures the state being replaced", () => {
    const record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);

    const next = nextRevision(record, CHANGED_PLAN, LATER, FIXTURE_GENERATION, {
      label: "Replace stop",
      kind: "refinement",
    });

    expect(next.revision).toBe(2);
    expect(next.plan).toBe(CHANGED_PLAN);
    expect(next.history.past).toHaveLength(1);

    const [entry] = next.history.past;
    expect(entry.plan).toBe(mockTripPlan);
    expect(entry.label).toBe("Replace stop");
    expect(entry.beforeRevision).toBe(1);
    expect(entry.afterRevision).toBe(2);
  });

  /**
   * The saving measured in Checkpoint 3, enforced where it is decided.
   *
   * A structural edit cannot change the pool, so its entry must not carry one: a 127-place context
   * is several times the size of the plan beside it, and twenty of them is the difference between a
   * 206 KB history and a 1.2 MB one.
   */
  it("omits the generation context on an edit that cannot change it", () => {
    const record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);

    const next = nextRevision(record, CHANGED_PLAN, LATER, FIXTURE_GENERATION, {
      label: "Change time",
      kind: "structural-edit",
    });

    expect(next.history.past[0].generationContext).toBeUndefined();
  });

  it("carries the generation context on an edit that can", () => {
    const record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);

    const next = nextRevision(record, CHANGED_PLAN, LATER, FIXTURE_GENERATION, {
      label: "Refresh available places",
      kind: "pool-refresh",
    });

    expect(next.history.past[0].generationContext).toBe(FIXTURE_GENERATION);
  });

  /** The Phase 6A rule, unchanged: routing adds facts and takes nothing away. */
  it("does not consume a step for a routing write", () => {
    const record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);
    const edited = nextRevision(record, CHANGED_PLAN, LATER, FIXTURE_GENERATION, {
      label: "Replace stop",
      kind: "refinement",
    });

    const routed = nextRevision(edited, mockTripPlan, LATER);

    expect(routed.revision).toBe(3);
    expect(routed.history.past).toHaveLength(1);
    expect(routed.history.past[0].label).toBe("Replace stop");
  });

  /**
   * Both bounds, on the plan a real visitor actually sees.
   *
   * The sample Lisbon trip is a five-day itinerary, several times the size of the two-day fixture
   * the budget was measured against — so it is the **byte** bound that bites here, not the count,
   * and the history settles well short of twenty. That is the dual bound working rather than
   * failing, and it is exactly why the interface reports actual depth: promising twenty would be a
   * lie on this trip.
   *
   * Asserted as a range rather than a number, because the exact depth is a property of the fixture
   * and would turn every future edit to the sample trip into a failure here.
   */
  it("bounds a large trip's history by bytes, keeping the newest steps", () => {
    let record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);

    for (let i = 0; i < MAX_HISTORY_ENTRIES + 6; i += 1) {
      record = nextRevision(record, CHANGED_PLAN, LATER, FIXTURE_GENERATION, {
        label: `Edit ${i}`,
        kind: "structural-edit",
      });
    }

    expect(record.history.past.length).toBeGreaterThan(0);
    expect(record.history.past.length).toBeLessThan(MAX_HISTORY_ENTRIES);
    // Whichever bound bit, the steps kept are the most recent ones.
    expect(record.history.past.at(-1)?.label).toBe(
      `Edit ${MAX_HISTORY_ENTRIES + 5}`,
    );
    console.log(
      `  sample trip keeps ${record.history.past.length} steps within the byte budget`,
    );
  });
});

describe("withRestoredState", () => {
  /**
   * The revision goes **forward** on the way back.
   *
   * Decrementing would make two different states share a revision number, and an in-flight save
   * captured before the undo would then be accepted after it — precisely what the guard prevents.
   */
  it("moves the revision forward, not back", () => {
    const record = nextRevision(
      createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION),
      CHANGED_PLAN,
      LATER,
      FIXTURE_GENERATION,
      { label: "Replace stop", kind: "refinement" },
    );

    const restored = withRestoredState(
      record,
      { plan: mockTripPlan, generation: FIXTURE_GENERATION },
      { past: [], future: [] },
      LATER,
    );

    expect(restored.revision).toBe(record.revision + 1);
    expect(restored.plan).toBe(mockTripPlan);
    expect(restored.createdAt).toBe(record.createdAt);
  });
});

describe("withoutHistory", () => {
  it("empties both stacks and touches nothing else", () => {
    const record = nextRevision(
      createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION),
      CHANGED_PLAN,
      LATER,
      FIXTURE_GENERATION,
      { label: "Replace stop", kind: "refinement" },
    );

    const dropped = withoutHistory(record);

    expect(dropped.history).toEqual({ past: [], future: [] });
    expect(dropped.revision).toBe(record.revision);
    expect(dropped.plan).toBe(record.plan);
  });
});

describe("parseStoredRecord", () => {
  it("reads a current record unchanged", () => {
    const record = createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION);

    expect(parseStoredRecord(JSON.parse(JSON.stringify(record)))).toMatchObject({
      revision: 1,
      history: { past: [], future: [] },
    });
  });

  /**
   * The upgrade a real browser will perform.
   *
   * A v2 record's single snapshot becomes one past entry, so somebody who had an undo available
   * before the schema changed still has it afterwards. Defaulting to an empty history would parse
   * cleanly and quietly take it away, which is why the legacy shape is detected rather than left to
   * fail.
   */
  it("folds a v2 snapshot into one past entry", () => {
    const legacy = {
      revision: 4,
      createdAt: NOW,
      updatedAt: LATER,
      plan: CHANGED_PLAN,
      generation: FIXTURE_GENERATION,
      previousSnapshot: {
        plan: mockTripPlan,
        generation: FIXTURE_GENERATION,
        revision: 3,
        createdAt: NOW,
        action: "Replace stop",
      },
    };

    const parsed = parseStoredRecord(JSON.parse(JSON.stringify(legacy)));

    expect(parsed?.revision).toBe(4);
    expect(parsed?.history.past).toHaveLength(1);
    expect(parsed?.history.past[0].label).toBe("Replace stop");
    expect(parsed?.history.past[0].beforeRevision).toBe(3);
    expect(parsed?.history.past[0].kind).toBe("refinement");
    // A refinement could replace the pool, so the converted entry keeps the context.
    expect(parsed?.history.past[0].generationContext).not.toBeUndefined();
    expect(parsed?.history.future).toEqual([]);
  });

  it("reads a v2 record that never had a snapshot", () => {
    const legacy = {
      revision: 2,
      createdAt: NOW,
      updatedAt: LATER,
      plan: mockTripPlan,
      generation: null,
      previousSnapshot: null,
    };

    expect(
      parseStoredRecord(JSON.parse(JSON.stringify(legacy)))?.history,
    ).toEqual({ past: [], future: [] });
  });

  it("wraps a bare v1 plan at revision 1", () => {
    const parsed = parseStoredRecord(JSON.parse(JSON.stringify(mockTripPlan)));

    expect(parsed?.revision).toBe(1);
    expect(parsed?.plan.id).toBe(mockTripPlan.id);
    expect(parsed?.history).toEqual({ past: [], future: [] });
  });

  it("returns null for something that is not a record at all", () => {
    expect(parseStoredRecord({ nonsense: true })).toBeNull();
    expect(parseStoredRecord(null)).toBeNull();
  });

  /**
   * A v2 record with a damaged snapshot is kept, without it.
   *
   * The plan is the trip; the snapshot is an ability. Dropping the whole record because the way
   * back is unreadable would lose the thing that matters in order to protect the thing that does
   * not.
   */
  it("keeps a v2 record whose snapshot is corrupt, minus the history", () => {
    const legacy = {
      revision: 2,
      createdAt: NOW,
      updatedAt: LATER,
      plan: mockTripPlan,
      generation: null,
      previousSnapshot: { plan: { not: "a plan" }, revision: 1 },
    };

    const parsed = parseStoredRecord(JSON.parse(JSON.stringify(legacy)));

    expect(parsed?.plan.id).toBe(mockTripPlan.id);
    expect(parsed?.history).toEqual({ past: [], future: [] });
  });
});

describe("the schema", () => {
  it("accepts a record with a history and round-trips through JSON", () => {
    const record = nextRevision(
      createTripRecord(mockTripPlan, NOW, FIXTURE_GENERATION),
      CHANGED_PLAN,
      LATER,
      FIXTURE_GENERATION,
      { label: "Replace stop", kind: "refinement" },
    );

    const parsed = TripRecordSchema.safeParse(JSON.parse(JSON.stringify(record)));

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.history.past).toHaveLength(1);
  });

  /** A record written before the field existed still parses, with nothing to go back to. */
  it("defaults a missing history to empty", () => {
    const parsed = TripRecordSchema.safeParse({
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      plan: mockTripPlan,
      generation: null,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.history).toEqual({ past: [], future: [] });
  });
});
