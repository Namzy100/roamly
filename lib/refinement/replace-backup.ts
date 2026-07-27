import { clampPartyCost, costClassFor } from "@/lib/plan";
import { kindForCategory } from "@/lib/generate/assemble-plan";
import type { BackupOption, TripPlace, TripPlan } from "@/lib/schemas";

import { RefinementBuildError } from "./replace-item";
import type { ReplaceBackupResult } from "./schemas";
import type { RefinementWarning } from "./types";

/**
 * Swapping one backup option.
 *
 * The simplest refinement, and worth its own module for one reason: **it must not
 * touch routing at all.**
 *
 * A backup is an alternative the traveller might take, not a stop they are taking.
 * It has no position in the day, no adjacency, and therefore no leg — so no route is
 * invalidated, nothing becomes pending, and the coverage summary does not move.
 * Routing an unused backup would mean requesting journeys for places nobody has
 * decided to visit, which multiplies provider traffic for no benefit and is why
 * `deriveDayLegs` only ever looks at `day.items`.
 *
 * Promoting a backup into the itinerary *would* change routing, and that is a
 * different action which this phase does not implement.
 *
 * Everything else in the plan — every item, every other backup, every other day —
 * comes back by reference.
 */

export type ReplaceBackupInput = {
  plan: TripPlan;
  dayNumber: number;
  backupId: string;
  /** Already validated as a member of the eligible subset. */
  chosen: TripPlace;
  result: Extract<ReplaceBackupResult, { status: "selected" }>;
};

export type ReplaceBackupOutcome = {
  plan: TripPlan;
  replacedBackupId: string;
  warnings: RefinementWarning[];
};

export function applyBackupReplacement(
  input: ReplaceBackupInput,
): ReplaceBackupOutcome {
  const dayIndex = input.plan.days.findIndex(
    (day) => day.dayNumber === input.dayNumber,
  );
  if (dayIndex === -1) {
    throw new RefinementBuildError([
      {
        code: "day_not_found",
        message: `Day ${input.dayNumber} is not part of this trip.`,
        dayNumber: input.dayNumber,
      },
    ]);
  }

  const day = input.plan.days[dayIndex];
  const backupIndex = day.backups.findIndex(
    (backup) => backup.id === input.backupId,
  );
  if (backupIndex === -1) {
    throw new RefinementBuildError([
      {
        code: "backup_not_found",
        message: `Backup "${input.backupId}" is not on day ${input.dayNumber}.`,
        dayNumber: input.dayNumber,
      },
    ]);
  }

  const original = day.backups[backupIndex];
  const warnings: RefinementWarning[] = [];

  /**
   * The cost class follows the *new* place's category and the slot's meal type,
   * inferred from the item the backup stands in for where one is identifiable.
   * Falling back to a non-meal class is the conservative choice: it never inflates a
   * café into a dinner.
   */
  const cost = clampPartyCost({
    proposed: input.result.estimatedCost?.amount ?? null,
    currency: input.plan.request.currency,
    costClass: costClassFor(input.chosen.category, null),
    travelers: input.plan.request.travelers,
  });

  if (cost.clamped) {
    warnings.push({
      code: "cost_clamped",
      message: `The estimate for the “${input.chosen.name}” backup was adjusted to the typical range for its kind of place.`,
      dayNumber: input.dayNumber,
    });
  }

  const replacement: BackupOption = {
    // The id is kept: a backup has no adjacency and no leg, so nothing downstream
    // keys routing off it, and keeping it means the card does not jump position.
    id: original.id,
    // The canonical name, not a model paraphrase. A backup card's job is to say
    // where you would go instead.
    title: input.chosen.name,
    kind: kindForCategory(input.chosen.category, null),
    reason: input.result.reason,
    place: input.chosen,
    estimatedCost: cost.amount,
  };

  const backups = day.backups.map((backup, index) =>
    index === backupIndex ? replacement : backup,
  );

  /**
   * `dayTotal` is unchanged on purpose: it sums the day's *items*, and a backup is
   * not one. A backup that contributed to the day's cost would double-count the slot
   * it stands in for.
   */
  const days = input.plan.days.map((entry, index) =>
    index === dayIndex ? { ...entry, backups } : entry,
  );

  return {
    plan: { ...input.plan, days },
    replacedBackupId: original.id,
    warnings,
  };
}

/**
 * Removes a backup that has no available alternative.
 *
 * `BackupOption` requires a real `TripPlace`, so "no alternative exists" cannot be
 * represented as a backup — the honest form is to drop the card and report it as a
 * warning, which is the same decision generation makes for a backup it cannot fill.
 */
export function applyBackupUnavailable(input: {
  plan: TripPlan;
  dayNumber: number;
  backupId: string;
  reason: string;
}): ReplaceBackupOutcome {
  const dayIndex = input.plan.days.findIndex(
    (day) => day.dayNumber === input.dayNumber,
  );
  if (dayIndex === -1) {
    throw new RefinementBuildError([
      {
        code: "day_not_found",
        message: `Day ${input.dayNumber} is not part of this trip.`,
        dayNumber: input.dayNumber,
      },
    ]);
  }

  const day = input.plan.days[dayIndex];
  if (!day.backups.some((backup) => backup.id === input.backupId)) {
    throw new RefinementBuildError([
      {
        code: "backup_not_found",
        message: `Backup "${input.backupId}" is not on day ${input.dayNumber}.`,
        dayNumber: input.dayNumber,
      },
    ]);
  }

  const backups = day.backups.filter((backup) => backup.id !== input.backupId);
  const days = input.plan.days.map((entry, index) =>
    index === dayIndex ? { ...entry, backups } : entry,
  );

  return {
    plan: { ...input.plan, days },
    replacedBackupId: input.backupId,
    warnings: [
      {
        code: "backup_unavailable",
        message: input.reason,
        dayNumber: input.dayNumber,
      },
    ],
  };
}
