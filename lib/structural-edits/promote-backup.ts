import type { PromoteBackupCommandSchema } from "@/lib/refinement/commands";
import type { z } from "zod";
import type {
  BackupOption,
  ItineraryDay,
  ItineraryItem,
  TripPlan,
} from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { insertAt, resolvePosition } from "./position";
import { defaultDurationMinutes, resolveInsertionTimes } from "./schedule";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

type PromoteBackupCommand = z.infer<typeof PromoteBackupCommandSchema>;

/**
 * Promoting a backup into the itinerary.
 *
 * ## The backup is removed, and that is a decision
 *
 * Two rules were available. Keeping the backup and labelling it "already scheduled" is
 * gentler but leaves a list offering the traveller a swap-in for something they are already
 * doing — a fallback that is no longer a fallback. Removing it says what happened.
 *
 * So it is removed, its id is recorded in `summary.removedBackupIds`, and **undo restores
 * it** along with everything else, because the undo snapshot holds the whole plan rather
 * than a diff. That is what makes the destructive-looking choice safe.
 *
 * ## A new item id, never the backup's
 *
 * Tempting to reuse it: fewer ids, stable leg keys, no invalidation. That is exactly the
 * reason not to. The legs around the insertion point measured journeys between a different
 * pair of places, and an id that survived re-keying would attach real geometry to a journey
 * nobody makes. A fresh id makes the invalidation automatic and correct.
 *
 * ## The canonical record, from the active pool
 *
 * The place is looked up in the pool by id and attached whole. A backup whose place is only
 * in the *retained* collection — kept after a refresh that no longer finds it — is refused:
 * a promotion is a **new selection**, and the widened pool invariant permits retained
 * records only for references that already exist.
 */

export function applyPromoteBackup(
  input: StructuralEditInput & { command: PromoteBackupCommand },
): StructuralEditResult {
  const { plan, command } = input;

  const sourceIndex = plan.days.findIndex(
    (day) => day.dayNumber === command.sourceDayNumber,
  );
  if (sourceIndex === -1) {
    return failed({
      code: "day_not_found",
      message: `Day ${command.sourceDayNumber} is not part of this trip.`,
      dayNumber: command.sourceDayNumber,
    });
  }

  const targetIndex = plan.days.findIndex(
    (day) => day.dayNumber === command.targetDayNumber,
  );
  if (targetIndex === -1) {
    return failed({
      code: "day_not_found",
      message: `Day ${command.targetDayNumber} is not part of this trip.`,
      dayNumber: command.targetDayNumber,
    });
  }

  const sourceDay = plan.days[sourceIndex];
  const backup = sourceDay.backups.find((entry) => entry.id === command.backupId);
  if (!backup) {
    return failed({
      code: "backup_not_found",
      message: `There is no backup "${command.backupId}" on day ${command.sourceDayNumber}.`,
      dayNumber: command.sourceDayNumber,
    });
  }

  /* -- the place must be a current pool member ----------------------------- */

  const canonical = input.generation.placePool.places.find(
    (place) => place.placeId === backup.place.placeId,
  );

  if (!canonical) {
    const retained = (input.generation.retainedPlaces ?? []).some(
      (entry) => entry.place.placeId === backup.place.placeId,
    );

    return failed(
      retained
        ? {
            code: "place_is_retained",
            message: `“${backup.place.name}” was not found by the most recent place search, so it can no longer be added to the itinerary. It remains on any stop that already used it.`,
            placeId: backup.place.placeId,
          }
        : {
            code: "place_outside_pool",
            message: `“${backup.place.name}” is not part of this trip's saved place search, so it cannot be added to the itinerary.`,
            placeId: backup.place.placeId,
          },
    );
  }

  if (placeIsScheduled(plan, canonical.placeId)) {
    return failed({
      code: "place_already_used",
      message: `“${canonical.name}” is already a stop in this itinerary.`,
      placeId: canonical.placeId,
    });
  }

  /* -- where, and when ----------------------------------------------------- */

  const targetDay = plan.days[targetIndex];
  const position = resolvePosition(targetDay.items, command.targetPosition);
  if (!position.ok) {
    return failed({
      code: "target_item_not_found",
      message: position.error.message,
      dayNumber: command.targetDayNumber,
      itemId: position.error.itemId,
    });
  }

  const times = resolveInsertionTimes({
    position: position.value,
    durationMinutes: defaultDurationMinutes(backup.kind),
    ...(command.startTime !== undefined || command.endTime !== undefined
      ? {
          requested: {
            ...(command.startTime !== undefined
              ? { startTime: command.startTime }
              : {}),
            ...(command.endTime !== undefined ? { endTime: command.endTime } : {}),
          },
        }
      : {}),
  });

  if (!times.ok) {
    return failed({
      code: times.error.code,
      message: times.error.message,
      dayNumber: command.targetDayNumber,
    });
  }

  const itemId = freeItemId(plan, backup.id);
  if (itemId === null) {
    return failed({
      code: "duplicate_item_id",
      message: `Could not derive a free stop id from "${backup.id}".`,
    });
  }

  const promoted: ItineraryItem = {
    locked: false,
    id: itemId,
    // Overwritten by `insertAt`'s renumbering; set so the object is complete.
    order: position.value.index,
    kind: backup.kind,
    /**
     * No meal type.
     *
     * A backup carries none — it was a swap-in for whatever slot needed it — and inferring
     * "this restaurant must be dinner" from its category would be putting a claim about the
     * traveller's day into a field the schedule validator checks meal coverage against.
     */
    mealType: null,
    title: backup.title,
    rationale: backup.reason,
    status: "confirmed",
    // The pool's record, attached unchanged.
    place: canonical,
    startTime: times.value.startTime,
    endTime: times.value.endTime,
    /**
     * The backup's own figure, carried across unchanged.
     *
     * It was produced by the same clamped estimate every other stop's was, so re-deriving it
     * here would change a number for a reason unrelated to the promotion. `costNote` says
     * where it came from; "Recalculate cost estimates" is the action that refreshes it.
     */
    estimatedCost: backup.estimatedCost,
    costNote: "Estimate carried over from this backup option",
    bookingRequired: false,
    tip: null,
    /**
     * No travel. The journey leaving this stop has never been measured, and the leg it
     * displaces belonged to a different pair of places.
     */
    travelToNext: null,
  };

  /* -- rebuild the affected day(s) ------------------------------------------ */

  const sameDay = command.sourceDayNumber === command.targetDayNumber;

  const days = plan.days.map((day, index) => {
    if (index === targetIndex) {
      const items = insertAt(day.items, position.value.index, promoted);
      return {
        ...day,
        items,
        backups: sameDay ? withoutBackup(day, backup) : day.backups,
      };
    }
    if (index === sourceIndex) {
      return { ...day, backups: withoutBackup(day, backup) };
    }
    // Every other day is the object it was.
    return day;
  });

  return commitStructuralEdit({
    action: "promote-backup",
    before: plan,
    generation: input.generation,
    days,
    revisionBefore: input.revisionBefore,
    affectedDays: sameDay
      ? [command.targetDayNumber]
      : [command.sourceDayNumber, command.targetDayNumber],
    removedBackupIds: [backup.id],
    validateDays: [{ dayNumber: targetDay.dayNumber, baseline: targetDay }],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });
}

function withoutBackup(day: ItineraryDay, backup: BackupOption): BackupOption[] {
  return day.backups.filter((entry) => entry.id !== backup.id);
}

/** Whether a place is already a scheduled stop. Backups do not count. */
function placeIsScheduled(plan: TripPlan, placeId: string): boolean {
  for (const day of plan.days) {
    for (const item of day.items) {
      if (item.place?.placeId === placeId) return true;
    }
  }
  return plan.accommodation?.place.placeId === placeId;
}

/**
 * A fresh id derived from the backup's, deterministically.
 *
 * `-p{n}` rather than a random suffix, so the same promotion always produces the same id and
 * a failing test says the same thing twice. The charset avoids `:`, which the leg-id
 * constructor uses as a separator.
 */
function freeItemId(plan: TripPlan, backupId: string): string | null {
  const used = new Set(
    plan.days.flatMap((day) => day.items.map((item) => item.id)),
  );
  const root = backupId.replace(/-p\d+$/, "");

  for (let attempt = 1; attempt < 1_000; attempt += 1) {
    const candidate = `${root}-p${attempt}`;
    if (!used.has(candidate)) return candidate;
  }
  return null;
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
