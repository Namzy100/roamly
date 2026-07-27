import { segmentDurationMinutes } from "@/lib/schemas";
import type {
  BudgetSummary,
  ItineraryDay,
  RoutingCompletion,
  TravelSegment,
  TripPlan,
} from "@/lib/schemas";

import type { DayTravelSummary } from "./types";

/**
 * The one authoritative derivation of every total the plan reports.
 *
 * ## Canonical versus derived
 *
 * Canonical fields are the plan's inputs and are copied through untouched:
 * itinerary order, item identities, `placeId` references, dates and times, item
 * costs, the destination, the flight and accommodation estimates, and the five
 * **budget category amounts**.
 *
 * Derived fields are recomputed here on every build, and a caller-supplied value
 * for any of them is discarded rather than trusted:
 *
 *  - `item.travelToNext` (written by `enrich-routing.ts`)
 *  - `day.totalTravelMinutes`
 *  - `day.dayTotal`
 *  - `budget.byDay`, `budget.total`, `budget.remaining`, `budget.perTraveler`
 *  - `plan.routing.summary`
 *
 * The budget **categories** (`flights`, `accommodation`, `food`, `activities`,
 * `transport`) stay canonical, and deliberately so: the schema has no per-item
 * cost category, so there is nothing to derive them from. Pretending to
 * recompute them would mean inventing an attribution rule, which is exactly the
 * kind of quiet fabrication this codebase exists to avoid.
 */

/**
 * What `totalTravelMinutes` means, stated once.
 *
 * Routed durations plus retained estimates. An unavailable leg contributes
 * **zero minutes**, and so does a pending one — but neither is silently absorbed,
 * because `DayTravelSummary.completeness` travels with the number everywhere it
 * is rendered. Without that, a day whose every leg failed would read as a day
 * with no travel, which is the exact under-counting this phase must not do.
 */
export function deriveDayTravelSummary(
  day: ItineraryDay,
  options: { expectedLegs?: number | null } = {},
): DayTravelSummary {
  let routedDurationMinutes = 0;
  let estimatedDurationMinutes = 0;
  let routedDistanceMeters = 0;
  let estimatedDistanceMeters = 0;
  let routedLegs = 0;
  let estimatedLegs = 0;
  let unavailableLegs = 0;

  for (const segment of daySegments(day)) {
    switch (segment.status) {
      case "routed":
        routedLegs += 1;
        routedDurationMinutes += segment.durationMinutes;
        routedDistanceMeters += segment.distanceMeters;
        break;
      case "estimated":
        estimatedLegs += 1;
        estimatedDurationMinutes += segment.estimatedDurationMinutes;
        estimatedDistanceMeters += segment.estimatedDistanceMeters ?? 0;
        break;
      case "unavailable":
        unavailableLegs += 1;
        break;
    }
  }

  const attached = routedLegs + estimatedLegs + unavailableLegs;
  const expected = options.expectedLegs ?? null;
  // An expected count below the attached count would mean the policy changed
  // since the segments were written; clamp rather than report a negative.
  const pendingLegs = expected === null ? null : Math.max(0, expected - attached);

  return {
    dayNumber: day.dayNumber,
    knownDurationMinutes: routedDurationMinutes + estimatedDurationMinutes,
    routedDurationMinutes,
    estimatedDurationMinutes,
    routedDistanceMeters,
    estimatedDistanceMeters,
    routedLegs,
    estimatedLegs,
    unavailableLegs,
    pendingLegs,
    completeness: completionFor({
      expected: expected ?? attached,
      routed: routedLegs,
      unavailable: unavailableLegs,
      pending: pendingLegs ?? 0,
    }),
  };
}

/**
 * The completion verdict for one set of counts.
 *
 * Shared by day and trip so the two can never disagree about what "partial"
 * means. `unavailable` is reserved for "we tried everything and got nothing" —
 * a day with one routed leg and four failures is `partial`, because one real
 * route is genuinely more than none.
 */
export function completionFor(counts: {
  expected: number;
  routed: number;
  unavailable: number;
  pending: number;
}): RoutingCompletion {
  if (counts.expected === 0) return "not_attempted";
  if (counts.routed === counts.expected) return "complete";
  if (counts.routed === 0 && counts.unavailable === 0) return "not_attempted";
  if (counts.routed === 0) return "unavailable";
  return "partial";
}

/** Every travel segment on a day, in itinerary order. */
export function daySegments(day: ItineraryDay): TravelSegment[] {
  return day.items.flatMap((item) =>
    item.travelToNext ? [item.travelToNext] : [],
  );
}

/**
 * Recomputes every derived total on a day.
 *
 * `dayTotal` comes from the item costs and `totalTravelMinutes` from the
 * segments, so a day handed in with wrong totals comes back with right ones.
 */
export function withDerivedDayTotals(day: ItineraryDay): ItineraryDay {
  const travel = deriveDayTravelSummary(day);

  return {
    ...day,
    dayTotal: roundMoney(
      day.items.reduce((sum, item) => sum + item.estimatedCost, 0),
    ),
    totalTravelMinutes: travel.knownDurationMinutes,
  };
}

/**
 * Recomputes the derived parts of the budget.
 *
 * `byDay` follows the day totals, and `total`/`remaining`/`perTraveler` follow
 * the categories. The categories themselves are left exactly as given — see the
 * header note.
 */
export function withDerivedBudget(
  budget: BudgetSummary,
  days: ItineraryDay[],
  travelers: number,
): BudgetSummary {
  const total = roundMoney(
    budget.flights +
      budget.accommodation +
      budget.food +
      budget.activities +
      budget.transport,
  );

  return {
    ...budget,
    total,
    remaining: roundMoney(budget.requestedBudget - total),
    // Guard against a zero traveller count, which the request schema forbids but
    // which a hand-built fixture could still produce.
    perTraveler: roundMoney(total / Math.max(1, travelers)),
    byDay: days.map((day) => ({
      dayNumber: day.dayNumber,
      amount: day.dayTotal,
    })),
  };
}

/** Every day's travel summary, with pending counts where the policy is known. */
export function deriveTripTravelSummaries(
  plan: TripPlan,
  expectedLegsByDay: Map<number, number> | null,
): DayTravelSummary[] {
  return plan.days.map((day) =>
    deriveDayTravelSummary(day, {
      expectedLegs: expectedLegsByDay?.get(day.dayNumber) ?? null,
    }),
  );
}

/** Two decimal places, matching the sample plan's own rounding. */
function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Re-exported so callers reading a single segment do not import two modules. */
export { segmentDurationMinutes };
