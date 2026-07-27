import type { z } from "zod";

import type {
  LockItemCommandSchema,
  UnlockItemCommandSchema,
} from "@/lib/refinement/commands";
import type { ItineraryItem } from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { locateItem } from "./locate";
import { isStructurallyLocked } from "./locks";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

type LockItemCommand = z.infer<typeof LockItemCommandSchema>;
type UnlockItemCommand = z.infer<typeof UnlockItemCommandSchema>;

/**
 * Setting and clearing the traveller's pin.
 *
 * ## The cheapest edit, and it still goes through the commit
 *
 * Nothing about the plan's shape changes — no time, no place, no cost, no adjacency — so every
 * derivation `commitStructuralEdit` runs is a no-op returning the same numbers. It runs anyway, for
 * two reasons. It is the only place the plan is re-parsed and the pool re-asserted, and a lock that
 * skipped that would be the one write path with no gate on it. And it produces the same summary and
 * revision bookkeeping every other edit does, so the undo history has a uniform shape rather than
 * one entry that behaves differently.
 *
 * `buildSummary` compares `locked` explicitly for this reason — without it a lock would report zero
 * changed items, and the history entry would claim nothing happened.
 *
 * ## Why the structural lock refuses in both directions
 *
 * `lock-item` on an airport transfer is refused rather than quietly accepted. It is already
 * immovable, so accepting would write a field that changes nothing while implying the traveller had
 * achieved something — and `unlock-item` would then appear to offer a freedom that does not exist.
 * `supportsTravellerLock` keeps the control off those cards; this is the enforcement behind it.
 *
 * ## Why two commands rather than a boolean
 *
 * `lock-item` on an already-locked stop is a refusal. A toggle carrying `locked: true` from a stale
 * render would silently agree with a state it did not know about, and the traveller would discover
 * their lock had been off only when something moved.
 */

export function applySetItemLock(
  input: StructuralEditInput & { command: LockItemCommand | UnlockItemCommand },
): StructuralEditResult {
  const { plan, command } = input;

  const located = locateItem(plan, command.dayNumber, command.itemId);
  if (!located.ok) return failed(located.error);

  const { dayIndex, day, itemIndex, item } = located.value;
  const wantLocked = command.type === "lock-item";

  if (isStructurallyLocked(item)) {
    return failed({
      code: "item_structurally_locked",
      message: `“${item.title}” is fixed to this day by the trip's dates, so there is nothing to ${wantLocked ? "lock" : "unlock"} — it already cannot be moved.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  if (item.locked === wantLocked) {
    return failed({
      code: wantLocked ? "already_locked" : "not_locked",
      message: wantLocked
        ? `“${item.title}” is already locked.`
        : `“${item.title}” is not locked.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  const updated: ItineraryItem = { ...item, locked: wantLocked };

  const days = plan.days.map((entry, position) =>
    position === dayIndex
      ? {
          ...entry,
          // Every other item is the same object it was.
          items: entry.items.map((candidate, index) =>
            index === itemIndex ? updated : candidate,
          ),
        }
      : entry,
  );

  return commitStructuralEdit({
    action: command.type,
    before: plan,
    generation: input.generation,
    days,
    revisionBefore: input.revisionBefore,
    affectedDays: [command.dayNumber],
    validateDays: [{ dayNumber: day.dayNumber, baseline: day }],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
