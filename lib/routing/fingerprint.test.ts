import { describe, expect, it } from "vitest";

import { routingPolicyForPace } from "@/lib/generate";
import type { AppliedRoutingPolicy } from "@/lib/schemas";

import {
  fingerprintForLeg,
  policyComponent,
  routeInputFingerprint,
  routeInputsMatch,
  segmentValidity,
  ROUTE_FINGERPRINT_VERSION,
  type RouteInputs,
} from "./fingerprint";
import type { DayLeg } from "./types";

/**
 * The fingerprint, tested for what it does and does not notice.
 *
 * The "does not notice" half matters as much as the other. A fingerprint that changed when a note was edited would clear
 * real provider measurements on every keystroke, and a team that watched that happen would reach for a way to switch it
 * off. So each field is asserted twice: once that a real input change invalidates, once that an unrelated edit does not.
 */

const POLICY: AppliedRoutingPolicy = routingPolicyForPace("balanced");

const LEG: DayLeg = {
  id: "day:1:from:item-a:to:item-b:mode:walk",
  dayNumber: 1,
  fromItemId: "item-a",
  toItemId: "item-b",
  fromPlaceId: "osm:node:1001",
  toPlaceId: "osm:node:2001",
  origin: { latitude: 38.7169, longitude: -9.1409 },
  destination: { latitude: 38.7248, longitude: -9.115 },
  mode: "walk",
  straightLineMeters: 2_400,
};

function inputs(overrides: Partial<RouteInputs> = {}): RouteInputs {
  return {
    dayNumber: LEG.dayNumber,
    fromItemId: LEG.fromItemId,
    toItemId: LEG.toItemId,
    fromPlaceId: LEG.fromPlaceId,
    toPlaceId: LEG.toPlaceId,
    origin: LEG.origin,
    destination: LEG.destination,
    mode: LEG.mode,
    ...overrides,
  };
}

describe("what changes the fingerprint", () => {
  it("is stable for identical inputs", () => {
    expect(routeInputFingerprint(inputs(), POLICY)).toBe(
      routeInputFingerprint(inputs(), POLICY),
    );
  });

  it("carries its version, so a future composition change compares unequal", () => {
    expect(
      routeInputFingerprint(inputs(), POLICY).startsWith(
        `${ROUTE_FINGERPRINT_VERSION}|`,
      ),
    ).toBe(true);
  });

  /**
   * The defect case, at the unit level.
   *
   * Same day, same item ids, same coordinate for the surviving endpoint — only the destination *place* changed. A leg id
   * would be identical here; the fingerprint is not.
   */
  it("changes when a place id changes under unchanged item ids", () => {
    expect(
      routeInputFingerprint(inputs({ toPlaceId: "osm:node:2002" }), POLICY),
    ).not.toBe(routeInputFingerprint(inputs(), POLICY));
  });

  it("changes when a coordinate changes under an unchanged place id", () => {
    expect(
      routeInputFingerprint(
        inputs({ destination: { latitude: 38.73, longitude: -9.115 } }),
        POLICY,
      ),
    ).not.toBe(routeInputFingerprint(inputs(), POLICY));
  });

  it("changes when the mode changes", () => {
    expect(routeInputFingerprint(inputs({ mode: "drive" }), POLICY)).not.toBe(
      routeInputFingerprint(inputs(), POLICY),
    );
  });

  it("changes when the routing policy changes", () => {
    const relaxed = routingPolicyForPace("relaxed");
    const packed = routingPolicyForPace("packed");

    expect(policyComponent(relaxed)).not.toBe(policyComponent(packed));
    expect(routeInputFingerprint(inputs(), relaxed)).not.toBe(
      routeInputFingerprint(inputs(), packed),
    );
  });

  it("changes when the day changes, so a Tuesday result cannot verify a Wednesday leg", () => {
    expect(routeInputFingerprint(inputs({ dayNumber: 2 }), POLICY)).not.toBe(
      routeInputFingerprint(inputs(), POLICY),
    );
  });

  /**
   * Float noise must not invalidate a route.
   *
   * Six decimal places is about 11 cm. Without the rounding, a coordinate that survived a JSON round-trip differently in its
   * fifteenth digit would read as a moved place, and every route in the trip would clear itself on reload.
   */
  it("ignores coordinate differences below 11 cm", () => {
    expect(
      routeInputFingerprint(
        inputs({
          origin: { latitude: 38.7169 + 1e-12, longitude: -9.1409 - 1e-12 },
        }),
        POLICY,
      ),
    ).toBe(routeInputFingerprint(inputs(), POLICY));
  });

  /**
   * Nothing a router did not consume is in it.
   *
   * A title, a note, a cost and a time are all absent from `RouteInputs` by construction — there is no field to pass them
   * in. This asserts the consequence: a leg's fingerprint is a function of its geometry and the policy, so an editorial or
   * scheduling change cannot reach it.
   */
  it("contains nothing but the routed inputs", () => {
    const value = routeInputFingerprint(inputs(), POLICY);

    expect(value).toContain("osm:node:1001");
    expect(value).toContain("osm:node:2001");
    expect(value).toContain("walk");
    expect(value).toContain("38.716900");

    expect(Object.keys(inputs()).sort()).toEqual([
      "dayNumber",
      "destination",
      "fromItemId",
      "fromPlaceId",
      "mode",
      "origin",
      "toItemId",
      "toPlaceId",
    ]);
  });

  it("derives the same value from a leg as from its parts", () => {
    expect(fingerprintForLeg(LEG, POLICY)).toBe(
      routeInputFingerprint(inputs(), POLICY),
    );
  });
});

describe("validity of a stored segment", () => {
  const fingerprinted = {
    fromPlaceId: LEG.fromPlaceId,
    toPlaceId: LEG.toPlaceId,
    inputFingerprint: fingerprintForLeg(LEG, POLICY),
  };

  it("verifies a segment whose fingerprint matches", () => {
    expect(segmentValidity(fingerprinted, LEG, POLICY)).toBe("verified");
    expect(routeInputsMatch(fingerprinted, LEG, POLICY)).toBe(true);
  });

  it("calls a segment stale when its fingerprint does not match", () => {
    const swapped: DayLeg = { ...LEG, toPlaceId: "osm:node:2002" };

    expect(segmentValidity(fingerprinted, swapped, POLICY)).toBe("stale");
    expect(routeInputsMatch(fingerprinted, swapped, POLICY)).toBe(false);
  });

  it("calls a segment stale when the policy has moved under it", () => {
    expect(
      segmentValidity(fingerprinted, LEG, routingPolicyForPace("packed")),
    ).toBe("stale");
  });

  /**
   * The compatibility decision, and why it is three states rather than two.
   *
   * A segment written before fingerprints existed carries none. Calling it `stale` would clear every route in every saved
   * trip the first time this ran, destroying real provider data to enforce a rule those legs predate. Calling it `verified`
   * would keep exactly the measurements this module exists to catch. So it is kept, checked as far as its endpoints allow,
   * and reported.
   */
  it("loads a legacy segment safely, as unverified rather than trusted", () => {
    const legacy = { fromPlaceId: LEG.fromPlaceId, toPlaceId: LEG.toPlaceId };

    expect(segmentValidity(legacy, LEG, POLICY)).toBe("unverified");
    expect(routeInputsMatch(legacy, LEG, POLICY)).toBe(true);
  });

  /** The swap is still caught without a fingerprint, because place ids are on every segment ever written. */
  it("treats a legacy segment whose endpoints moved as stale", () => {
    const legacy = { fromPlaceId: LEG.fromPlaceId, toPlaceId: LEG.toPlaceId };
    const swapped: DayLeg = { ...LEG, toPlaceId: "osm:node:2002" };

    expect(segmentValidity(legacy, swapped, POLICY)).toBe("stale");
  });

  /** A wrong fingerprint is not "absent". Only a genuinely missing one gets the legacy treatment. */
  it("does not treat a mismatched fingerprint as legacy", () => {
    expect(
      segmentValidity(
        { ...fingerprinted, inputFingerprint: "v1|nonsense" },
        LEG,
        POLICY,
      ),
    ).toBe("stale");
  });
});
