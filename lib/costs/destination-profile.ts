import { DESTINATION_COST_PROFILES, GLOBAL_PROFILE_ID } from "./profiles";
import type { DestinationCostProfile, ResolvedCostProfile } from "./types";

/**
 * Which profile a destination gets.
 *
 * ## Most specific wins, and it always resolves
 *
 * City → country/region → global. Lookup never fails: an unrecognised destination gets the
 * global fallback, which reproduces the pre-profile baseline exactly. That matters — adding
 * this feature must not change the estimate for a destination it knows nothing about.
 *
 * What *does* change is the stated **confidence**, which drops with the specificity of the
 * match. A global-fallback estimate is not wrong, it is uninformed, and the interface says
 * which.
 *
 * ## Deterministic
 *
 * Keys are matched case-insensitively against a fixed table in a fixed order. The same
 * destination always resolves to the same profile, so an estimate is reproducible and a
 * regression is bisectable.
 */

const CONFIDENCE: Record<ResolvedCostProfile["match"], ResolvedCostProfile["confidence"]> =
  {
    city: "high",
    country: "medium",
    region: "medium",
    global: "low",
  };

export function resolveCostProfile(destination: {
  name?: string;
  displayName?: string;
  countryCode?: string;
}): ResolvedCostProfile {
  const cityKeys = cityCandidates(destination);

  // A city match is the only one that describes the actual destination.
  for (const profile of DESTINATION_COST_PROFILES) {
    if (profile.profileId === GLOBAL_PROFILE_ID) continue;
    for (const key of profile.destinationKeys) {
      if (cityKeys.includes(key)) {
        return { profile, match: "city", confidence: CONFIDENCE.city };
      }
    }
  }

  const country = destination.countryCode?.trim().toLowerCase();
  if (country) {
    for (const profile of DESTINATION_COST_PROFILES) {
      if (profile.profileId === GLOBAL_PROFILE_ID) continue;
      if (!profile.destinationKeys.includes(country)) continue;
      // A regional profile keyed by country code is a region match, not a country one:
      // it describes several countries and is coarse about all of them.
      const match = profile.profileId.startsWith("region-") ? "region" : "country";
      return { profile, match, confidence: CONFIDENCE[match] };
    }
  }

  return {
    profile: globalProfile(),
    match: "global",
    confidence: CONFIDENCE.global,
  };
}

export function globalProfile(): DestinationCostProfile {
  const profile = DESTINATION_COST_PROFILES.find(
    (entry) => entry.profileId === GLOBAL_PROFILE_ID,
  );
  if (!profile) {
    // A missing global fallback is a programming error, not a runtime condition: every
    // other path depends on it existing.
    throw new Error("The global cost profile is missing from the profile table");
  }
  return profile;
}

/** A profile by id, for re-estimating a plan against the one it recorded. */
export function costProfileById(
  profileId: string,
): DestinationCostProfile | null {
  return (
    DESTINATION_COST_PROFILES.find((entry) => entry.profileId === profileId) ?? null
  );
}

function cityCandidates(destination: {
  name?: string;
  displayName?: string;
}): string[] {
  const keys: string[] = [];

  const add = (value: string | undefined) => {
    const key = value?.trim().toLowerCase();
    if (key && key.length > 1 && !keys.includes(key)) keys.push(key);
  };

  add(destination.name);
  // The city is sometimes the leading segment of a display name rather than `name`.
  for (const segment of (destination.displayName ?? "").split(",")) add(segment);

  return keys;
}
