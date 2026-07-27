import type { ItineraryDay, ItineraryItem, TripPlan } from "@/lib/schemas";

import type { ResolvedPosition } from "./position";
import type { StructuralEditError } from "./types";

/**
 * Finding the thing an edit names, and refusing clearly when it is not there.
 *
 * ## Why this is shared rather than repeated
 *
 * Phase 6C had two appliers and each opened with its own day-and-item lookup. Phase 8 adds seven
 * more. Nine copies of "find the day, find the item, return the right code" is nine chances for
 * one of them to answer `item_not_found` when the *day* was the problem — which sends a traveller
 * looking in the wrong place.
 *
 * `lib/refinement/resolve-hours.ts` has a private `locate` doing the same job for the refinement
 * result shape. The two are deliberately not merged: they return different error vocabularies, and
 * unifying them would make one boundary import the other's.
 */

export type LocatedDay = { dayIndex: number; day: ItineraryDay };

export type LocatedItem = LocatedDay & {
  itemIndex: number;
  item: ItineraryItem;
};

export type Located<T> =
  | { ok: true; value: T }
  | { ok: false; error: StructuralEditError };

export function locateDay(
  plan: TripPlan,
  dayNumber: number,
): Located<LocatedDay> {
  const dayIndex = plan.days.findIndex((day) => day.dayNumber === dayNumber);
  if (dayIndex === -1) {
    return {
      ok: false,
      error: {
        code: "day_not_found",
        message: `Day ${dayNumber} is not part of this trip.`,
        dayNumber,
      },
    };
  }
  return { ok: true, value: { dayIndex, day: plan.days[dayIndex] } };
}

export function locateItem(
  plan: TripPlan,
  dayNumber: number,
  itemId: string,
): Located<LocatedItem> {
  const day = locateDay(plan, dayNumber);
  if (!day.ok) return day;

  const itemIndex = day.value.day.items.findIndex((item) => item.id === itemId);
  if (itemIndex === -1) {
    return {
      ok: false,
      error: {
        code: "item_not_found",
        message: `Stop "${itemId}" is not on day ${dayNumber}.`,
        dayNumber,
        itemId,
      },
    };
  }

  return {
    ok: true,
    value: { ...day.value, itemIndex, item: day.value.day.items[itemIndex] },
  };
}

/**
 * The free window around a stop that is **staying where it is** in the sequence.
 *
 * The right input to `resolveInsertionTimes` for a re-time or a resize: that function asks what
 * window is open at a position, and a stop's own current times are not an obstacle to its new
 * ones — so the stop itself is excluded and its neighbours are the day's.
 *
 * Built by index arithmetic rather than by `removeById`, deliberately. `removeById` renumbers
 * `order` and so hands back fresh objects for everything after the removal, and this function is
 * only answering a question rather than building a day. The neighbours come back as the same
 * objects they already are.
 */
export function positionOfExistingItem(
  day: ItineraryDay,
  itemIndex: number,
): ResolvedPosition {
  return {
    index: itemIndex,
    before: itemIndex > 0 ? day.items[itemIndex - 1] : null,
    after: itemIndex < day.items.length - 1 ? day.items[itemIndex + 1] : null,
  };
}

/**
 * Where in a day's sequence a stop starting at `startMinutes` belongs.
 *
 * The inverse of `promote-backup`, and deliberately so. There the traveller picks a position and
 * the times are derived; here — inserting free time — they give the times and the position
 * follows, because when something happens is what decides where it sits. Any other rule would let
 * a day's array order disagree with its own clock.
 */
export function indexForStartTime(
  day: ItineraryDay,
  startMinutes: number,
  minutesOf: (time: string) => number,
): number {
  let index = 0;
  while (
    index < day.items.length &&
    minutesOf(day.items[index].startTime) <= startMinutes
  ) {
    index += 1;
  }
  return index;
}

/**
 * A free item id built from a prefix, deterministically.
 *
 * Deterministic rather than random because a preview and the edit that follows it must produce
 * the same plan. A `nanoid` here would make the two differ in a field nobody can see, and every
 * test asserting on the result would have to learn to ignore it.
 *
 * Mirrors `nextItemId` in `lib/refinement/replace-item.ts`, which derives an id from an
 * *existing* one. A newly inserted item has no ancestor, so it needs a prefix instead.
 */
export function mintItemId(plan: TripPlan, prefix: string): string {
  const used = new Set(
    plan.days.flatMap((day) => day.items.map((item) => item.id)),
  );

  if (!used.has(prefix)) return prefix;

  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const candidate = `${prefix}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }

  /**
   * Unreachable in practice — a trip holds at most seven days of stops — but a thousand
   * collisions means something is badly wrong, and a loop that could run forever is worse than a
   * throw that names the problem.
   */
  throw new Error(`Could not find a free item id for prefix "${prefix}"`);
}
