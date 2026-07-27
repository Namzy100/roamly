import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import type { TripPlan } from "@/lib/schemas";

import {
  MAX_HISTORY_BYTES_PER_TRIP,
  MAX_HISTORY_ENTRIES,
  contextAfterRestore,
  describeHistory,
  historyBytes,
  kindChangesContext,
  pushHistory,
  stepBack,
  stepForward,
  trimHistory,
  type TripHistory,
  type TripHistoryEntry,
  type TripHistoryKind,
} from "./history";

const PLAN = fixtureSavedPlan();

/** A plan that differs, so a restore is visible rather than merely equal. */
function planLabelled(note: string): TripPlan {
  return { ...PLAN, practicalNotes: [note] };
}

function entry(
  index: number,
  kind: TripHistoryKind = "structural-edit",
  plan: TripPlan = PLAN,
): TripHistoryEntry {
  return {
    id: `e${index}`,
    label: `Edit ${index}`,
    createdAt: "2026-07-28T00:00:00.000Z",
    beforeRevision: index + 1,
    afterRevision: index + 2,
    kind,
    plan,
    ...(kindChangesContext(kind) ? { generationContext: FIXTURE_GENERATION } : {}),
  };
}

const current = {
  plan: planLabelled("current"),
  generation: FIXTURE_GENERATION,
  revision: 99,
};

describe("the budget itself", () => {
  it("is exposed from one place, so nothing can hold a second opinion", () => {
    expect(MAX_HISTORY_ENTRIES).toBe(20);
    expect(MAX_HISTORY_BYTES_PER_TRIP).toBe(512 * 1024);
  });

  /**
   * The measured claim the constant rests on.
   *
   * Twenty plan-sized entries of the fixture trip came to 206 KB when this was chosen. If a schema
   * change ever makes an entry large enough that twenty no longer fit, this is where that should be
   * noticed — rather than in a browser, as a history that quietly stopped going back as far.
   */
  it("still fits twenty entries of an ordinary trip", () => {
    const history: TripHistory = {
      past: Array.from({ length: MAX_HISTORY_ENTRIES }, (_, i) => entry(i)),
      future: [],
    };

    expect(historyBytes(history)).toBeLessThan(MAX_HISTORY_BYTES_PER_TRIP);
    expect(trimHistory(history).past).toHaveLength(MAX_HISTORY_ENTRIES);
  });
});

describe("kindChangesContext", () => {
  it("is true only for the kinds that can replace the pool", () => {
    expect(kindChangesContext("pool-refresh")).toBe(true);
    expect(kindChangesContext("import-replacement")).toBe(true);
    expect(kindChangesContext("generation-context-change")).toBe(true);

    expect(kindChangesContext("structural-edit")).toBe(false);
    expect(kindChangesContext("routing")).toBe(false);
    expect(kindChangesContext("refinement")).toBe(false);
  });

  /**
   * The saving the entry shape exists for, asserted rather than merely described.
   *
   * A context-carrying entry is substantially larger than a plain one, which is why ordinary edits
   * must not carry one: twenty that did would be megabytes.
   */
  it("is what makes an ordinary entry smaller than a pool-changing one", () => {
    const plain = historyBytes({ past: [entry(0, "structural-edit")], future: [] });
    const withPool = historyBytes({ past: [entry(0, "pool-refresh")], future: [] });

    expect(withPool).toBeGreaterThan(plain * 1.2);
  });
});

describe("trimHistory", () => {
  it("keeps the newest past entries and drops the oldest", () => {
    const past = Array.from({ length: MAX_HISTORY_ENTRIES + 5 }, (_, i) => entry(i));

    const trimmed = trimHistory({ past, future: [] });

    expect(trimmed.past).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(trimmed.past[0].id).toBe("e5");
    expect(trimmed.past.at(-1)?.id).toBe(`e${MAX_HISTORY_ENTRIES + 4}`);
  });

  it("keeps the nearest future entries and drops the furthest", () => {
    const future = Array.from({ length: MAX_HISTORY_ENTRIES + 3 }, (_, i) => entry(i));

    const trimmed = trimHistory({ past: [], future });

    expect(trimmed.future).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(trimmed.future[0].id).toBe("e0");
  });

  /**
   * The byte bound biting before the count does — the case the dual bound exists for.
   *
   * Built from a deliberately oversized plan rather than by lowering the constant, so what runs is
   * the real threshold.
   */
  it("drops entries once the byte budget is reached, even under twenty", () => {
    const heavy = planLabelled("x".repeat(60_000));
    const past = Array.from({ length: 15 }, (_, i) =>
      entry(i, "structural-edit", heavy),
    );

    const trimmed = trimHistory({ past, future: [] });

    expect(trimmed.past.length).toBeLessThan(15);
    expect(historyBytes(trimmed)).toBeLessThanOrEqual(MAX_HISTORY_BYTES_PER_TRIP);
    // Newest kept, oldest dropped — the same rule the count bound follows.
    expect(trimmed.past.at(-1)?.id).toBe("e14");
  });

  it("sacrifices the past before the redo the traveller is standing on", () => {
    const heavy = planLabelled("x".repeat(60_000));

    const trimmed = trimHistory({
      past: Array.from({ length: 10 }, (_, i) => entry(i, "structural-edit", heavy)),
      future: [entry(99, "structural-edit", heavy)],
    });

    expect(trimmed.future).toHaveLength(1);
    expect(trimmed.past.length).toBeLessThan(10);
  });

  /**
   * A trip whose single entry exceeds the whole budget keeps it.
   *
   * Trimming to nothing would leave a trip that silently cannot be undone at all, which is worse
   * than exceeding a self-imposed ceiling — and it is the capacity probe, not this budget, that
   * decides whether a write actually fits.
   */
  it("never trims to nothing", () => {
    const enormous = planLabelled("x".repeat(MAX_HISTORY_BYTES_PER_TRIP + 1_000));

    const trimmed = trimHistory({
      past: [entry(0, "structural-edit", enormous)],
      future: [],
    });

    expect(trimmed.past).toHaveLength(1);
  });

  it("is deterministic", () => {
    const past = Array.from({ length: 30 }, (_, i) => entry(i));

    expect(trimHistory({ past, future: [] })).toEqual(
      trimHistory({ past, future: [] }),
    );
  });
});

describe("pushHistory", () => {
  it("appends to the past", () => {
    const pushed = pushHistory({ past: [entry(0)], future: [] }, entry(1));

    expect(pushed.past.map((e) => e.id)).toEqual(["e0", "e1"]);
  });

  /**
   * Doing something new abandons the branch that was going forward.
   *
   * Keeping it would offer a redo whose plan was built on a trip that no longer exists.
   */
  it("discards the redo stack", () => {
    const pushed = pushHistory({ past: [], future: [entry(9)] }, entry(1));

    expect(pushed.future).toEqual([]);
  });
});

describe("stepBack and stepForward", () => {
  it("returns null when there is nowhere to go", () => {
    expect(stepBack({ past: [], future: [] }, current)).toBeNull();
    expect(stepForward({ past: [], future: [] }, current)).toBeNull();
  });

  it("moves the entry across and leaves the current state behind", () => {
    const back = stepBack({ past: [entry(0), entry(1)], future: [] }, current);

    expect(back?.entry.id).toBe("e1");
    expect(back?.history.past.map((e) => e.id)).toEqual(["e0"]);
    expect(back?.history.future).toHaveLength(1);
    // What is left behind is the state being departed, so a redo restores it exactly.
    expect(back?.history.future[0].plan).toBe(current.plan);
    expect(back?.history.future[0].label).toBe("Edit 1");
  });

  it("round-trips: undo then redo restores the state that was left", () => {
    const back = stepBack({ past: [entry(0)], future: [] }, current);
    expect(back).not.toBeNull();
    if (!back) return;

    const forward = stepForward(back.history, {
      plan: back.entry.plan,
      generation: FIXTURE_GENERATION,
      revision: 100,
    });

    expect(forward?.entry.plan).toBe(current.plan);
    expect(forward?.history.past).toHaveLength(1);
    expect(forward?.history.future).toEqual([]);
  });

  /** An ordinary edit is not reversed by changing the pool, so no context is stored either way. */
  it("omits the context on the mirror of an ordinary edit", () => {
    const back = stepBack(
      { past: [entry(0, "structural-edit")], future: [] },
      current,
    );

    expect(back?.history.future[0].generationContext).toBeUndefined();
  });

  it("carries the context on the mirror of a pool-changing edit", () => {
    const back = stepBack({ past: [entry(0, "pool-refresh")], future: [] }, current);

    expect(back?.history.future[0].generationContext).toBe(current.generation);
  });
});

describe("contextAfterRestore", () => {
  it("keeps the record's context when the entry carries none", () => {
    expect(
      contextAfterRestore(entry(0, "structural-edit"), FIXTURE_GENERATION),
    ).toBe(FIXTURE_GENERATION);
  });

  it("restores the entry's context when it carries one", () => {
    expect(contextAfterRestore(entry(0, "pool-refresh"), null)).toBe(
      FIXTURE_GENERATION,
    );
  });

  /**
   * An explicit `null` is a value, not an absence.
   *
   * Undoing an import over a trip that never had a generation context has to put the record back to
   * having none — indistinguishable from "unchanged" unless the two are kept apart.
   */
  it("restores an explicitly null context rather than treating it as absent", () => {
    const importEntry: TripHistoryEntry = {
      ...entry(0, "import-replacement"),
      generationContext: null,
    };

    expect(contextAfterRestore(importEntry, FIXTURE_GENERATION)).toBeNull();
  });
});

describe("describeHistory", () => {
  it("reports actual depth and the next labels", () => {
    const described = describeHistory({
      past: [entry(0), entry(1)],
      future: [entry(2)],
    });

    expect(described.undoDepth).toBe(2);
    expect(described.redoDepth).toBe(1);
    expect(described.nextUndo).toBe("Edit 1");
    expect(described.nextRedo).toBe("Edit 2");
    expect(described.bytes).toBeGreaterThan(0);
  });

  it("reports nothing for a trip nobody has edited", () => {
    expect(describeHistory({ past: [], future: [] })).toMatchObject({
      undoDepth: 0,
      redoDepth: 0,
      nextUndo: null,
      nextRedo: null,
    });
  });
});
