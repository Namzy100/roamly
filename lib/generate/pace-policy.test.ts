import { describe, expect, it } from "vitest";

import { DEFAULT_ROUTING_POLICY } from "@/lib/plan";
import { DEFAULT_MODE_POLICY, selectMode } from "@/lib/routing";

import { WALK_THRESHOLD_METERS, routingPolicyForPace } from "./pace-policy";

describe("routingPolicyForPace", () => {
  it("shortens the walking band for a relaxed trip and lengthens it for a packed one", () => {
    expect(routingPolicyForPace("relaxed").modePolicy.walkMaxMeters).toBe(1_200);
    expect(routingPolicyForPace("packed").modePolicy.walkMaxMeters).toBe(2_500);
  });

  /**
   * Balanced deliberately equals the shared default, so a balanced trip and an
   * ungenerated one route identically — the default path stays the one that is best
   * understood.
   */
  it("leaves a balanced trip on the shared default threshold", () => {
    expect(routingPolicyForPace("balanced").modePolicy.walkMaxMeters).toBe(
      DEFAULT_MODE_POLICY.walkMaxMeters,
    );
    expect(routingPolicyForPace("balanced")).toEqual(DEFAULT_ROUTING_POLICY);
  });

  it("changes only the walking threshold", () => {
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      const policy = routingPolicyForPace(pace);

      expect(policy.modePolicy.driveMinMeters).toBe(
        DEFAULT_ROUTING_POLICY.modePolicy.driveMinMeters,
      );
      expect(policy.modePolicy.allowDriveInMiddleBand).toBe(
        DEFAULT_ROUTING_POLICY.modePolicy.allowDriveInMiddleBand,
      );
      expect(policy.existingSegments).toBe(DEFAULT_ROUTING_POLICY.existingSegments);
    }
  });

  it("never brackets the day at the accommodation, whatever the pace", () => {
    // Pace is not evidence that the traveller walked from the hotel to a 09:00 café.
    for (const pace of ["relaxed", "balanced", "packed"] as const) {
      expect(routingPolicyForPace(pace).accommodation).toBe("none");
    }
  });

  it("actually changes the mode chosen for a 1.5 km hop", () => {
    const distance = 1_500;

    expect(selectMode(distance, routingPolicyForPace("relaxed").modePolicy).mode).toBe(
      "drive",
    );
    expect(selectMode(distance, routingPolicyForPace("packed").modePolicy).mode).toBe(
      "walk",
    );
  });

  it("orders the thresholds monotonically", () => {
    expect(WALK_THRESHOLD_METERS.relaxed).toBeLessThan(
      WALK_THRESHOLD_METERS.balanced,
    );
    expect(WALK_THRESHOLD_METERS.balanced).toBeLessThan(
      WALK_THRESHOLD_METERS.packed,
    );
  });

  it("is a pure function of pace, and returns a fresh object each time", () => {
    const first = routingPolicyForPace("relaxed");
    const second = routingPolicyForPace("relaxed");

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    first.modePolicy.walkMaxMeters = 99;
    expect(routingPolicyForPace("relaxed").modePolicy.walkMaxMeters).toBe(1_200);
  });
});
