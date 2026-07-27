import { deriveDayLegs, type DayLeg } from "@/lib/routing";
import type {
  AppliedRoutingPolicy,
  ItineraryDay,
  TripPlan,
} from "@/lib/schemas";

/**
 * Which legs a plan expects, under a given policy.
 *
 * **The single authority.** Routing orchestration asks it what to request,
 * enrichment asks it which results are legitimate, completeness asks it what the
 * denominator is, and the tests assert against it. Deriving expected legs a
 * second time anywhere else would produce two answers to one question, and every
 * count in this phase — "3 of 8 legs routed" — is only meaningful because they
 * cannot disagree.
 *
 * It is a thin composition over `deriveDayLegs` rather than a reimplementation,
 * so the skip rules (unavailable items, placeless blocks, collapsed duplicates,
 * modes the policy declines to choose) live in exactly one place.
 *
 * ## What it never does
 *
 * Cross a day boundary. Reorder. Invent a stop. Turn a transit estimate into a
 * routable request — `TRANSIT` has no `RoutingMode`, so `deriveDayLegs` cannot
 * emit a leg for one, and an existing transit estimate simply stays an estimate.
 */

export type ExpectedLeg = DayLeg;

export function deriveExpectedLegs(
  plan: TripPlan,
  policy: AppliedRoutingPolicy,
): ExpectedLeg[] {
  return plan.days.flatMap((day) => deriveExpectedLegsForDay(plan, day, policy));
}

export function deriveExpectedLegsForDay(
  plan: TripPlan,
  day: ItineraryDay,
  policy: AppliedRoutingPolicy,
): ExpectedLeg[] {
  return deriveDayLegs({
    items: day.items,
    dayNumber: day.dayNumber,
    // A plan with no recommended stay cannot bracket its days at one, regardless
    // of policy: there is no endpoint to route from.
    accommodation: plan.accommodation?.place,
    modePolicy: policy.modePolicy,
    includeAccommodation: policy.accommodation === "bracket-day",
  });
}

/** Expected legs keyed by their canonical id, for O(1) lookup during enrichment. */
export function indexExpectedLegs(
  legs: ExpectedLeg[],
): Map<string, ExpectedLeg> {
  return new Map(legs.map((leg) => [leg.id, leg]));
}

/**
 * The leg, if any, that carries the travel *from* a given itinerary item.
 *
 * The itinerary stores travel on `item.travelToNext`, so enrichment has to map
 * from a leg back to the item that owns it. That is the leg's origin — except
 * for the accommodation's outbound leg, which no item owns and which is
 * therefore not attachable. Returning `null` for it is deliberate: bracketing
 * legs are routed and counted, but there is no card to hang them on until the
 * itinerary grows a representation for "leaving the hotel".
 */
export function owningItemIdForLeg(leg: ExpectedLeg): string | null {
  return leg.fromItemId.startsWith("@accommodation") ? null : leg.fromItemId;
}
