import type { AccommodationStyle, Currency, Pace } from "@/lib/schemas";

import { resolveCostProfile } from "./destination-profile";
import type { AllocationInput } from "./types";

/**
 * Cost-estimate fixtures.
 *
 * The shapes that break allocation arithmetic: a party of one and a party of six, a day
 * trip and a week, a destination the table knows and one it does not, and a budget so small
 * the figures stop meaning anything. Each is a case where a naive implementation produces
 * something visibly wrong — a leaked cent, a nightly rate for a trip with no nights, a
 * negative buffer.
 *
 * No network, no clock, no model. Every one of these is a plain object.
 */

/** Destinations, chosen for how each resolves rather than for where they are. */
export const COST_DESTINATIONS = {
  /** A city with its own profile: the high-confidence path. */
  supported: { name: "Lisbon", displayName: "Lisbon, Portugal", countryCode: "pt" },
  /** No city profile, but a regional one keyed by country code. */
  regional: { name: "Coimbra", displayName: "Coimbra, Portugal", countryCode: "pt" },
  /** A country the region tables do not cover: the global fallback. */
  global: { name: "Ulaanbaatar", displayName: "Ulaanbaatar, Mongolia", countryCode: "mn" },
  /** Nothing to go on at all. */
  unknown: {},
} as const;

const BASE = {
  currency: "EUR" as Currency,
  travelers: 2,
  dayCount: 4,
  nightCount: 3,
  pace: "balanced" as Pace,
  accommodationStyle: "hotel" as AccommodationStyle,
};

/** An allocation input, defaults filled in. */
export function allocationInput(
  overrides: Partial<Omit<AllocationInput, "profile">> & {
    destination?: { name?: string; displayName?: string; countryCode?: string };
  } = {},
): AllocationInput {
  const { destination, ...rest } = overrides;

  return {
    ...BASE,
    budget: 2_400,
    profile: resolveCostProfile(destination ?? COST_DESTINATIONS.supported),
    ...rest,
  };
}

/**
 * The scenarios worth naming.
 *
 * `insufficientBudget` warns rather than failing — refusing to plan a cheap trip would be
 * worse than planning it and saying the allowances are tight. `dayTrip` has no nights, so
 * its accommodation share has nowhere to go and must end up in the buffer rather than
 * quietly allocated to a room nobody sleeps in.
 */
export const ALLOCATION_SCENARIOS = {
  supportedCity: () => allocationInput(),
  regionalFallback: () =>
    allocationInput({ destination: COST_DESTINATIONS.regional }),
  globalFallback: () => allocationInput({ destination: COST_DESTINATIONS.global }),
  soloTraveller: () => allocationInput({ travelers: 1, budget: 1_200 }),
  largeParty: () => allocationInput({ travelers: 6, budget: 7_200 }),
  dayTrip: () => allocationInput({ dayCount: 1, nightCount: 0, budget: 300 }),
  wholeWeek: () => allocationInput({ dayCount: 7, nightCount: 6, budget: 4_200 }),
  insufficientBudget: () =>
    allocationInput({ budget: 120, travelers: 2, dayCount: 5, nightCount: 4 }),
  packedPace: () => allocationInput({ pace: "packed" }),
  relaxedPace: () => allocationInput({ pace: "relaxed" }),
  /** Every currency, to prove nothing is converted between them. */
  everyCurrency: () =>
    (["EUR", "USD", "GBP", "AED"] as Currency[]).map((currency) =>
      allocationInput({ currency }),
    ),
} as const;

/**
 * Budgets that stress the rounding.
 *
 * A budget with an odd number of cents is where a "round each of six shares" implementation
 * leaks, and the leak is visible to a traveller as a panel that does not add up.
 */
export const AWKWARD_BUDGETS = [
  0.03, 1, 7.77, 99.99, 333.33, 1_000.01, 12_345.67, 1_000_000,
] as const;
