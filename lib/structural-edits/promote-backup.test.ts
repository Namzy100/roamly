import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  FIXTURE_SPARE_CAFE,
  fixtureSavedPlan,
  generationWithSpare,
} from "@/lib/refinement/test-fixtures";
import type {
  BackupOption,
  TripGenerationContext,
  TripPlace,
  TripPlan,
} from "@/lib/schemas";

import { applyPromoteBackup } from "./promote-backup";
import type { StructuralEditResult } from "./types";

/**
 * The fixture trip's only backup is the second museum on day 1, and that museum is also a stop
 * on day 2 — so promoting it would duplicate a place. Most of these tests therefore install a
 * backup pointing at the spare café instead, which is a pool member nothing schedules.
 */

const TIMEZONE = "Europe/Lisbon";

function backupFor(place: TripPlace, id = "bk-spare"): BackupOption {
  return {
    id,
    title: `Backup: ${place.name}`,
    kind: "attraction",
    reason: "A second option from the same search, in case the first is shut.",
    place,
    estimatedCost: 14,
  };
}

function planWithBackup(
  backup: BackupOption,
  dayNumber = 1,
  plan: TripPlan = fixtureSavedPlan(),
): TripPlan {
  return {
    ...plan,
    days: plan.days.map((day) =>
      day.dayNumber === dayNumber ? { ...day, backups: [backup] } : day,
    ),
  };
}

function promote(
  input: {
    plan: TripPlan;
    generation?: TripGenerationContext;
    sourceDayNumber?: number;
    backupId?: string;
    targetDayNumber?: number;
    targetPosition?: Parameters<typeof applyPromoteBackup>[0]["command"]["targetPosition"];
    startTime?: string;
    endTime?: string;
  },
): StructuralEditResult {
  return applyPromoteBackup({
    plan: input.plan,
    generation: input.generation ?? generationWithSpare(),
    revisionBefore: 4,
    timezone: TIMEZONE,
    command: {
      type: "promote-backup",
      sourceDayNumber: input.sourceDayNumber ?? 1,
      backupId: input.backupId ?? "bk-spare",
      targetDayNumber: input.targetDayNumber ?? 1,
      targetPosition: input.targetPosition ?? { kind: "end" },
      ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
      ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
    },
  });
}

function itemsOf(plan: TripPlan, dayNumber: number) {
  return plan.days.find((day) => day.dayNumber === dayNumber)?.items ?? [];
}

describe("applyPromoteBackup — the happy path", () => {
  it("adds the backup as a stop, with the pool's canonical record", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const added = itemsOf(result.plan, 1).find(
      (item) => item.place?.placeId === FIXTURE_SPARE_CAFE.placeId,
    );
    expect(added).toBeDefined();
    // Attached whole and unmodified, straight from the pool.
    expect(added?.place).toEqual(FIXTURE_SPARE_CAFE);
    expect(added?.status).toBe("confirmed");
    expect(added?.travelToNext).toBeNull();
  });

  /**
   * A new id, never the backup's. Reusing it would let the routes around the insertion point
   * survive re-keying and attach real geometry to a journey nobody makes.
   */
  it("mints a new item id derived from the backup's", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const added = itemsOf(result.plan, 1).find(
      (item) => item.place?.placeId === FIXTURE_SPARE_CAFE.placeId,
    );
    expect(added?.id).toBe("bk-spare-p1");
    expect(result.summary.addedItemIds).toEqual(["bk-spare-p1"]);
  });

  /** The chosen rule, asserted: the promoted backup is gone and the summary says so. */
  it("removes the promoted backup and records it", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.plan.days[0].backups).toEqual([]);
    expect(result.summary.removedBackupIds).toEqual(["bk-spare"]);
  });

  it("derives a time at the end of the day", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const items = itemsOf(result.plan, 1);
    const added = items[items.length - 1];
    expect(added.place?.placeId).toBe(FIXTURE_SPARE_CAFE.placeId);
    expect(added.startTime > items[items.length - 2].endTime).toBe(true);
  });

  it("uses explicit times when they are given", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({
      plan,
      targetPosition: { kind: "end" },
      startTime: "22:00",
      endTime: "23:00",
    });

    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    const added = itemsOf(result.plan, 1).find((item) => item.id === "bk-spare-p1");
    expect(added?.startTime).toBe("22:00");
    expect(added?.endTime).toBe("23:00");
  });

  it("promotes onto a different day than the backup belongs to", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan, targetDayNumber: 2 });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(
      itemsOf(result.plan, 2).some((item) => item.id === "bk-spare-p1"),
    ).toBe(true);
    // Still removed from the day it was a backup for.
    expect(result.plan.days[0].backups).toEqual([]);
    expect(result.summary.affectedDays).toEqual([1, 2]);
  });

  it("recomputes the day total and the budget", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));
    const before = plan.days[0].dayTotal;

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.plan.days[0].dayTotal).toBeCloseTo(before + 14, 2);
    expect(result.plan.budget.total).toBeGreaterThan(plan.budget.total);
  });

  /**
   * Deep equality rather than `===`, and deliberately so: `commitStructuralEdit` re-parses the
   * finished plan and Zod rebuilds it. The claim that matters is unchanged — no unrelated stop's
   * place, time, cost or status moved.
   */
  it("leaves every other stop unchanged", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    for (const before of plan.days[0].items) {
      const after = itemsOf(result.plan, 1).find((item) => item.id === before.id);
      // `travelToNext` is re-keyed for the stop that gained a successor, so the last one may
      // legitimately differ; everything else is untouched.
      expect({ ...after, travelToNext: null, order: 0 }).toEqual({
        ...before,
        travelToNext: null,
        order: 0,
      });
    }

    // And the untouched day is unchanged in every respect a traveller could notice.
    expect(result.plan.days[1].items).toEqual(plan.days[1].items);
    expect(result.plan.days[1].backups).toEqual(plan.days[1].backups);
    expect(result.plan.days[1].dayTotal).toBe(plan.days[1].dayTotal);
  });

  it("reports the revision it was computed against", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;
    expect(result.summary.revisionBefore).toBe(4);
    expect(result.summary.action).toBe("promote-backup");
  });
});

describe("applyPromoteBackup — what it refuses", () => {
  it("refuses a day the trip does not have", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    expect(promote({ plan, sourceDayNumber: 7 })).toMatchObject({
      status: "failed",
      errors: [{ code: "day_not_found" }],
    });
    expect(promote({ plan, targetDayNumber: 7 })).toMatchObject({
      status: "failed",
      errors: [{ code: "day_not_found" }],
    });
  });

  it("refuses a backup that is not on that day", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    expect(promote({ plan, backupId: "nope" })).toMatchObject({
      status: "failed",
      errors: [{ code: "backup_not_found" }],
    });
  });

  it("refuses a target position that does not exist", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    expect(
      promote({ plan, targetPosition: { kind: "before", itemId: "gone" } }),
    ).toMatchObject({
      status: "failed",
      errors: [{ code: "target_item_not_found" }],
    });
  });

  /**
   * The mechanical half of the no-invention rule at this seam: a promotion is a **new
   * selection**, so the place must be a current pool member.
   */
  it("refuses a place that is not in the pool", () => {
    const stranger: TripPlace = {
      ...FIXTURE_SPARE_CAFE,
      placeId: "osm:node:987654",
      source: { ...FIXTURE_SPARE_CAFE.source, canonicalId: "osm:node:987654", osmId: "987654" },
    };
    const plan = planWithBackup(backupFor(stranger));

    expect(promote({ plan, generation: FIXTURE_GENERATION })).toMatchObject({
      status: "failed",
      errors: [{ code: "place_outside_pool", placeId: "osm:node:987654" }],
    });
  });

  /**
   * The widened invariant, from the narrow side. A place kept after a refresh may stay on the
   * stop that already used it and may never be newly selected.
   */
  it("refuses a place that is only retained, and says which", () => {
    const stranger: TripPlace = {
      ...FIXTURE_SPARE_CAFE,
      placeId: "osm:node:987654",
      source: { ...FIXTURE_SPARE_CAFE.source, canonicalId: "osm:node:987654", osmId: "987654" },
    };
    const plan = planWithBackup(backupFor(stranger));

    const result = promote({
      plan,
      generation: {
        ...FIXTURE_GENERATION,
        retainedPlaces: [
          {
            place: stranger,
            retainedAt: "2026-07-27T10:00:00.000Z",
            reason: "missing-after-refresh",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      status: "failed",
      errors: [{ code: "place_is_retained" }],
    });
    if (result.status !== "failed") return;
    expect(result.errors[0].message).toContain("most recent place search");
  });

  it("refuses a place already scheduled somewhere in the trip", () => {
    const plan = planWithBackup(backupFor(FIXTURE_PLACES.museumOne));

    expect(promote({ plan })).toMatchObject({
      status: "failed",
      errors: [{ code: "place_already_used" }],
    });
  });

  it("refuses when there is no room at the chosen position", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));
    const firstItemId = plan.days[0].items[0].id;

    const result = promote({
      plan,
      targetPosition: { kind: "before", itemId: firstItemId },
      startTime: "09:00",
      endTime: "10:00",
    });

    expect(result).toMatchObject({ status: "failed" });
    if (result.status !== "failed") return;
    expect(["invalid_times", "no_slot_available"]).toContain(result.errors[0].code);
  });

  it("returns no plan on failure", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));
    const result = promote({ plan, backupId: "nope" });

    expect(result.status).toBe("failed");
    expect("plan" in result).toBe(false);
  });

  it("leaves the plan it was given untouched on failure", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));
    const snapshot = JSON.stringify(plan);

    promote({ plan, backupId: "nope" });

    expect(JSON.stringify(plan)).toBe(snapshot);
  });
});

describe("applyPromoteBackup — routes and hours", () => {
  it("reports the new adjacencies as legs that have never been routed", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    const result = promote({ plan });
    expect(result.status).not.toBe("failed");
    if (result.status === "failed") return;

    expect(result.summary.addedLegIds.length).toBeGreaterThan(0);
    for (const legId of result.summary.addedLegIds) {
      expect(legId).toContain("bk-spare-p1");
    }
  });

  /**
   * A promotion into a day where the published hours say the place is shut succeeds and warns.
   * Refusing would be worse: the hours may be stale, and the traveller may know better.
   */
  it("warns rather than refusing when the hours say the place is shut then", () => {
    const closed: TripPlace = {
      ...FIXTURE_SPARE_CAFE,
      openingHours: "Mo-Fr 09:00-17:00",
    };
    const plan = planWithBackup(backupFor(closed));

    const result = promote({
      plan,
      generation: generationWithSpare({ openingHours: "Mo-Fr 09:00-17:00" }),
    });

    expect(result.status).toBe("partial");
    if (result.status !== "partial") return;
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "hours_conflict_after_edit",
    );
  });

  it("is deterministic", () => {
    const plan = planWithBackup(backupFor(FIXTURE_SPARE_CAFE));

    expect(JSON.stringify(promote({ plan }))).toBe(
      JSON.stringify(promote({ plan })),
    );
  });
});
