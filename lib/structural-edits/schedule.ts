import { minutesOfDay } from "@/lib/ai";
import { SCHEDULE_LIMITS } from "@/lib/refinement/schedule";
import type { ItemKind, ItineraryItem } from "@/lib/schemas";

import type { ResolvedPosition } from "./position";

/**
 * Deciding when a structurally-inserted stop happens.
 *
 * ## Explicit beats derived, and derived beats guessing
 *
 * If the traveller typed times, those are used — and validated. If they did not, a window
 * is derived from the neighbours at the chosen position: the stop goes as early as it can
 * inside that window, on a five-minute grid, with the transition floor respected on both
 * sides. If nothing fits, the edit **fails** and the interface offers exact time fields.
 *
 * The failure is the important half. The alternatives were inserting at an impossible time
 * (a schedule that says two places at once) or asking a model to invent a slot (a
 * judgement with no basis, expressed as a fact). Refusing and saying why is the only
 * honest third option.
 *
 * ## Why "as early as possible"
 *
 * It is the rule a reader can predict without knowing the algorithm. A midpoint or a
 * best-fit search would sometimes be tidier and would never be guessable, and a traveller
 * who cannot predict where a stop will land will not use the control twice.
 *
 * ## Pure
 *
 * No clock, no model, no network. The same day and the same position always produce the
 * same slot, which is what makes a preview truthful: what the dialog shows is what the
 * edit will do.
 */

/** Candidate starts step by this, so a derived time reads as a time somebody chose. */
const GRID_MINUTES = 5;

/**
 * How long a promoted backup is assumed to take, by kind.
 *
 * A backup carries no duration — it was never scheduled — so one has to come from
 * somewhere. These are the shapes generation itself produces, written down rather than
 * averaged out of the day: an average would move as the day was edited, which would make
 * the promotion dialog's preview change for reasons unrelated to the promotion.
 */
const DEFAULT_MINUTES: Record<ItemKind, number> = {
  meal: 75,
  attraction: 90,
  experience: 90,
  viewpoint: 45,
  rest: 60,
  transport: 45,
  logistics: 45,
};

export function defaultDurationMinutes(kind: ItemKind): number {
  return DEFAULT_MINUTES[kind];
}

export type TimeWindow = { startTime: string; endTime: string };

export type SlotFailure = {
  code: "invalid_times" | "no_slot_available";
  message: string;
};

/**
 * The window the neighbours leave open at an insertion point.
 *
 * Bounded below by the previous stop's end plus the transition floor (or the day's own
 * start), and above by the next stop's start minus it (or the day's own end). The floor is
 * applied only between two real visits, matching `validateSchedule` — a gap either side of
 * an unfilled placeholder is not a journey anyone makes.
 */
export function windowFor(position: ResolvedPosition): {
  earliest: number;
  latest: number;
} {
  const previousIsStop = isStop(position.before);
  const nextIsStop = isStop(position.after);

  const earliest = position.before
    ? minutesOfDay(position.before.endTime) +
      (previousIsStop ? SCHEDULE_LIMITS.minTransitionMinutes : 0)
    : SCHEDULE_LIMITS.earliestMinutes;

  const latest = position.after
    ? minutesOfDay(position.after.startTime) -
      (nextIsStop ? SCHEDULE_LIMITS.minTransitionMinutes : 0)
    : SCHEDULE_LIMITS.latestMinutes;

  return {
    earliest: Math.max(earliest, SCHEDULE_LIMITS.earliestMinutes),
    latest: Math.min(latest, SCHEDULE_LIMITS.latestMinutes),
  };
}

/**
 * The times a structural insertion will use, or why it cannot happen.
 *
 * `requested` is what the traveller typed, if anything. `durationMinutes` is the moved
 * item's own length, or a kind default for a promotion.
 */
export function resolveInsertionTimes(input: {
  position: ResolvedPosition;
  durationMinutes: number;
  requested?: { startTime?: string; endTime?: string };
}): { ok: true; value: TimeWindow } | { ok: false; error: SlotFailure } {
  const requested = input.requested;

  if (requested?.startTime !== undefined || requested?.endTime !== undefined) {
    /**
     * Both or neither.
     *
     * A start with no end would have to have a duration invented for it, which is the
     * guessing this module exists to avoid at the point where the traveller has been most
     * explicit about not wanting it guessed.
     */
    if (requested.startTime === undefined || requested.endTime === undefined) {
      return {
        ok: false,
        error: {
          code: "invalid_times",
          message: "Give both a start and an end time, or neither.",
        },
      };
    }
    return validateExplicit(requested.startTime, requested.endTime, input.position);
  }

  const { earliest, latest } = windowFor(input.position);
  const duration = Math.max(SCHEDULE_LIMITS.minItemMinutes, input.durationMinutes);

  for (
    let start = ceilToGrid(earliest);
    start + duration <= latest;
    start += GRID_MINUTES
  ) {
    return {
      ok: true,
      value: { startTime: format(start), endTime: format(start + duration) },
    };
  }

  return {
    ok: false,
    error: {
      code: "no_slot_available",
      message: `There is no free ${duration}-minute gap at that point in the day. Choose a different position, or set the times yourself.`,
    },
  };
}

/**
 * A traveller's own times, checked for the things arithmetic can check.
 *
 * Not checked here: opening hours. Those are evaluated separately and reported, because a
 * traveller may know something OpenStreetMap does not and their choice should stand with a
 * warning rather than be refused. What cannot stand is a structurally impossible day.
 */
function validateExplicit(
  startTime: string,
  endTime: string,
  position: ResolvedPosition,
): { ok: true; value: TimeWindow } | { ok: false; error: SlotFailure } {
  const start = minutesOfDay(startTime);
  const end = minutesOfDay(endTime);

  if (end <= start) {
    return {
      ok: false,
      error: {
        code: "invalid_times",
        message: `${endTime} is not after ${startTime}.`,
      },
    };
  }

  if (end - start < SCHEDULE_LIMITS.minItemMinutes) {
    return {
      ok: false,
      error: {
        code: "invalid_times",
        message: `A stop needs at least ${SCHEDULE_LIMITS.minItemMinutes} minutes.`,
      },
    };
  }

  if (
    start < SCHEDULE_LIMITS.earliestMinutes ||
    end > SCHEDULE_LIMITS.latestMinutes
  ) {
    return {
      ok: false,
      error: {
        code: "invalid_times",
        message: `${startTime}–${endTime} falls outside the day's planning window.`,
      },
    };
  }

  /**
   * Checked against the *chosen position*, not merely against the day.
   *
   * Times that are free somewhere else in the day but collide with the neighbours here
   * would produce a stop whose sequence and clock disagree — and `validateSchedule` sorts
   * by time, so the day would silently reorder itself away from what was asked for.
   */
  const { earliest, latest } = windowFor(position);
  if (start < earliest || end > latest) {
    return {
      ok: false,
      error: {
        code: "invalid_times",
        message: `At that point in the day the free window is ${format(earliest)}–${format(latest)}, so ${startTime}–${endTime} does not fit. Choose a different position or different times.`,
      },
    };
  }

  return { ok: true, value: { startTime, endTime } };
}

/** The item's own length, for a move that keeps it. */
export function durationOf(item: ItineraryItem): number {
  return Math.max(
    SCHEDULE_LIMITS.minItemMinutes,
    minutesOfDay(item.endTime) - minutesOfDay(item.startTime),
  );
}

function isStop(item: ItineraryItem | null): boolean {
  return item !== null && item.status === "confirmed" && item.place !== null;
}

function ceilToGrid(minutes: number): number {
  return Math.ceil(minutes / GRID_MINUTES) * GRID_MINUTES;
}

/**
 * Minutes-of-day back to `HH:MM`.
 *
 * Exported because the Phase 8 resize derives a candidate end (or start) from a duration and has
 * to express it as a time before this module can validate it. A second formatter elsewhere would
 * be a second chance to emit `9:5` where the schema demands `09:05`.
 */
export function formatDayMinutes(total: number): string {
  return format(total);
}

function format(total: number): string {
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export { SCHEDULE_LIMITS };
