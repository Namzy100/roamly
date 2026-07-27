import type { AccommodationStyle, Currency, Pace } from "@/lib/schemas";

/**
 * Destination-aware cost estimates, without a single currency conversion.
 *
 * ## The design decision, and why it is the safe one
 *
 * A destination profile could hold money — "a museum in Lisbon costs €12". Then a
 * traveller budgeting in AED needs €12 converted, and a conversion is a **live financial
 * fact with a timestamp** that we have no feed for. Inventing today's rate would be a
 * fabrication of exactly the kind this codebase refuses, and it would be wrong in a way
 * nobody could see.
 *
 * So a profile holds **no money at all**. It holds:
 *
 *  - `weights` — how a trip's budget divides between categories at this destination
 *  - `relativeCost` — how expensive each kind of place is *relative to the others here*
 *
 * Both are dimensionless. The traveller's own budget and currency stay authoritative, and
 * every amount is allocated *from* that budget. There is no exchange rate anywhere,
 * because there is nothing to exchange.
 *
 * ## Where absolute money still comes in
 *
 * `lib/plan/cost-bands.ts` holds per-currency absolute bands, hand-written per currency
 * and never derived from one another. Allocation produces a figure; the band clamps it so
 * a small budget cannot produce a €2 dinner and a large one cannot produce a €900 coffee.
 *
 * The two compose cleanly: **the profile decides shape, the band decides plausibility.**
 *
 * ## What a profile is not
 *
 * Not a price list. Not researched per-venue. Not AI-authored — every number is
 * hand-entered with a `sourceNote` saying what it is based on, and versioned so a plan can
 * record which one it used.
 */

/**
 * The cost classes a profile prices, relative to each other.
 *
 * Deliberately the same vocabulary `lib/plan/cost-bands.ts` uses, so a profile and a band
 * cannot disagree about what kind of thing they are describing.
 */
export type CostClassKey =
  | "snack"
  | "casual-meal"
  | "sit-down-meal"
  | "premium-meal"
  | "ticket"
  | "night";

/**
 * A relative cost band.
 *
 * `1.0` means "the generic baseline for this class". `1.6` means half again as expensive
 * as the baseline. These are multipliers, never amounts — the `unit` says what the
 * multiplier applies to so a reader cannot mistake it for money.
 */
export type CostBand = {
  low: number;
  typical: number;
  high: number;
  unit: "per-person" | "per-night" | "per-trip" | "per-ride" | "per-item";
};

/** How a trip's budget divides. Normalised to sum to 1 at lookup time. */
export type CategoryWeights = {
  flights: number;
  accommodation: number;
  food: number;
  activities: number;
  localTransport: number;
  buffer: number;
};

export type DestinationCostProfile = {
  profileId: string;
  version: string;
  /**
   * Lower-case keys this profile answers to: city names, and for a fallback, country
   * codes or a region marker. Matched in order of specificity by the lookup.
   */
  destinationKeys: string[];
  updatedAt: string;
  /** What the numbers are based on. Shown in the details panel. */
  sourceNote: string;
  /**
   * A coarse label for the UI. Not used in arithmetic — the weights and bands do the
   * work — but it is what a traveller understands at a glance.
   */
  tier: "budget" | "moderate" | "expensive" | "very-expensive";
  weights: CategoryWeights;
  relativeCost: Record<CostClassKey, CostBand>;
  /** Per accommodation style, relative to this destination's `night` band. */
  accommodation: Record<AccommodationStyle, CostBand>;
};

/** How specifically the profile matched, which drives confidence. */
export type ProfileMatch = "city" | "country" | "region" | "global";

export type ResolvedCostProfile = {
  profile: DestinationCostProfile;
  match: ProfileMatch;
  /**
   * Lower for a vaguer match. A global fallback is still *correct* — it allocates the
   * budget and reconciles — it is simply less informed, and the estimate says so.
   */
  confidence: "low" | "medium" | "high";
};

/* -------------------------------------------------------------------------- */
/* Allocation                                                                  */
/* -------------------------------------------------------------------------- */

export type AllocationInput = {
  budget: number;
  currency: Currency;
  travelers: number;
  dayCount: number;
  nightCount: number;
  pace: Pace;
  accommodationStyle: AccommodationStyle;
  profile: ResolvedCostProfile;
};

/**
 * The budget, divided.
 *
 * Every field is money in the request's currency. The identity
 * `flights + accommodation + food + activities + localTransport + buffer = budget`
 * holds exactly, and is asserted rather than assumed — a rounding leak here would show up
 * as a budget panel that does not add up.
 */
export type BudgetAllocation = {
  flights: number;
  accommodation: number;
  food: number;
  activities: number;
  localTransport: number;
  buffer: number;
  /** Per-night figure derived from `accommodation`, for the stay card. */
  nightlyRate: number;
  /** Per-traveller total, for the budget panel. */
  perTraveler: number;
  confidence: "low" | "medium" | "high";
  warnings: AllocationWarning[];
};

export type AllocationWarning = {
  code:
    | "no_destination_profile"
    | "budget_below_floor"
    | "buffer_reduced"
    | "allocation_clamped";
  message: string;
};

/**
 * The lowest total a trip can be planned against before the figures stop meaning
 * anything.
 *
 * Below this, allocation still succeeds and still reconciles — it simply warns, because
 * refusing to plan a cheap trip would be worse than planning one and saying the estimates
 * are tight.
 */
export const MIN_BUDGET_PER_TRAVELER_PER_DAY = 20;
