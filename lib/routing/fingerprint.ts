import type { AppliedRoutingPolicy } from "@/lib/schemas/routing-state";

import type { DayLeg, RouteLocation, RoutingMode } from "./types";

/**
 * The inputs a routed leg was computed from, as one comparable string.
 *
 * ## The defect this exists to close
 *
 * Leg identity is `day:{n}:from:{itemId}:to:{itemId}:mode:{mode}` — **item ids**, deliberately, because a market visited
 * twice in one day is two stops and each needs its own leg. `applySelectAlternative` keeps the item id when it swaps a
 * stop's place, on the grounds that the card should stay in place rather than appear to vanish.
 *
 * Both decisions are right on their own, and together they leave a hole. `rekeyDaySegments` decided which stored results
 * survive by asking whether their leg id is still expected — and after a place swap it still is. So the leg *into* the
 * swapped stop kept a routed distance, duration and drawn geometry measured to a **different building**, and nothing in
 * the plan disagreed. The traveller was shown "8 min walk" for a journey nobody had measured.
 *
 * A leg id answers "is this adjacency still in the plan". It cannot answer "was this result computed from the inputs the
 * plan now has", because it does not contain those inputs. This does.
 *
 * ## What is in it, and why each part
 *
 * `v1|day|fromItem|toItem|fromPlace|toPlace|fromLat,fromLng|toLat,toLng|mode|policy`
 *
 *  - **day and both item ids** — the leg's own identity, so a fingerprint cannot be compared across legs
 *  - **both canonical place ids** — the swap case. Different place, different fingerprint, whatever the item is called
 *  - **both coordinate pairs** — a pool refresh can move a place while keeping its id, and a route to the old position is a
 *    route to the wrong doorway
 *  - **mode** — a walking route and a driving route between two points are different paths
 *  - **policy** — the mode thresholds and the day-bracketing decide *which* legs exist and which mode each gets, so a
 *    policy change can silently change what a leg means
 *
 * What is deliberately **not** in it: times, titles, notes, costs, `order`. Editing a stop's note or nudging its time by
 * five minutes changes nothing a router consumed, and invalidating a measured route for either would throw away real
 * provider data to no purpose. If a future policy ever depends on time of day, the time belongs in `policyComponent` where
 * the dependency is visible rather than smuggled in here.
 *
 * ## Coordinates are rounded, on purpose
 *
 * Six decimal places, about 11 cm. Storing full float precision would make a fingerprint that differs in the fifteenth
 * digit — from a JSON round-trip, or from a provider re-emitting the same point — read as a changed input, and every route
 * in the trip would invalidate itself on reload. The rounding is what makes the comparison stable.
 *
 * Pure. No clock, no provider call, no store: validation must never trigger a network request, because a validity check
 * that costs a round trip is one nobody runs on every render.
 */

/** Bumped when the composition below changes, so old fingerprints compare unequal rather than half-equal. */
export const ROUTE_FINGERPRINT_VERSION = "v1";

/** About 11 cm. Fine enough that a real move is caught, coarse enough that float noise is not. */
const COORDINATE_PRECISION = 6;

function coordinate(location: RouteLocation): string {
  return `${location.latitude.toFixed(COORDINATE_PRECISION)},${location.longitude.toFixed(
    COORDINATE_PRECISION,
  )}`;
}

/**
 * The policy inputs that can change what a leg is, flattened deterministically.
 *
 * Every field of `AppliedRoutingPolicy` is included rather than a version number, because there is no version field to
 * include — and a hand-maintained one would be the thing somebody forgets to bump. Key order is fixed here rather than
 * taken from `Object.keys`, so the string cannot change because a schema was reordered.
 *
 * `existingSegments` is part of it: it decides whether a re-route replaces or preserves what is there, which changes what a
 * stored segment means even though it does not change the route itself.
 */
export function policyComponent(policy: AppliedRoutingPolicy): string {
  const mode = policy.modePolicy;

  return [
    `walk<=${mode.walkMaxMeters}`,
    `drive>=${mode.driveMinMeters}`,
    `middleBandDrive=${mode.allowDriveInMiddleBand}`,
    `forced=${mode.forcedMode ?? "none"}`,
    `accommodation=${policy.accommodation}`,
    `existing=${policy.existingSegments}`,
  ].join(",");
}

export type RouteInputs = {
  dayNumber: number;
  fromItemId: string;
  toItemId: string;
  fromPlaceId: string;
  toPlaceId: string;
  origin: RouteLocation;
  destination: RouteLocation;
  mode: RoutingMode;
};

export function routeInputFingerprint(
  inputs: RouteInputs,
  policy: AppliedRoutingPolicy,
): string {
  return [
    ROUTE_FINGERPRINT_VERSION,
    `d${inputs.dayNumber}`,
    inputs.fromItemId,
    inputs.toItemId,
    inputs.fromPlaceId,
    inputs.toPlaceId,
    coordinate(inputs.origin),
    coordinate(inputs.destination),
    inputs.mode,
    policyComponent(policy),
  ].join("|");
}

/** The fingerprint an expected leg would produce. The only way one should be built for storage. */
export function fingerprintForLeg(
  leg: DayLeg,
  policy: AppliedRoutingPolicy,
): string {
  return routeInputFingerprint(
    {
      dayNumber: leg.dayNumber,
      fromItemId: leg.fromItemId,
      toItemId: leg.toItemId,
      fromPlaceId: leg.fromPlaceId,
      toPlaceId: leg.toPlaceId,
      origin: leg.origin,
      destination: leg.destination,
      mode: leg.mode,
    },
    policy,
  );
}

/**
 * How much a stored segment's validity can be established.
 *
 *  - `verified` — it carries a fingerprint and the fingerprint matches. Trustworthy.
 *  - `stale` — it carries a fingerprint and the fingerprint does not match, **or** it carries none and its endpoints no
 *    longer match the leg. Either way the result describes something the plan no longer contains.
 *  - `unverified` — no fingerprint, but everything checkable still checks out. Written before fingerprints existed.
 *
 * The third arm is the compatibility decision, and it is a deliberate middle. Treating every unfingerprinted leg as `stale`
 * would clear every route in every saved trip the first time this code ran — destroying real provider data to enforce a
 * rule those legs predate. Treating them as `verified` would keep exactly the stale measurements this module exists to
 * catch.
 *
 * So they are kept, checked as far as they can be, and *reported* — the caller surfaces "recalculate to verify" rather than
 * silently trusting or silently discarding.
 */
export type SegmentValidity = "verified" | "unverified" | "stale";

export function segmentValidity(
  segment: {
    fromPlaceId: string;
    toPlaceId: string;
    inputFingerprint?: string;
  },
  leg: DayLeg,
  policy: AppliedRoutingPolicy,
): SegmentValidity {
  if (segment.inputFingerprint !== undefined) {
    return segment.inputFingerprint === fingerprintForLeg(leg, policy)
      ? "verified"
      : "stale";
  }

  /*
   * The legacy path: no fingerprint, so check what the record does carry.
   *
   * The place ids are the part that catches the swap — the failure that motivated this module — and they are present on
   * every segment ever written. What cannot be checked is a coordinate change under an unchanged place id, which is why
   * this returns `unverified` rather than `verified` even when the ids agree.
   */
  const endpointsAgree =
    segment.fromPlaceId === leg.fromPlaceId &&
    segment.toPlaceId === leg.toPlaceId;

  return endpointsAgree ? "unverified" : "stale";
}

/** The common question, phrased as one. A stale segment must not survive a re-key. */
export function routeInputsMatch(
  segment: {
    fromPlaceId: string;
    toPlaceId: string;
    inputFingerprint?: string;
  },
  leg: DayLeg,
  policy: AppliedRoutingPolicy,
): boolean {
  return segmentValidity(segment, leg, policy) !== "stale";
}
