import { describe, expect, it } from "vitest";

import { parseRoutingLegId } from "@/lib/routing";

import {
  deriveExpectedLegs,
  indexExpectedLegs,
  owningItemIdForLeg,
} from "./expected-legs";
import { planRoutingPolicy } from "./policy";
import {
  FIXTURE_PLACES as P,
  FIXTURE_POLICY,
  fixtureDay,
  fixtureItem,
  fixturePlan,
  fixturePlace,
} from "./test-fixtures";

/**
 * Expected-leg derivation at the plan level.
 *
 * The per-day rules are covered in `lib/routing/derive.test.ts`; what matters
 * here is that composing them across a plan keeps days independent and produces
 * identities that can be matched back later.
 */

describe("deriveExpectedLegs", () => {
  it("produces one leg per consecutive eligible pair, per day", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("d1i1", P.a),
        fixtureItem("d1i2", P.b),
        fixtureItem("d1i3", P.c),
      ]),
      fixtureDay(2, [fixtureItem("d2i1", P.a), fixtureItem("d2i2", P.b)]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);

    expect(legs).toHaveLength(3);
    expect(legs.map((leg) => leg.dayNumber)).toEqual([1, 1, 2]);
  });

  it("never joins the end of one day to the start of the next", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("d1i1", P.a), fixtureItem("d1i2", P.b)]),
      fixtureDay(2, [fixtureItem("d2i1", P.c), fixtureItem("d2i2", P.a)]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);

    expect(legs).toHaveLength(2);
    // No leg starts on day 1 and ends on day 2.
    for (const leg of legs) {
      const parts = parseRoutingLegId(leg.id);
      expect(parts?.dayNumber).toBe(leg.dayNumber);
    }
    expect(
      legs.some((leg) => leg.fromItemId === "d1i2" && leg.toItemId === "d2i1"),
    ).toBe(false);
  });

  it("skips unavailable items and bridges the gap", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a),
        fixtureItem("i2", P.b, { status: "unavailable" }),
        fixtureItem("i3", P.c),
      ]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);

    expect(legs).toHaveLength(1);
    expect(legs[0].fromItemId).toBe("i1");
    expect(legs[0].toItemId).toBe("i3");
  });

  it("skips placeless blocks", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a),
        fixtureItem("i2", null, { kind: "rest" }),
        fixtureItem("i3", P.c),
      ]),
    ]);

    expect(deriveExpectedLegs(plan, FIXTURE_POLICY)).toHaveLength(1);
  });

  it("expects nothing from a single-stop day", () => {
    const plan = fixturePlan([fixtureDay(1, [fixtureItem("i1", P.a)])]);
    expect(deriveExpectedLegs(plan, FIXTURE_POLICY)).toEqual([]);
  });

  it("collapses two consecutive stops at the same place", () => {
    // The documented rule: one location listed twice is not a journey.
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a),
        fixtureItem("i2", P.a),
        fixtureItem("i3", P.b),
      ]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);

    expect(legs).toHaveLength(1);
    expect(legs[0].fromItemId).toBe("i2");
    expect(legs[0].toItemId).toBe("i3");
  });

  it("excludes the accommodation under the default policy", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);
    expect(legs).toHaveLength(1);
    expect(legs[0].fromItemId).toBe("i1");
  });

  it("brackets the day when the policy asks", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);

    const legs = deriveExpectedLegs(
      plan,
      planRoutingPolicy({ accommodation: "bracket-day" }),
    );

    expect(legs).toHaveLength(3);
    expect(legs[0].fromItemId).toBe("@accommodation-origin");
    expect(legs[2].toItemId).toBe("@accommodation-return");
    expect(new Set(legs.map((leg) => leg.id)).size).toBe(3);
  });

  it("never emits a transit leg", () => {
    // `RoutingMode` has no transit member, so a transit estimate simply has no
    // routable form and is not expected.
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);

    for (const leg of deriveExpectedLegs(plan, FIXTURE_POLICY)) {
      expect(["walk", "drive", "bicycle"]).toContain(leg.mode);
    }
  });

  it("expects a drive for a long hop under the trip default", () => {
    const sintra = fixturePlace("sintra", 38.7979, -9.3907);
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", sintra)]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);
    expect(legs).toHaveLength(1);
    expect(legs[0].mode).toBe("drive");
  });

  it("expects a drive in the middle band under the trip default", () => {
    // The trip-level default enables driving in the 1.8–8 km band, so an
    // eligible leg is never silently dropped and reported as pending.
    const midBand = fixturePlace("mid", 38.74, -9.1);
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", midBand)]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);
    expect(legs).toHaveLength(1);
    expect(legs[0].mode).toBe("drive");
  });

  it("gives every leg a unique id", () => {
    const plan = fixturePlan([
      fixtureDay(1, [
        fixtureItem("i1", P.a),
        fixtureItem("i2", P.b),
        fixtureItem("i3", P.c),
      ]),
      fixtureDay(2, [fixtureItem("j1", P.a), fixtureItem("j2", P.b)]),
    ]);

    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);
    expect(new Set(legs.map((leg) => leg.id)).size).toBe(legs.length);
  });

  it("does not mutate the plan", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);
    const before = JSON.parse(JSON.stringify(plan));

    deriveExpectedLegs(plan, FIXTURE_POLICY);

    expect(plan).toEqual(before);
  });
});

describe("indexExpectedLegs", () => {
  it("keys by leg id", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);
    const legs = deriveExpectedLegs(plan, FIXTURE_POLICY);
    const index = indexExpectedLegs(legs);

    expect(index.size).toBe(1);
    expect(index.get(legs[0].id)).toBe(legs[0]);
  });
});

describe("owningItemIdForLeg", () => {
  it("is the leg's origin item", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);
    const [leg] = deriveExpectedLegs(plan, FIXTURE_POLICY);
    expect(owningItemIdForLeg(leg)).toBe("i1");
  });

  it("is null for a bracketing leg, which no card owns", () => {
    const plan = fixturePlan([
      fixtureDay(1, [fixtureItem("i1", P.a), fixtureItem("i2", P.b)]),
    ]);
    const legs = deriveExpectedLegs(
      plan,
      planRoutingPolicy({ accommodation: "bracket-day" }),
    );

    expect(owningItemIdForLeg(legs[0])).toBeNull();
    expect(owningItemIdForLeg(legs[1])).toBe("i1");
  });
});
