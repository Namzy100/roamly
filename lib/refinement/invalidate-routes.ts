import {
  deriveExpectedLegsForDay,
  owningItemIdForLeg,
  type ExpectedLeg,
} from "@/lib/plan";
import type {
  AppliedRoutingPolicy,
  ItineraryDay,
  ItineraryItem,
  TravelSegment,
  TripPlan,
} from "@/lib/schemas";

/**
 * Re-keying travel segments onto a changed itinerary.
 *
 * ## Why this is a few lines rather than a case analysis
 *
 * The brief lists five situations — replace, remove, add, reorder, regenerate —
 * each with its own set of legs to invalidate. Implementing them as five rules
 * would mean five chances to get one wrong, and the wrong one would leave a routed
 * line on the map for a journey nobody makes.
 *
 * They collapse into one rule because of how leg identity was built:
 *
 *   `day:{n}:from:{itemId}:to:{itemId}:mode:{mode}`
 *
 * A leg id **is** its adjacency. So "which stored results still describe a real
 * journey?" is answered by set membership: derive the expected legs of the new
 * itinerary, and keep exactly the segments whose id is in that set.
 *
 *  - **replace an item** — its incoming and outgoing legs both had the old item id
 *    in them, so both ids vanish and both segments are dropped. Two new ids appear
 *    with no segment: pending.
 *  - **remove an item** — the same, plus the surviving neighbours produce a new
 *    id, pending.
 *  - **add an item** — the previously direct leg's id is gone; two new ones appear.
 *  - **reorder a day** — every changed adjacency changes its id; unchanged ones do
 *    not.
 *  - **regenerate** — nearly every id changes, and any that survives genuinely
 *    describes the same journey and may honestly keep its result.
 *
 * A leg whose *mode* changed also changes id, which matters: if a replacement moves
 * a stop 3 km away, the old walking result cannot survive as a driving leg.
 *
 * This is exactly the property `lib/routing/leg-id.ts` was designed for, and it is
 * why nothing here compares array positions.
 *
 * ## What is never done
 *
 * No geometry is retained for an adjacency that no longer exists. No estimate is
 * fabricated to fill a pending leg — a leg with no result is `null`, which the
 * derivation layer already reports as pending, and the traveller is told the count.
 * Nothing is mutated: a new day is returned.
 */

export type RekeyedDay = {
  day: ItineraryDay;
  /** Ids whose stored result was dropped because its adjacency is gone. */
  invalidatedLegIds: string[];
  /** Expected legs that now have no result. */
  pendingLegIds: string[];
};

export function rekeyDaySegments(input: {
  day: ItineraryDay;
  plan: TripPlan;
  policy: AppliedRoutingPolicy;
}): RekeyedDay {
  const expected = deriveExpectedLegsForDay(input.plan, input.day, input.policy);
  const expectedById = new Map(expected.map((leg) => [leg.id, leg]));

  /**
   * Existing segments by their own id.
   *
   * Read from the segment rather than from the item that carries it, because the
   * segment's `id` is the leg identity and the item it hangs off is an
   * implementation detail of where it is stored.
   */
  const existing = new Map<string, TravelSegment>();
  for (const item of input.day.items) {
    if (item.travelToNext) existing.set(item.travelToNext.id, item.travelToNext);
  }

  const invalidatedLegIds = [...existing.keys()].filter(
    (legId) => !expectedById.has(legId),
  );

  const legByOwner = new Map<string, ExpectedLeg>();
  for (const leg of expected) {
    const owner = owningItemIdForLeg(leg);
    if (owner !== null) legByOwner.set(owner, leg);
  }

  const items: ItineraryItem[] = input.day.items.map((item) => {
    const leg = legByOwner.get(item.id);
    // No eligible successor: this item carries no travel, whatever it carried
    // before. Dropping it is the correct outcome for a stop that became the last
    // of the day.
    if (!leg) {
      return item.travelToNext === null ? item : { ...item, travelToNext: null };
    }

    const retained = existing.get(leg.id) ?? null;
    return retained === item.travelToNext ? item : { ...item, travelToNext: retained };
  });

  const pendingLegIds = expected
    .filter((leg) => !existing.has(leg.id))
    .map((leg) => leg.id);

  return {
    day: { ...input.day, items },
    invalidatedLegIds,
    pendingLegIds,
  };
}

/**
 * The same re-keying across a whole plan.
 *
 * Used by regeneration and by any refinement that touches more than one day. Runs
 * over every day rather than only the changed ones: it is cheap, and a day that
 * *should* be untouched but is not is precisely the bug worth catching.
 */
export function rekeyPlanSegments(input: {
  plan: TripPlan;
  policy: AppliedRoutingPolicy;
}): {
  plan: TripPlan;
  invalidatedLegIds: string[];
  pendingLegIds: string[];
} {
  const invalidatedLegIds: string[] = [];
  const pendingLegIds: string[] = [];

  const days = input.plan.days.map((day) => {
    const rekeyed = rekeyDaySegments({
      day,
      plan: input.plan,
      policy: input.policy,
    });
    invalidatedLegIds.push(...rekeyed.invalidatedLegIds);
    pendingLegIds.push(...rekeyed.pendingLegIds);
    return rekeyed.day;
  });

  return {
    plan: { ...input.plan, days },
    invalidatedLegIds,
    pendingLegIds,
  };
}

/**
 * Drops every travel segment in a plan.
 *
 * Regeneration's case. A regenerated itinerary shares little more than its dates
 * with the old one, so keeping any routed leg would be keeping a measurement of a
 * journey that is no longer in the plan — even where an id coincidentally survives,
 * `rekeyPlanSegments` would retain it and that is *correct* for a targeted edit but
 * misleading after a wholesale replacement, where the traveller is told the routes
 * were cleared.
 *
 * `plan.routing` is set to null too: the applied policy and the coverage summary
 * both describe a run against an itinerary that no longer exists.
 */
export function clearAllRoutes(plan: TripPlan): {
  plan: TripPlan;
  invalidatedLegIds: string[];
} {
  const invalidatedLegIds: string[] = [];

  const days = plan.days.map((day) => ({
    ...day,
    items: day.items.map((item) => {
      if (!item.travelToNext) return item;
      invalidatedLegIds.push(item.travelToNext.id);
      return { ...item, travelToNext: null };
    }),
    totalTravelMinutes: 0,
  }));

  return { plan: { ...plan, days, routing: null }, invalidatedLegIds };
}

/**
 * Which of a plan's currently expected legs a retry should attempt.
 *
 * The scope rules, and why each exists:
 *
 *  - **explicit `legIds`** — the "retry this one route" affordance. Filtered against
 *    the expected set, so an id from a stale render cannot cause a request for a
 *    journey the plan no longer contains.
 *  - **`unavailable-only`** — legs whose stored segment failed, plus legs with no
 *    segment at all. A retained estimate is deliberately *not* included: it is not
 *    a failure, and re-requesting every estimate would make "retry the failures"
 *    quietly mean "route the whole trip".
 *  - **`all`** — everything eligible, which is the existing recalculate behaviour.
 */
export function selectRetryLegs(input: {
  plan: TripPlan;
  policy: AppliedRoutingPolicy;
  scope: "unavailable-only" | "all";
  dayNumber?: number;
  legIds?: string[];
}): { legIds: string[]; rejectedLegIds: string[] } {
  const days =
    input.dayNumber === undefined
      ? input.plan.days
      : input.plan.days.filter((day) => day.dayNumber === input.dayNumber);

  const expected = days.flatMap((day) =>
    deriveExpectedLegsForDay(input.plan, day, input.policy),
  );
  const expectedIds = new Set(expected.map((leg) => leg.id));

  const segmentById = new Map<string, TravelSegment>();
  for (const day of input.plan.days) {
    for (const item of day.items) {
      if (item.travelToNext) segmentById.set(item.travelToNext.id, item.travelToNext);
    }
  }

  if (input.legIds && input.legIds.length > 0) {
    // Deduplicated, and only ids the plan currently expects.
    const requested = [...new Set(input.legIds)];
    return {
      legIds: requested.filter((legId) => expectedIds.has(legId)),
      rejectedLegIds: requested.filter((legId) => !expectedIds.has(legId)),
    };
  }

  if (input.scope === "all") {
    return { legIds: [...expectedIds], rejectedLegIds: [] };
  }

  return {
    legIds: [...expectedIds].filter((legId) => {
      const segment = segmentById.get(legId);
      // Missing (never attempted) or failed. A retained estimate is neither.
      return segment === undefined || segment.status === "unavailable";
    }),
    rejectedLegIds: [],
  };
}
