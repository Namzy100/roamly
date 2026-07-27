// The file rather than the barrel: `lib/plan`'s barrel now re-exports the schedule
// repair, which reaches back into this module, and a barrel import here would close
// that loop for no benefit. `./policy` is a leaf.
import { planRoutingPolicy } from "@/lib/plan/policy";
import type { AppliedRoutingPolicy, Pace } from "@/lib/schemas";

/**
 * Pace → routing thresholds (ARCHITECTURE §22).
 *
 * ## Why the model does not get to set these
 *
 * A mode threshold decides whether the app tells a traveller to walk 2.5 km. That
 * is a claim about what is reasonable on foot, and it is a product decision
 * belonging to the same layer that owns "we do not claim live traffic". A model
 * moving it per trip would make the app's advice vary for reasons no one could
 * audit.
 *
 * What the model *does* shape is the day: how many stops, in what order, with what
 * theme. It structures the trip; the thresholds are the ruler the trip is measured
 * with, and the ruler does not bend.
 *
 * ## Why pace changes them at all
 *
 * Because it changes what the traveller asked for. Someone who chose "relaxed"
 * and gets "walk 2.8 km to lunch" has been given a packed trip with a relaxed
 * label. Shortening the walking band pushes those legs to a taxi, which is what
 * relaxed means in practice. "Packed" moves the other way: a traveller who wants
 * five stops a day is generally willing to walk between them, and routing a 2.5 km
 * hop as a drive would add a taxi they never needed.
 *
 * The policy is recorded in the generation context and applied when routing runs
 * later, so a trip generated as relaxed is still routed as relaxed a week
 * afterwards.
 */

/**
 * Walking ceilings, in metres.
 *
 * `DEFAULT_MODE_POLICY`'s own threshold is the `balanced` figure — deliberately, so
 * that a balanced trip and an ungenerated one route identically and the default
 * path stays the one that is best understood.
 */
export const WALK_THRESHOLD_METERS: Record<Pace, number> = {
  relaxed: 1_200,
  balanced: 1_800,
  packed: 2_500,
};

export function routingPolicyForPace(pace: Pace): AppliedRoutingPolicy {
  return planRoutingPolicy({
    modePolicy: { walkMaxMeters: WALK_THRESHOLD_METERS[pace] },
    /**
     * `none`, for every pace.
     *
     * Bracketing a day at the accommodation asserts a walk from the hotel to the
     * first stop, and a plan whose first item is a 09:00 café did not necessarily
     * begin with one — the traveller may have eaten at the hotel or come from the
     * airport. Pace is not evidence about that, so it does not change the answer.
     */
    accommodation: "none",
  });
}

/** Stops per day the pace implies. Used to sanity-check a generated day, not to trim one. */
export const STOPS_PER_DAY: Record<Pace, { min: number; max: number }> = {
  relaxed: { min: 2, max: 4 },
  balanced: { min: 3, max: 5 },
  packed: { min: 4, max: 6 },
};
