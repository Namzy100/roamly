import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { REFINEMENT_ACTION_LABELS } from "@/lib/refinement/commands";

import { applyStructuralCommand } from "./dispatch";
import { prepareStructuralCommand, verifyStructuralResult } from "./prepare";
import type { StructuralEditInput, StructuralEditResult } from "./types";

/**
 * The gate between a command and a write.
 *
 * These tests do not re-test the appliers or the dispatcher — both have their own suites. What is
 * worth pinning down is what the hook used to decide inline, where no test could reach it:
 *
 *  - a refusal keeps the applier's own wording, so "unlock it first" survives
 *  - a result that fails the pair-level membership check is refused rather than stored
 *  - `ready` carries the label the record will store, from the one table
 *  - nothing is written, so a `ready` result is a preview and a preview is the real result
 *
 * Day one of the fixture plan: `cafe-one` (the only breakfast), `museum-one`, `dinner-one` (the
 * only dinner). So `museum-one` is the stop most edits can safely touch.
 */

const TIMEZONE = "Europe/Lisbon";

function base(): StructuralEditInput {
  return {
    plan: fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
  };
}

describe("prepareStructuralCommand", () => {
  it("returns a ready result for an edit the plan can take", () => {
    const prepared = prepareStructuralCommand({
      ...base(),
      command: { type: "lock-item", dayNumber: 1, itemId: "museum-one" },
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.summary.action).toBe("lock-item");
    expect(prepared.summary.changedItemIds).toContain("museum-one");
  });

  /**
   * The label is the undo label, and it comes from the shared table.
   *
   * A hand-written string here would be a second source of truth for something a traveller reads
   * after the word "Undo", and the two would drift.
   */
  it("labels a ready result from the action table", () => {
    const prepared = prepareStructuralCommand({
      ...base(),
      command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.label).toBe(REFINEMENT_ACTION_LABELS["remove-item"]);
  });

  /**
   * Every command in the vocabulary reaches a real applier through this path.
   *
   * The point of the checkpoint: one execution entry point that can express the whole surface. A
   * command coming back `unsupported_command` here would be one no control could ever issue.
   */
  it.each([
    [
      "move-item",
      {
        type: "move-item",
        sourceDayNumber: 1,
        targetDayNumber: 2,
        itemId: "museum-one",
        targetPosition: { kind: "end" },
      },
    ],
    [
      "set-item-time",
      {
        type: "set-item-time",
        dayNumber: 1,
        itemId: "museum-one",
        startTime: "11:30",
        endTime: "13:00",
      },
    ],
    [
      "set-item-duration",
      {
        type: "set-item-duration",
        dayNumber: 1,
        itemId: "museum-one",
        durationMinutes: 60,
        anchor: "start",
      },
    ],
    [
      "insert-free-time",
      {
        type: "insert-free-time",
        dayNumber: 2,
        startTime: "16:00",
        endTime: "17:00",
      },
    ],
    ["remove-item", { type: "remove-item", dayNumber: 1, itemId: "museum-one" }],
    ["lock-item", { type: "lock-item", dayNumber: 1, itemId: "museum-one" }],
  ] as const)("routes %s to a real applier", (_label, command) => {
    const prepared = prepareStructuralCommand({ ...base(), command });

    const codes =
      prepared.status === "refused" ? prepared.errors.map((error) => error.code) : [];
    expect(codes).not.toContain("unsupported_command");
  });

  /**
   * A refusal travels back in the applier's own words.
   *
   * `lockRefusalFor` distinguishes the traveller's pin from the trip's dates, and the advice
   * differs: one says "unlock it first", the other has to say "this cannot be changed at all".
   * Flattening both into one generic sentence would leave the interface unable to say either.
   */
  it("keeps the applier's wording and code on a refusal", () => {
    const plan = fixtureSavedPlan();
    const locked = {
      ...plan,
      days: plan.days.map((day) =>
        day.dayNumber === 1
          ? {
              ...day,
              items: day.items.map((item) =>
                item.id === "museum-one" ? { ...item, locked: true } : item,
              ),
            }
          : day,
      ),
    };

    const command = {
      type: "remove-item",
      dayNumber: 1,
      itemId: "museum-one",
    } as const;

    const prepared = prepareStructuralCommand({ ...base(), plan: locked, command });
    const direct = applyStructuralCommand({ ...base(), plan: locked, command });

    expect(prepared.status).toBe("refused");
    expect(direct.status).toBe("failed");
    if (prepared.status !== "refused" || direct.status !== "failed") return;

    expect(prepared.errors[0].code).toBe("item_locked");
    expect(prepared.message).toBe(direct.errors[0].message);
  });

  /** Nothing is stored and nothing is mutated, which is what makes a ready result a preview. */
  it("writes nothing — the plan it was given is untouched", () => {
    const plan = fixtureSavedPlan();
    const before = JSON.stringify(plan);

    prepareStructuralCommand({
      ...base(),
      plan,
      command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
    });

    expect(JSON.stringify(plan)).toBe(before);
  });

  /**
   * The same command twice gives the same answer.
   *
   * Determinism is what lets a preview be shown and then committed without re-deciding anything.
   */
  it("is deterministic", () => {
    const command = {
      type: "set-item-duration",
      dayNumber: 1,
      itemId: "museum-one",
      durationMinutes: 60,
      anchor: "start",
    } as const;

    expect(prepareStructuralCommand({ ...base(), command })).toStrictEqual(
      prepareStructuralCommand({ ...base(), command }),
    );
  });
});

describe("verifyStructuralResult", () => {
  /**
   * The gate the appliers cannot close themselves.
   *
   * `commitStructuralEdit` asserts the itinerary uses the pool, but a retained place that nothing
   * in the plan references is a property of the finished pair. Storing it would leave a trip
   * carrying a place no search accounts for.
   */
  it("refuses a result whose retained places no longer hold up", () => {
    const orphaned: StructuralEditResult = {
      status: "success",
      plan: fixtureSavedPlan(),
      generationContext: {
        ...FIXTURE_GENERATION,
        retainedPlaces: [
          {
            place: {
              ...FIXTURE_GENERATION.placePool.places[0],
              placeId: "retained-but-unreferenced",
            },
            retainedAt: "2026-01-01T00:00:00.000Z",
            reason: "missing-after-refresh",
          },
        ],
      },
      summary: {
        action: "move-item",
        affectedDays: [1],
        changedItemIds: [],
        addedItemIds: [],
        removedItemIds: [],
        invalidatedLegIds: [],
        addedLegIds: [],
        removedBackupIds: [],
        revisionBefore: 3,
      },
    };

    const prepared = verifyStructuralResult(orphaned);

    expect(prepared.status).toBe("refused");
    if (prepared.status !== "refused") return;
    /** Framed as a verification failure, because the traveller did nothing wrong. */
    expect(prepared.message).toContain("nothing was saved");
  });

  /** A `partial` result is still storable — its warnings ride along rather than blocking it. */
  it("carries a partial result's warnings through as ready", () => {
    const prepared = verifyStructuralResult({
      status: "partial",
      plan: fixtureSavedPlan(),
      generationContext: FIXTURE_GENERATION,
      summary: {
        action: "move-item",
        affectedDays: [1, 2],
        changedItemIds: ["museum-one"],
        addedItemIds: [],
        removedItemIds: [],
        invalidatedLegIds: ["leg-a"],
        addedLegIds: [],
        removedBackupIds: [],
        revisionBefore: 3,
      },
      warnings: [
        { code: "routes_invalidated", message: "One travel time was cleared." },
      ],
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.warnings).toHaveLength(1);
    expect(prepared.warnings[0].code).toBe("routes_invalidated");
    expect(prepared.label).toBe(REFINEMENT_ACTION_LABELS["move-item"]);
  });

  it("reports no warnings for a clean success", () => {
    const prepared = verifyStructuralResult({
      status: "success",
      plan: fixtureSavedPlan(),
      generationContext: FIXTURE_GENERATION,
      summary: {
        action: "lock-item",
        affectedDays: [1],
        changedItemIds: ["museum-one"],
        addedItemIds: [],
        removedItemIds: [],
        invalidatedLegIds: [],
        addedLegIds: [],
        removedBackupIds: [],
        revisionBefore: 3,
      },
    });

    expect(prepared.status).toBe("ready");
    if (prepared.status !== "ready") return;
    expect(prepared.warnings).toEqual([]);
  });
});
