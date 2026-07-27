import { describe, expect, it } from "vitest";

import {
  costProfileById,
  globalProfile,
  resolveCostProfile,
} from "./destination-profile";
import { COST_DESTINATIONS } from "./fixtures";
import { DESTINATION_COST_PROFILES, GLOBAL_PROFILE_ID } from "./profiles";
import { validateBandCoverage, validateProfileTable } from "./validate";

describe("resolveCostProfile", () => {
  it("matches a city with its own profile", () => {
    const resolved = resolveCostProfile(COST_DESTINATIONS.supported);

    expect(resolved.profile.profileId).toBe("lisbon");
    expect(resolved.match).toBe("city");
    expect(resolved.confidence).toBe("high");
  });

  it("matches a city named in a segment of the display name", () => {
    const resolved = resolveCostProfile({
      name: "Gràcia",
      displayName: "Gràcia, Barcelona, Catalonia, Spain",
      countryCode: "es",
    });

    expect(resolved.profile.profileId).toBe("barcelona");
    expect(resolved.match).toBe("city");
  });

  it("ignores case and whitespace when matching", () => {
    expect(resolveCostProfile({ name: "  CAPE TOWN " }).profile.profileId).toBe(
      "cape-town",
    );
  });

  it("falls back to a regional profile for a country with no city match", () => {
    const resolved = resolveCostProfile(COST_DESTINATIONS.regional);

    expect(resolved.profile.profileId).toBe("region-southern-europe");
    expect(resolved.match).toBe("region");
    expect(resolved.confidence).toBe("medium");
  });

  it("falls back to global for a country no region covers", () => {
    const resolved = resolveCostProfile(COST_DESTINATIONS.global);

    expect(resolved.profile.profileId).toBe(GLOBAL_PROFILE_ID);
    expect(resolved.match).toBe("global");
    expect(resolved.confidence).toBe("low");
  });

  it("resolves rather than failing when there is nothing to go on", () => {
    const resolved = resolveCostProfile(COST_DESTINATIONS.unknown);

    expect(resolved.profile.profileId).toBe(GLOBAL_PROFILE_ID);
    expect(resolved.match).toBe("global");
  });

  /**
   * Specificity has to win regardless of table order — Lisbon is both a city with its own
   * profile and a Portuguese city the regional profile claims, and if order decided the
   * answer, moving a row in `profiles.ts` would silently change every Lisbon estimate.
   */
  it("prefers the city profile over the region its country belongs to", () => {
    expect(
      resolveCostProfile({ name: "Lisbon", countryCode: "pt" }).profile.profileId,
    ).toBe("lisbon");
    expect(
      resolveCostProfile({ name: "Athens", countryCode: "gr" }).profile.profileId,
    ).toBe("athens");
  });

  it("is deterministic", () => {
    for (const destination of Object.values(COST_DESTINATIONS)) {
      expect(resolveCostProfile(destination).profile.profileId).toBe(
        resolveCostProfile(destination).profile.profileId,
      );
    }
  });
});

describe("globalProfile", () => {
  it("is the baseline, unmodified", () => {
    const global = globalProfile();

    expect(global.profileId).toBe(GLOBAL_PROFILE_ID);
    // Relative to itself, so every typical multiplier is exactly 1.
    for (const band of Object.values(global.relativeCost)) {
      expect(band.typical).toBe(1);
    }
  });
});

describe("costProfileById", () => {
  it("finds every profile in the table", () => {
    for (const profile of DESTINATION_COST_PROFILES) {
      expect(costProfileById(profile.profileId)).toBe(profile);
    }
  });

  it("returns null for an id it does not have", () => {
    expect(costProfileById("atlantis")).toBeNull();
    expect(costProfileById("")).toBeNull();
  });
});

/**
 * The curated table is hand-entered data, and hand-entered data has typos.
 *
 * A weight that sums to 0.97 would allocate 3 % of a budget to nothing; a duplicated
 * destination key would make table order decide the answer. Neither is caught by review
 * reliably, so both are asserted.
 */
describe("the profile table itself", () => {
  it("has no structural problems", () => {
    expect(validateProfileTable()).toEqual([]);
  });

  it("has an absolute band in every currency for every class a profile prices", () => {
    expect(validateBandCoverage()).toEqual([]);
  });

  it("contains a global fallback", () => {
    expect(
      DESTINATION_COST_PROFILES.filter(
        (profile) => profile.profileId === GLOBAL_PROFILE_ID,
      ),
    ).toHaveLength(1);
  });

  it("gives every profile a version, a date and a source note", () => {
    for (const profile of DESTINATION_COST_PROFILES) {
      expect(profile.version, profile.profileId).toMatch(/^\d+\.\d+\.\d+$/);
      expect(profile.updatedAt, profile.profileId).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(
        profile.sourceNote.length,
        profile.profileId,
      ).toBeGreaterThan(40);
    }
  });

  /**
   * The central design property: a profile holds no money. If a number here were ever an
   * amount, a traveller budgeting in AED would need it converted — and a conversion is a
   * live financial fact this codebase has no feed for and refuses to invent.
   */
  it("holds only dimensionless multipliers, never amounts", () => {
    for (const profile of DESTINATION_COST_PROFILES) {
      for (const [name, band] of Object.entries(profile.relativeCost)) {
        // A multiplier lives near 1. An amount would not.
        expect(band.low, `${profile.profileId} ${name}`).toBeGreaterThan(0);
        expect(band.high, `${profile.profileId} ${name}`).toBeLessThan(10);
      }
      for (const [name, band] of Object.entries(profile.accommodation)) {
        expect(band.high, `${profile.profileId} ${name}`).toBeLessThan(10);
      }
    }
  });

  it("declares no currency anywhere", () => {
    const serialised = JSON.stringify(DESTINATION_COST_PROFILES);
    for (const currency of ["EUR", "USD", "GBP", "AED", "€", "$", "£"]) {
      expect(serialised, currency).not.toContain(currency);
    }
  });
});
