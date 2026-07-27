import type { AccommodationStyle } from "@/lib/schemas";

import type { CostBand, DestinationCostProfile } from "./types";

/**
 * The curated destination profiles.
 *
 * ## Every number here was hand-entered
 *
 * Not generated, not scraped, not asked of a model. Each profile carries a `sourceNote`
 * describing what it is based on, and a `version` so a plan can record which one it used
 * and a later change can be told apart from the estimate it produced.
 *
 * They are **relative**, so none of them is a price and none of them can be out of date in
 * the way a price can. "Eating out in Dubai is dearer relative to a museum ticket than it
 * is in Athens" is a durable statement about a place; "a main course costs 90 AED" is not.
 *
 * ## Deliberately small
 *
 * Five cities and three fallbacks. A profile that claims to cover everywhere would be
 * mostly invention, and the fallbacks are honest about being coarse — a global match
 * produces a low-confidence estimate and the interface says so.
 *
 * Adding a city means adding hand-checked numbers and a `sourceNote`. It is not a data
 * pipeline and should not become one without the sourcing to justify it.
 */

/** The baseline every profile is relative to. `1.0` throughout, by definition. */
const BASELINE: DestinationCostProfile["relativeCost"] = {
  snack: { low: 0.7, typical: 1, high: 1.5, unit: "per-person" },
  "casual-meal": { low: 0.7, typical: 1, high: 1.5, unit: "per-person" },
  "sit-down-meal": { low: 0.7, typical: 1, high: 1.6, unit: "per-person" },
  "premium-meal": { low: 0.8, typical: 1, high: 1.8, unit: "per-person" },
  ticket: { low: 0.6, typical: 1, high: 1.6, unit: "per-person" },
  night: { low: 0.6, typical: 1, high: 1.9, unit: "per-night" },
};

/** Accommodation styles, relative to the destination's own `night` band. */
function stayBands(overrides: Partial<
  Record<AccommodationStyle, number>
> = {}): Record<AccommodationStyle, CostBand> {
  const defaults: Record<AccommodationStyle, number> = {
    hostel: 0.4,
    apartment: 0.85,
    hotel: 1,
    boutique: 1.3,
    luxury: 2.2,
  };

  return Object.fromEntries(
    (Object.keys(defaults) as AccommodationStyle[]).map((style) => {
      const typical = overrides[style] ?? defaults[style];
      return [
        style,
        {
          low: round(typical * 0.7),
          typical,
          high: round(typical * 1.6),
          unit: "per-night" as const,
        },
      ];
    }),
  ) as Record<AccommodationStyle, CostBand>;
}

function scale(
  factors: Partial<Record<keyof typeof BASELINE, number>>,
): DestinationCostProfile["relativeCost"] {
  return Object.fromEntries(
    (Object.keys(BASELINE) as (keyof typeof BASELINE)[]).map((key) => {
      const factor = factors[key] ?? 1;
      const band = BASELINE[key];
      return [
        key,
        {
          low: round(band.low * factor),
          typical: round(band.typical * factor),
          high: round(band.high * factor),
          unit: band.unit,
        },
      ];
    }),
  ) as DestinationCostProfile["relativeCost"];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export const DESTINATION_COST_PROFILES: DestinationCostProfile[] = [
  {
    profileId: "lisbon",
    version: "1.0.0",
    destinationKeys: ["lisbon", "lisboa"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Hand-entered from the relative cost of eating out, museum entry and mid-range rooms in Lisbon compared with a Western European baseline. Relative figures only; no prices.",
    tier: "moderate",
    weights: {
      flights: 0.28,
      accommodation: 0.26,
      food: 0.24,
      activities: 0.13,
      localTransport: 0.05,
      buffer: 0.04,
    },
    // Eating out is inexpensive relative to Northern Europe; tickets are mid.
    relativeCost: scale({
      snack: 0.8,
      "casual-meal": 0.85,
      "sit-down-meal": 0.9,
      "premium-meal": 0.95,
      ticket: 0.9,
      night: 0.95,
    }),
    accommodation: stayBands(),
  },
  {
    profileId: "dubai",
    version: "1.0.0",
    destinationKeys: ["dubai", "abu dhabi"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Hand-entered from the relative cost of restaurant dining, paid attractions and hotel rooms in Dubai. Dining and rooms are dear relative to public transport, which is cheap.",
    tier: "expensive",
    weights: {
      flights: 0.24,
      accommodation: 0.3,
      food: 0.24,
      activities: 0.14,
      localTransport: 0.04,
      buffer: 0.04,
    },
    relativeCost: scale({
      snack: 1.2,
      "casual-meal": 1.35,
      "sit-down-meal": 1.5,
      "premium-meal": 1.7,
      ticket: 1.4,
      night: 1.35,
    }),
    accommodation: stayBands({ luxury: 2.8 }),
  },
  {
    profileId: "cape-town",
    version: "1.0.0",
    destinationKeys: ["cape town", "kaapstad"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Hand-entered from the relative cost of restaurant dining, attraction entry and guesthouse rooms in Cape Town, which are low relative to Europe while flights from Europe are long.",
    tier: "budget",
    weights: {
      flights: 0.38,
      accommodation: 0.22,
      food: 0.19,
      activities: 0.13,
      localTransport: 0.04,
      buffer: 0.04,
    },
    relativeCost: scale({
      snack: 0.55,
      "casual-meal": 0.6,
      "sit-down-meal": 0.65,
      "premium-meal": 0.7,
      ticket: 0.7,
      night: 0.7,
    }),
    accommodation: stayBands(),
  },
  {
    profileId: "athens",
    version: "1.0.0",
    destinationKeys: ["athens", "athina", "athína"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Hand-entered from the relative cost of tavernas, archaeological-site entry and mid-range rooms in Athens. Site entry is comparatively high against inexpensive dining.",
    tier: "moderate",
    weights: {
      flights: 0.27,
      accommodation: 0.24,
      food: 0.23,
      activities: 0.17,
      localTransport: 0.05,
      buffer: 0.04,
    },
    relativeCost: scale({
      snack: 0.75,
      "casual-meal": 0.8,
      "sit-down-meal": 0.85,
      "premium-meal": 0.9,
      ticket: 1.15,
      night: 0.85,
    }),
    accommodation: stayBands(),
  },
  {
    profileId: "barcelona",
    version: "1.0.0",
    destinationKeys: ["barcelona"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Hand-entered from the relative cost of dining, timed-entry attractions and mid-range rooms in Barcelona, where headline attractions are dear and rooms are seasonally high.",
    tier: "expensive",
    weights: {
      flights: 0.25,
      accommodation: 0.28,
      food: 0.23,
      activities: 0.16,
      localTransport: 0.04,
      buffer: 0.04,
    },
    relativeCost: scale({
      snack: 0.95,
      "casual-meal": 1,
      "sit-down-meal": 1.1,
      "premium-meal": 1.2,
      ticket: 1.35,
      night: 1.15,
    }),
    accommodation: stayBands(),
  },

  /* -- fallbacks, in decreasing specificity ------------------------------- */

  {
    profileId: "region-western-europe",
    version: "1.0.0",
    destinationKeys: [
      "fr", "de", "nl", "be", "at", "ch", "lu", "ie", "gb", "dk", "se", "no", "fi",
    ],
    updatedAt: "2026-07-27",
    sourceNote:
      "Regional fallback for Western and Northern Europe, where dining and rooms are high relative to the global baseline. Coarse by design.",
    tier: "expensive",
    weights: {
      flights: 0.24,
      accommodation: 0.29,
      food: 0.24,
      activities: 0.15,
      localTransport: 0.04,
      buffer: 0.04,
    },
    relativeCost: scale({
      snack: 1.15,
      "casual-meal": 1.2,
      "sit-down-meal": 1.25,
      "premium-meal": 1.3,
      ticket: 1.1,
      night: 1.25,
    }),
    accommodation: stayBands(),
  },
  {
    profileId: "region-southern-europe",
    version: "1.0.0",
    destinationKeys: ["pt", "es", "it", "gr", "hr", "si", "mt", "cy", "tr"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Regional fallback for Southern Europe, where dining is moderate and attraction entry varies widely. Coarse by design.",
    tier: "moderate",
    weights: {
      flights: 0.27,
      accommodation: 0.25,
      food: 0.23,
      activities: 0.16,
      localTransport: 0.05,
      buffer: 0.04,
    },
    relativeCost: scale({
      snack: 0.85,
      "casual-meal": 0.9,
      "sit-down-meal": 0.95,
      "premium-meal": 1,
      ticket: 1,
      night: 0.95,
    }),
    accommodation: stayBands(),
  },
  {
    /**
     * The global fallback, and the one every unmatched destination gets.
     *
     * Its weights and bands are the baseline itself, so an unmatched trip is allocated
     * exactly as it was before destination profiles existed. That is the point: adding
     * this feature must not change the answer for a destination it knows nothing about.
     */
    profileId: "global",
    version: "1.0.0",
    destinationKeys: ["*"],
    updatedAt: "2026-07-27",
    sourceNote:
      "Global fallback. Applies the generic baseline with no destination knowledge, so an unrecognised destination is estimated exactly as it was before profiles existed.",
    tier: "moderate",
    weights: {
      flights: 0.3,
      accommodation: 0.27,
      food: 0.22,
      activities: 0.12,
      localTransport: 0.05,
      buffer: 0.04,
    },
    relativeCost: BASELINE,
    accommodation: stayBands(),
  },
];

export const GLOBAL_PROFILE_ID = "global";
