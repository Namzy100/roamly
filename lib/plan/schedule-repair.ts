import { minutesOfDay } from "@/lib/ai";
import {
  openIntervalsForDate,
  toMinutes,
  type OpeningInterval,
} from "@/lib/opening-hours";
import { SCHEDULE_LIMITS } from "@/lib/refinement/schedule";
import type { ItineraryDay, ItineraryItem, TripPlan } from "@/lib/schemas";

import { evaluateItem } from "./schedule-report";

/**
 * Moving a stop into the hours it is actually open, arithmetically.
 *
 * ## What it changes, and what it refuses to
 *
 * It moves a stop's **start and end time**, on its own day, keeping its duration, its
 * place, its order and every other stop exactly as they were. That is the whole
 * repertoire. It cannot:
 *
 *  - swap the place for another one — that is a visible change to what the traveller
 *    asked for, and it belongs behind an explicit action they take, not behind a
 *    generation step they did not ask for
 *  - promote a backup, move a stop to another day, or reorder a day
 *  - lengthen or shorten a visit to make it fit
 *  - touch anything on a day with no conflict
 *
 * A conflict it cannot fix by moving the clock is left alone and reported. Half-fixing
 * a day would be worse than not fixing it: the traveller would see a plan that had been
 * silently rearranged *and* still had the problem.
 *
 * ## Why this runs at all, rather than only offering the repair
 *
 * A generated itinerary that schedules a museum on the Monday it shuts is a bad
 * itinerary, and the fix — start two hours later — needs no model, no search and no
 * judgement. Doing it once, deterministically, and *saying* that it happened is better
 * than presenting a conflict the planner could have avoided.
 *
 * One pass. No loop, no search over permutations. If moving one stop creates a new
 * problem the pass is discarded wholesale, because a repair that needs repairing is not
 * a repair.
 *
 * ## No model, no network, no clock
 *
 * Pure arithmetic over the plan, the parsed hours and the timezone. The same inputs
 * always produce the same repair, which is what makes it safe to run without asking.
 */

export type ScheduleRepairChange = {
  dayNumber: number;
  itemId: string;
  placeName: string;
  from: { startTime: string; endTime: string };
  to: { startTime: string; endTime: string };
  /** The interval the stop was moved into, verbatim from the parsed hours. */
  interval: OpeningInterval;
};

export type ScheduleRepairResult = {
  plan: TripPlan;
  changes: ScheduleRepairChange[];
  /** Conflicts still present afterwards, by item id. Reported, never hidden. */
  unresolvedItemIds: string[];
};

export type RepairScheduleInput = {
  plan: TripPlan;
  /** Absent means no hours can be evaluated, so there is nothing to repair. */
  timezone?: string | null;
};

export function repairScheduleConflicts(
  input: RepairScheduleInput,
): ScheduleRepairResult {
  const timezone = input.timezone ?? null;

  if (!timezone) {
    return { plan: input.plan, changes: [], unresolvedItemIds: [] };
  }

  const changes: ScheduleRepairChange[] = [];
  const unresolvedItemIds: string[] = [];

  const days = input.plan.days.map((day) => {
    const repaired = repairDay({ day, timezone });
    changes.push(...repaired.changes);
    unresolvedItemIds.push(...repaired.unresolvedItemIds);
    return repaired.day;
  });

  if (changes.length === 0) {
    return { plan: input.plan, changes: [], unresolvedItemIds };
  }

  return { plan: { ...input.plan, days }, changes, unresolvedItemIds };
}

function repairDay(context: { day: ItineraryDay; timezone: string }): {
  day: ItineraryDay;
  changes: ScheduleRepairChange[];
  unresolvedItemIds: string[];
} {
  const { day, timezone } = context;

  const conflicted = day.items.filter(
    (item) =>
      evaluateItem(item, day.date, timezone).status === "confirmed_closed",
  );

  if (conflicted.length === 0) {
    return { day, changes: [], unresolvedItemIds: [] };
  }

  const changes: ScheduleRepairChange[] = [];
  const unresolvedItemIds: string[] = [];
  let items = day.items;

  for (const item of conflicted) {
    const moved = moveIntoOpeningHours({ item, items, day, timezone });
    if (!moved) {
      unresolvedItemIds.push(item.id);
      continue;
    }

    /**
     * Applied only if it verifies.
     *
     * The moved stop must itself come out `confirmed_open`, and the day must still be a
     * valid schedule with the move in place. Either check failing discards *this* move
     * and leaves the conflict reported — the alternative is a day that was rearranged
     * and is still wrong.
     */
    const candidateItems = items.map((entry) =>
      entry.id === item.id ? moved.item : entry,
    );

    if (
      evaluateItem(moved.item, day.date, timezone).status !== "confirmed_open" ||
      !scheduleIsSound(candidateItems)
    ) {
      unresolvedItemIds.push(item.id);
      continue;
    }

    items = candidateItems;
    changes.push(moved.change);
  }

  if (changes.length === 0) {
    return { day, changes: [], unresolvedItemIds };
  }

  /**
   * Re-sorted by time, and `order` renumbered to match.
   *
   * A stop moved from the morning to the afternoon is out of itinerary order, and
   * `order` is what the cards and the routing legs are built from — leaving it stale
   * would mean a day whose displayed sequence and whose actual times disagree.
   */
  const ordered = [...items]
    .sort((a, b) => minutesOfDay(a.startTime) - minutesOfDay(b.startTime))
    .map((item, index) => (item.order === index ? item : { ...item, order: index }));

  return { day: { ...day, items: ordered }, changes, unresolvedItemIds };
}

/**
 * The earliest slot on the day, inside published hours, that this stop fits into.
 *
 * "Earliest" rather than "nearest to where it was" on purpose: it is the choice a
 * reader can predict without knowing the algorithm, and predictability is worth more
 * here than an optimum nobody asked for.
 *
 * Exported because the user-triggered "adjust the time" repair must offer the traveller
 * the *same* slot the automatic pass would have chosen. Two implementations of "where
 * does this fit" would eventually disagree, and the disagreement would show up as the
 * button moving a stop somewhere the report did not predict.
 */
export function findOpenSlotForItem(context: {
  item: ItineraryItem;
  items: ItineraryItem[];
  day: ItineraryDay;
  timezone: string;
}): { item: ItineraryItem; change: ScheduleRepairChange } | null {
  return moveIntoOpeningHours(context);
}

function moveIntoOpeningHours(context: {
  item: ItineraryItem;
  items: ItineraryItem[];
  day: ItineraryDay;
  timezone: string;
}): { item: ItineraryItem; change: ScheduleRepairChange } | null {
  const { item, items, day, timezone } = context;
  if (!item.place) return null;

  const intervals = openIntervalsForDate({
    ...(item.place.openingHours
      ? { openingHours: item.place.openingHours }
      : {}),
    date: day.date,
    timezone,
  });
  if (intervals.length === 0) return null;

  const start = minutesOfDay(item.startTime);
  const end = minutesOfDay(item.endTime);
  const duration = end - start;
  if (duration <= 0) return null;

  // The gaps the other stops leave, so a move cannot land on top of one.
  const blocked = items
    .filter((entry) => entry.id !== item.id)
    .map((entry) => ({
      from: minutesOfDay(entry.startTime),
      to: minutesOfDay(entry.endTime),
      isStop: entry.status === "confirmed" && entry.place !== null,
    }))
    .sort((a, b) => a.from - b.from);

  for (const interval of intervals) {
    // An overnight interval is not a slot this repair uses: the resulting stop would
    // cross midnight, and a day is a closed unit here.
    if (interval.crossesMidnight) continue;

    const opens = toMinutes(interval.opensAt);
    const closes = toMinutes(interval.closesAt);

    for (
      let candidate = Math.max(opens, SCHEDULE_LIMITS.earliestMinutes);
      candidate + duration <= Math.min(closes, SCHEDULE_LIMITS.latestMinutes);
      candidate += 15
    ) {
      if (!fits(candidate, candidate + duration, blocked)) continue;

      return {
        item: {
          ...item,
          startTime: formatMinutes(candidate),
          endTime: formatMinutes(candidate + duration),
        },
        change: {
          dayNumber: day.dayNumber,
          itemId: item.id,
          placeName: item.place.name,
          from: { startTime: item.startTime, endTime: item.endTime },
          to: {
            startTime: formatMinutes(candidate),
            endTime: formatMinutes(candidate + duration),
          },
          interval,
        },
      };
    }
  }

  return null;
}

/** Clear of every other stop, with the transition floor respected either side. */
function fits(
  start: number,
  end: number,
  blocked: { from: number; to: number; isStop: boolean }[],
): boolean {
  for (const entry of blocked) {
    const gap = entry.isStop ? SCHEDULE_LIMITS.minTransitionMinutes : 0;
    if (start < entry.to + gap && entry.from - gap < end) return false;
  }
  return true;
}

/**
 * The structural checks, re-run over the moved day.
 *
 * Deliberately not `validateSchedule`: that needs a pace and a meal baseline this
 * module does not hold, and a repair cannot change either of those anyway — it moves
 * one stop's clock. What it *can* break is ordering and spacing, and those are what is
 * checked.
 */
function scheduleIsSound(items: ItineraryItem[]): boolean {
  const scheduled = items
    .map((item) => ({
      start: minutesOfDay(item.startTime),
      end: minutesOfDay(item.endTime),
      isStop: item.status === "confirmed" && item.place !== null,
    }))
    .sort((a, b) => a.start - b.start);

  for (const entry of scheduled) {
    if (entry.end <= entry.start) return false;
    if (
      entry.start < SCHEDULE_LIMITS.earliestMinutes ||
      entry.end > SCHEDULE_LIMITS.latestMinutes
    ) {
      return false;
    }
  }

  for (let index = 1; index < scheduled.length; index += 1) {
    const previous = scheduled[index - 1];
    const current = scheduled[index];
    if (current.start < previous.end) return false;
    if (
      previous.isStop &&
      current.isStop &&
      current.start - previous.end < SCHEDULE_LIMITS.minTransitionMinutes
    ) {
      return false;
    }
  }

  return true;
}

function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
