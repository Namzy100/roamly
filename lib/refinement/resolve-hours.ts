import { minutesOfDay } from "@/lib/ai";
import { kindForCategory } from "@/lib/generate/assemble-plan";
import {
  evaluateItem,
  findOpenSlotForItem,
  withDerivedDayTotals,
} from "@/lib/plan";
import type {
  ItineraryDay,
  ItineraryItem,
  TripGenerationContext,
  TripPlace,
  TripPlan,
} from "@/lib/schemas";

import { rebuildBudget } from "./replace-item";
import {
  SCHEDULE_LIMITS,
  currentMealTypes,
  validateSchedule,
} from "./schedule";
import type { RefinementError } from "./types";

/**
 * The traveller's own repairs for a schedule the published hours contradict.
 *
 * ## No model, no network, no endpoint
 *
 * All three resolutions are arithmetic over the plan and the trip's saved pool, so the
 * browser applies them itself and saves under the revision guard. There is no
 * `POST /api/trips/resolve-hours`, because there is nothing on the other side of it —
 * adding one for symmetry would put a 90 KB plan through a serialisation round trip to
 * compute something the client can compute exactly.
 *
 * ## Atomic, and validated before it is anything
 *
 * Each function builds a **candidate** plan in memory, runs the schedule validator over
 * the day it touched, and returns either the finished plan or an error. A failure returns
 * the error and *nothing else* — the caller still holds the plan it had, unmodified,
 * because nothing was mutated to get here.
 *
 * ## What is preserved, by reference
 *
 * Every other item and every other day is the same object it was. That is checkable with
 * `===` rather than deep equality, which is a much stronger claim: if some future edit
 * starts rebuilding unrelated items, a test fails and someone has to justify it.
 *
 * ## What is never done
 *
 * A place is never invented, and `replace-place` accepts only a `placeId` the trip's own
 * generation pool already vouches for. Nothing moves between days. No backup is promoted.
 * Routes are not measured, edited or invented — `travelToNext` is cleared where the
 * adjacency changed and left alone where it did not, and the caller re-keys the legs.
 */

export type ResolveOutcome =
  | { ok: true; plan: TripPlan; previousDay: ItineraryDay; message: string }
  | { ok: false; error: RefinementError };

type LocatedItem = {
  dayIndex: number;
  day: ItineraryDay;
  itemIndex: number;
  item: ItineraryItem;
};

/* -------------------------------------------------------------------------- */
/* resolve-hours-conflict                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The stop moved into an interval its published hours call open.
 *
 * Uses `findOpenSlotForItem`, the same slot-finder generation's automatic pass uses, so
 * the button moves the stop exactly where the report predicted. Two implementations of
 * "where does this fit" would eventually disagree, and the disagreement would be visible.
 */
export function applyHoursAdjustTime(input: {
  plan: TripPlan;
  dayNumber: number;
  itemId: string;
  timezone: string | null;
}): ResolveOutcome {
  const located = locate(input.plan, input.dayNumber, input.itemId);
  if (!located.ok) return located;

  const { dayIndex, day, itemIndex, item } = located.value;

  if (!input.timezone) {
    return {
      ok: false,
      error: {
        code: "hours_unknown",
        message:
          "This trip's destination timezone could not be determined, so there is no way to tell which times are inside the published hours.",
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    };
  }

  const slot = findOpenSlotForItem({
    item,
    items: day.items,
    day,
    timezone: input.timezone,
  });

  if (!slot) {
    return {
      ok: false,
      error: {
        code: "no_open_slot",
        message:
          "There is no time on this day that is both inside the published opening hours and free in the itinerary. Replacing the place or marking the slot open are the remaining options.",
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    };
  }

  return commit({
    plan: input.plan,
    dayIndex,
    day,
    items: reorder(
      replaceAt(day.items, itemIndex, { ...slot.item, travelToNext: null }),
    ),
    message: `“${item.title}” moved to ${slot.change.to.startTime}–${slot.change.to.endTime}, inside its published hours of ${slot.change.interval.opensAt}–${slot.change.interval.closesAt}.`,
  });
}

/**
 * A different place from the trip's own pool, in the same slot at the same time.
 *
 * The pool is the *saved search result set*, so this cannot introduce a place that was
 * never discovered — and it deliberately does not re-search. A replacement whose own
 * hours also clash is allowed and reported: the traveller chose it, and the report will
 * keep telling the truth about it.
 */
export function applyHoursReplacePlace(input: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
  dayNumber: number;
  itemId: string;
  placeId: string;
}): ResolveOutcome {
  const located = locate(input.plan, input.dayNumber, input.itemId);
  if (!located.ok) return located;

  const { dayIndex, day, itemIndex, item } = located.value;

  if (!input.generation) {
    return {
      ok: false,
      error: {
        code: "pool_unavailable",
        message:
          "This trip has no saved place pool, so there is no verified set of alternatives to choose from.",
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    };
  }

  const chosen = input.generation.placePool.places.find(
    (place) => place.placeId === input.placeId,
  );
  if (!chosen) {
    /**
     * The mechanical half of the no-invention rule, at this seam.
     *
     * A `placeId` that is not in the pool is refused outright rather than looked up
     * anywhere else. There is no fallback path, because a fallback is how a fabricated
     * place would get in.
     */
    return {
      ok: false,
      error: {
        code: "place_outside_pool",
        message:
          "That place is not part of this trip's saved search results, so it cannot be added to the itinerary.",
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    };
  }

  if (isInUse(input.plan, chosen.placeId, item.id)) {
    return {
      ok: false,
      error: {
        code: "place_already_used",
        message: `“${chosen.name}” is already somewhere in this trip.`,
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    };
  }

  const replacement: ItineraryItem = {
    ...item,
    /**
     * A new id, for the same reason `replace-item` mints one: the routes leaving the old
     * stop measured journeys to a different place, and reusing the id would let them
     * survive re-keying and attach real geometry to a journey nobody makes.
     */
    id: freeItemId(input.plan, item.id),
    kind: kindForCategory(chosen.category, item.mealType),
    title: item.mealType !== null ? item.title : chosen.name,
    rationale: `Swapped in from this trip's own search results, because the published hours for “${item.place?.name ?? item.title}” do not cover this slot.`,
    status: "confirmed",
    place: chosen,
    travelToNext: null,
  };

  return commit({
    plan: input.plan,
    dayIndex,
    day,
    items: replaceAt(day.items, itemIndex, replacement),
    message: `“${chosen.name}” replaces “${item.place?.name ?? item.title}” at ${item.startTime}.`,
  });
}

/**
 * The slot kept, the place dropped, the reason stated.
 *
 * The honest option, and the reason it exists: a traveller who knows the museum is shut
 * and does not want it swapped should be able to say so and see an open slot rather than
 * a stop they know is wrong. The same shape generation uses for a slot it could not fill.
 */
export function applyHoursMarkUnavailable(input: {
  plan: TripPlan;
  dayNumber: number;
  itemId: string;
}): ResolveOutcome {
  const located = locate(input.plan, input.dayNumber, input.itemId);
  if (!located.ok) return located;

  const { dayIndex, day, itemIndex, item } = located.value;

  if (item.status !== "confirmed" || item.place === null) {
    return {
      ok: false,
      error: {
        code: "no_change",
        message: "That slot is already open.",
        dayNumber: input.dayNumber,
        itemId: input.itemId,
      },
    };
  }

  const gap: ItineraryItem = {
    ...item,
    status: "unavailable",
    place: null,
    title: `${item.title} — closed at this time`,
    rationale: `OpenStreetMap's published hours for “${item.place.name}” do not cover ${item.startTime}–${item.endTime} on this date, and you chose to leave the slot open.`,
    estimatedCost: 0,
    costNote: null,
    bookingRequired: false,
    tip: null,
    travelToNext: null,
  };
  delete (gap as { costEstimate?: unknown }).costEstimate;

  return commit({
    plan: input.plan,
    dayIndex,
    day,
    items: replaceAt(day.items, itemIndex, gap),
    message: `“${item.place.name}” was removed from ${item.startTime} and the slot left open.`,
  });
}

/**
 * Whether a stop is currently in conflict, for enabling the repair controls.
 *
 * Asked of the same evaluator the report uses, so a button cannot appear for a stop the
 * report considers fine — or fail to appear for one it does not.
 */
export function itemHasHoursConflict(input: {
  plan: TripPlan;
  dayNumber: number;
  itemId: string;
  timezone: string | null;
}): boolean {
  const located = locate(input.plan, input.dayNumber, input.itemId);
  if (!located.ok) return false;

  return (
    evaluateItem(
      located.value.item,
      located.value.day.date,
      input.timezone ?? undefined,
    ).status === "confirmed_closed"
  );
}

/* -------------------------------------------------------------------------- */
/* Shared machinery                                                           */
/* -------------------------------------------------------------------------- */

function locate(
  plan: TripPlan,
  dayNumber: number,
  itemId: string,
): { ok: true; value: LocatedItem } | { ok: false; error: RefinementError } {
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

  const day = plan.days[dayIndex];
  const itemIndex = day.items.findIndex((item) => item.id === itemId);
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
    value: { dayIndex, day, itemIndex, item: day.items[itemIndex] },
  };
}

/**
 * The candidate day, validated, then the plan rebuilt around it.
 *
 * The single place a schedule change becomes a plan, so the validator cannot be skipped
 * by one of the four callers. `requiredMealTypes` comes from the day **as it was**: a
 * repair may move or swap a meal but not remove one, and taking the baseline from the new
 * day would make the check vacuous.
 */
function commit(context: {
  plan: TripPlan;
  dayIndex: number;
  day: ItineraryDay;
  items: ItineraryItem[];
  message: string;
}): ResolveOutcome {
  const violations = validateSchedule({
    dayNumber: context.day.dayNumber,
    items: context.items,
    pace: context.plan.request.pace,
    requiredMealTypes: currentMealTypes(context.day),
  });

  if (violations.length > 0) {
    return {
      ok: false,
      error: {
        code: "schedule_invalid",
        message: violations[0].message,
        dayNumber: context.day.dayNumber,
        ...(violations[0].itemId ? { itemId: violations[0].itemId } : {}),
      },
    };
  }

  const day = withDerivedDayTotals({ ...context.day, items: context.items });
  const days = context.plan.days.map((entry, index) =>
    index === context.dayIndex ? day : entry,
  );

  return {
    ok: true,
    plan: {
      ...context.plan,
      days,
      budget: rebuildBudget(context.plan, days),
    },
    previousDay: context.day,
    message: context.message,
  };
}

function replaceAt(
  items: ItineraryItem[],
  index: number,
  replacement: ItineraryItem,
): ItineraryItem[] {
  // Every other item is the same object it was, so preservation is `===`-checkable.
  return items.map((item, position) => (position === index ? replacement : item));
}

/** Sorted by start time with `order` renumbered, because a move can change sequence. */
function reorder(items: ItineraryItem[]): ItineraryItem[] {
  return [...items]
    .sort((a, b) => minutesOfDay(a.startTime) - minutesOfDay(b.startTime))
    .map((item, index) => (item.order === index ? item : { ...item, order: index }));
}

function isInUse(plan: TripPlan, placeId: string, exceptItemId: string): boolean {
  for (const day of plan.days) {
    for (const item of day.items) {
      if (item.id === exceptItemId) continue;
      if (item.place?.placeId === placeId) return true;
    }
  }
  return plan.accommodation?.place.placeId === placeId;
}

/** A free id derived from the old one, deterministically. Mirrors `nextItemId`. */
function freeItemId(plan: TripPlan, baseId: string): string {
  const used = new Set(
    plan.days.flatMap((day) => day.items.map((item) => item.id)),
  );
  const root = baseId.replace(/-h\d+$/, "");

  for (let attempt = 1; attempt < 1_000; attempt += 1) {
    const candidate = `${root}-h${attempt}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`Could not derive a free item id from "${baseId}"`);
}

/**
 * The alternatives worth offering for a conflicted stop.
 *
 * Same category, from the trip's own pool, not already in the trip, and — where their
 * hours *can* be read — open for the slot as it stands. A candidate whose hours are
 * unknown is included rather than excluded: absence of data is not evidence it is shut,
 * and excluding it would silently narrow the traveller's choice on no evidence.
 */
export function hoursConflictCandidates(input: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
  dayNumber: number;
  itemId: string;
  timezone: string | null;
  limit?: number;
}): TripPlace[] {
  const located = locate(input.plan, input.dayNumber, input.itemId);
  if (!located.ok || !input.generation) return [];

  const { day, item } = located.value;
  const category = item.place?.category;
  if (!category) return [];

  const open: TripPlace[] = [];
  const unknown: TripPlace[] = [];

  for (const place of input.generation.placePool.places) {
    if (place.category !== category) continue;
    if (place.placeId === item.place?.placeId) continue;
    if (isInUse(input.plan, place.placeId, item.id)) continue;

    const status = evaluateItem(
      { ...item, place },
      day.date,
      input.timezone ?? undefined,
    ).status;

    if (status === "confirmed_closed") continue;
    if (status === "confirmed_open") open.push(place);
    else unknown.push(place);
  }

  // Confirmed-open first, because that is the only group we can say anything about.
  return [...open, ...unknown].slice(0, input.limit ?? 6);
}

/** Re-exported so a caller reading a bound does not import two modules. */
export { SCHEDULE_LIMITS };
