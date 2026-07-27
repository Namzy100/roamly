import { describe, expect, it } from "vitest";

import { FIXTURE_GENERATION } from "@/lib/refinement/test-fixtures";
import type { TripGenerationContext } from "@/lib/schemas";

import {
  POOL_AGE_THRESHOLDS,
  canRefreshPool,
  describePoolAge,
  refreshUnavailableReason,
} from "./pool-age";

/** The fixture pool was created at this instant. Every age below is measured from it. */
const CREATED_AT = FIXTURE_GENERATION.placePool.createdAt;

function at(daysLater: number): Date {
  return new Date(Date.parse(CREATED_AT) + daysLater * 24 * 60 * 60 * 1_000);
}

function withPool(overrides: {
  createdAt?: string;
  poolId?: string;
}): TripGenerationContext {
  return {
    ...FIXTURE_GENERATION,
    placePool: {
      ...FIXTURE_GENERATION.placePool,
      ...(overrides.createdAt !== undefined
        ? { createdAt: overrides.createdAt }
        : {}),
      ...(overrides.poolId !== undefined ? { poolId: overrides.poolId } : {}),
    },
  };
}

describe("describePoolAge — the states", () => {
  it("is fresh under a week", () => {
    for (const days of [0, 1, 3, POOL_AGE_THRESHOLDS.freshDays - 1]) {
      const age = describePoolAge({ generation: FIXTURE_GENERATION, now: at(days) });
      expect(age.state, String(days)).toBe("fresh");
      expect(age.ageDays, String(days)).toBe(days);
    }
  });

  it("is aging from a week to a month", () => {
    for (const days of [
      POOL_AGE_THRESHOLDS.freshDays,
      14,
      POOL_AGE_THRESHOLDS.agingDays - 1,
    ]) {
      expect(
        describePoolAge({ generation: FIXTURE_GENERATION, now: at(days) }).state,
        String(days),
      ).toBe("aging");
    }
  });

  it("is stale from a month", () => {
    for (const days of [POOL_AGE_THRESHOLDS.agingDays, 90, 400]) {
      expect(
        describePoolAge({ generation: FIXTURE_GENERATION, now: at(days) }).state,
        String(days),
      ).toBe("stale");
    }
  });

  /** The boundaries, named explicitly — an off-by-one here would mislabel a whole week. */
  it("switches state exactly at the thresholds", () => {
    expect(
      describePoolAge({
        generation: FIXTURE_GENERATION,
        now: at(POOL_AGE_THRESHOLDS.freshDays - 0.5),
      }).state,
    ).toBe("fresh");
    expect(
      describePoolAge({
        generation: FIXTURE_GENERATION,
        now: at(POOL_AGE_THRESHOLDS.freshDays),
      }).state,
    ).toBe("aging");
    expect(
      describePoolAge({
        generation: FIXTURE_GENERATION,
        now: at(POOL_AGE_THRESHOLDS.agingDays),
      }).state,
    ).toBe("stale");
  });

  it("is unknown with no generation context", () => {
    const age = describePoolAge({ generation: null, now: at(0) });

    expect(age.state).toBe("unknown");
    expect(age.ageDays).toBeNull();
    expect(age.placeCount).toBe(0);
  });

  it("is unknown when the timestamp cannot be read", () => {
    const age = describePoolAge({
      generation: withPool({ createdAt: "not-a-date" }),
      now: at(0),
    });

    expect(age.state).toBe("unknown");
    expect(age.ageDays).toBeNull();
    // The place count is still real and still worth showing.
    expect(age.placeCount).toBeGreaterThan(0);
  });

  it("reports the place count", () => {
    expect(
      describePoolAge({ generation: FIXTURE_GENERATION, now: at(0) }).placeCount,
    ).toBe(FIXTURE_GENERATION.placePool.places.length);
  });
});

describe("describePoolAge — the clock", () => {
  /**
   * `now` is an argument, never read. A component that read the clock during render would
   * hydrate differently from the server, and a test that read it would pass today and fail in a
   * month.
   */
  it("depends only on the instant it is given", () => {
    const first = describePoolAge({ generation: FIXTURE_GENERATION, now: at(10) });
    const second = describePoolAge({ generation: FIXTURE_GENERATION, now: at(10) });

    expect(first).toEqual(second);
  });

  it("survives a device clock set behind the pool's timestamp", () => {
    const age = describePoolAge({ generation: FIXTURE_GENERATION, now: at(-30) });

    // Clamped rather than reported as "−30 days ago", which is nonsense.
    expect(age.ageDays).toBe(0);
    expect(age.state).toBe("fresh");
  });

  it("does not read process.env.TZ", () => {
    const original = process.env.TZ;
    const labels: string[] = [];

    try {
      for (const zone of ["Pacific/Honolulu", "Asia/Tokyo", "UTC"]) {
        process.env.TZ = zone;
        labels.push(
          describePoolAge({ generation: FIXTURE_GENERATION, now: at(12) }).label,
        );
      }
    } finally {
      process.env.TZ = original;
    }

    expect(new Set(labels).size).toBe(1);
  });
});

describe("describePoolAge — the wording", () => {
  /**
   * The rule the whole module exists to keep: the age of a cache is not a claim about the
   * places. "May be outdated" is sayable; "is outdated" is not.
   */
  it("never claims the places have closed or become invalid", () => {
    for (const days of [0, 3, 10, 60]) {
      const { label } = describePoolAge({
        generation: FIXTURE_GENERATION,
        now: at(days),
      });
      expect(label.toLowerCase(), String(days)).not.toContain("closed");
      expect(label.toLowerCase(), String(days)).not.toContain("invalid");
      expect(label.toLowerCase(), String(days)).not.toContain("no longer");
    }
  });

  it("hedges a stale pool rather than asserting it", () => {
    const { label } = describePoolAge({
      generation: FIXTURE_GENERATION,
      now: at(60),
    });

    expect(label).toContain("may be outdated");
  });

  it("says today and yesterday in words", () => {
    expect(
      describePoolAge({ generation: FIXTURE_GENERATION, now: at(0) }).label,
    ).toContain("today");
    expect(
      describePoolAge({ generation: FIXTURE_GENERATION, now: at(1) }).label,
    ).toContain("yesterday");
  });
});

describe("canRefreshPool", () => {
  it("is true for a trip built from a recorded search", () => {
    expect(canRefreshPool(FIXTURE_GENERATION)).toBe(true);
    expect(refreshUnavailableReason(FIXTURE_GENERATION)).toBeNull();
  });

  /**
   * The sample trip has no OSM search behind it, and inventing one so the button could be
   * enabled would be fabricating provenance to tidy an interface.
   */
  it("is false with no generation context, and explains why", () => {
    expect(canRefreshPool(null)).toBe(false);
    expect(refreshUnavailableReason(null)).toContain("sample itinerary");
  });

  it("is false for a pool derived from the plan rather than from a search", () => {
    const derived = withPool({ poolId: "plan-derived:trip-abc" });

    expect(canRefreshPool(derived)).toBe(false);
    expect(refreshUnavailableReason(derived)).toContain(
      "did not come from a recorded OpenStreetMap search",
    );
  });
});
