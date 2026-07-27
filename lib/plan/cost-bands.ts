import type {
  CostEstimate,
  Currency,
  MealType,
  PlaceCategory,
} from "@/lib/schemas";

/**
 * Planning-estimate bands, and the wall between them and provider facts.
 *
 * ## What this is
 *
 * A table of what a visit *typically* costs, by kind of place, in each supported
 * currency. It is planning guidance and nothing more. It is the mechanism by which
 * a model may propose a figure without being able to certify one: a proposed
 * amount is clamped into the band for its category, so an itinerary can never
 * claim a €4 museum or a €900 coffee, and the number that reaches the traveller is
 * always inside a range a human chose.
 *
 * ## Why there is no currency conversion
 *
 * Each currency has its own hand-written table. None is derived from another by a
 * rate, and there is no conversion function anywhere in this module.
 *
 * That is a deliberate refusal, not an omission. A rate is a live financial fact
 * with a timestamp, and we have no feed for one — inventing today's EUR/AED rate to
 * fill a table would be precisely the fabrication the whole architecture is built
 * to prevent, and it would be wrong in a way nobody could see. Independent tables
 * are also simply more accurate: a coffee in Dubai and a coffee in Lisbon do not
 * differ by an exchange rate.
 *
 * The consequence, stated plainly: these are figures for a *typical* destination in
 * a *typical* season. Reykjavík and Rabat are both outside them, and the UI labels
 * every one of these numbers an estimate for that reason.
 *
 * ## What this is not
 *
 * Not a price. Not `PriceLevel` — that comes from a provider or is absent. Not a
 * booking quote. Nothing here may ever be attached to a `TripPlace`, because a
 * band is a fact about a *category* and a `TripPlace` field would read as a fact
 * about the *place*.
 */

/**
 * The cost classes. Kept small on purpose — a class per category would be a
 * hundred numbers nobody could review, and the resolution would be false anyway.
 */
export type CostClass =
  | "free"
  | "snack"
  | "casual-meal"
  | "sit-down-meal"
  | "premium-meal"
  | "ticket"
  | "night";

/** Per person, except `night`, which is per room. */
type Band = { min: number; typical: number; max: number };

const FREE: Band = { min: 0, typical: 0, max: 0 };

/**
 * Independent tables. Read down a column, not across a row — the rows are not
 * conversions of each other and the differences between them are real.
 */
const BANDS: Record<Currency, Record<CostClass, Band>> = {
  EUR: {
    free: FREE,
    snack: { min: 3, typical: 6, max: 14 },
    "casual-meal": { min: 9, typical: 17, max: 35 },
    "sit-down-meal": { min: 16, typical: 30, max: 65 },
    "premium-meal": { min: 38, typical: 68, max: 150 },
    ticket: { min: 5, typical: 12, max: 28 },
    night: { min: 55, typical: 120, max: 280 },
  },
  USD: {
    free: FREE,
    snack: { min: 4, typical: 8, max: 16 },
    "casual-meal": { min: 12, typical: 20, max: 42 },
    "sit-down-meal": { min: 20, typical: 36, max: 78 },
    "premium-meal": { min: 45, typical: 82, max: 180 },
    ticket: { min: 8, typical: 16, max: 34 },
    night: { min: 70, typical: 145, max: 330 },
  },
  GBP: {
    free: FREE,
    snack: { min: 3, typical: 6, max: 12 },
    "casual-meal": { min: 10, typical: 16, max: 34 },
    "sit-down-meal": { min: 16, typical: 28, max: 60 },
    "premium-meal": { min: 35, typical: 62, max: 135 },
    ticket: { min: 7, typical: 14, max: 28 },
    night: { min: 60, typical: 115, max: 260 },
  },
  AED: {
    free: FREE,
    snack: { min: 12, typical: 22, max: 48 },
    "casual-meal": { min: 38, typical: 68, max: 140 },
    "sit-down-meal": { min: 65, typical: 120, max: 240 },
    "premium-meal": { min: 150, typical: 260, max: 560 },
    ticket: { min: 20, typical: 45, max: 95 },
    night: { min: 240, typical: 450, max: 980 },
  },
};

/**
 * Flights, per traveller, as a very wide band.
 *
 * Wide because the input that would narrow it — the actual route — is not
 * something we price. A short hop and a long haul are both inside this range, and
 * a confident-looking narrow band would be the more dishonest choice. The model's
 * budget allocation picks the point inside it; the band only stops that point being
 * absurd.
 */
const FLIGHT_BANDS: Record<Currency, Band> = {
  EUR: { min: 45, typical: 320, max: 1_600 },
  USD: { min: 55, typical: 380, max: 1_900 },
  GBP: { min: 40, typical: 290, max: 1_450 },
  AED: { min: 200, typical: 1_300, max: 6_500 },
};

/**
 * Category → class.
 *
 * `free` covers the places where the *place* costs nothing to be at. A traveller
 * may well spend money at a market, and the itinerary can say so in a note — but
 * the entry cost of a market is zero, and a non-zero default would put invented
 * spending in the budget.
 */
const CATEGORY_CLASS: Record<PlaceCategory, CostClass> = {
  restaurant: "sit-down-meal",
  cafe: "snack",
  bar: "casual-meal",
  fast_food: "snack",
  hotel: "night",
  hostel: "night",
  guest_house: "night",
  museum: "ticket",
  gallery: "ticket",
  attraction: "ticket",
  monument: "free",
  viewpoint: "free",
  park: "free",
  garden: "free",
  beach: "free",
  market: "free",
  place_of_worship: "free",
  theatre: "ticket",
  music_venue: "ticket",
  shopping: "free",
  winery: "casual-meal",
  historic_site: "ticket",
};

/**
 * The class for one stop.
 *
 * `mealType` refines a restaurant: breakfast and lunch at the same restaurant are
 * not the same spend as dinner, and the itinerary knows which it scheduled.
 */
export function costClassFor(
  category: PlaceCategory,
  mealType: MealType | null,
): CostClass {
  if (category === "restaurant") {
    switch (mealType) {
      case "breakfast":
      case "snack":
        return "snack";
      case "lunch":
        return "casual-meal";
      default:
        return "sit-down-meal";
    }
  }
  if (mealType === "snack") return "snack";
  return CATEGORY_CLASS[category];
}

export function bandFor(currency: Currency, costClass: CostClass): Band {
  return BANDS[currency][costClass];
}

export function flightBandFor(currency: Currency): Band {
  return FLIGHT_BANDS[currency];
}

/**
 * The whole-party cost of one stop, clamped into its band.
 *
 * Returns `clamped` so the caller can record a warning. A model whose figures are
 * routinely clamped is worth knowing about, and silently correcting it would hide
 * that.
 *
 * `night` is per room rather than per person — a double room is not two singles —
 * and rooms are two to a room, rounded up. Everything else scales with the party.
 */
export function clampPartyCost(input: {
  proposed: number | null;
  currency: Currency;
  costClass: CostClass;
  travelers: number;
}): { amount: number; clamped: boolean } {
  const band = bandFor(input.currency, input.costClass);
  const units =
    input.costClass === "night"
      ? Math.max(1, Math.ceil(input.travelers / 2))
      : Math.max(1, input.travelers);

  const min = round(band.min * units);
  const max = round(band.max * units);

  if (input.proposed === null || !Number.isFinite(input.proposed)) {
    return { amount: round(band.typical * units), clamped: false };
  }

  const proposed = round(Math.max(0, input.proposed));
  if (proposed < min) return { amount: min, clamped: proposed !== min };
  if (proposed > max) return { amount: max, clamped: true };
  return { amount: proposed, clamped: false };
}

/**
 * The disclaimer, written once.
 *
 * `CostEstimate.disclaimer` is optional in the schema and mandatory here: a
 * generated figure that reaches a traveller without one is a number masquerading
 * as a price. Centralising the wording is the same discipline
 * `lib/routing/format.ts` applies to travel-time language — it is asserted in
 * tests rather than left to a reviewer to remember.
 */
export const COST_ESTIMATE_DISCLAIMER =
  "Planning estimate for the whole party, from typical prices for this kind of place. Not a live price, not a quote, and not checked with the venue.";

export const FLIGHT_ESTIMATE_BASIS =
  "Indicative fare band for a return economy ticket, allocated from your stated budget. Not a live quote — follow the search link for real prices.";

export const ACCOMMODATION_ESTIMATE_BASIS =
  "Nightly rate estimated from your stated budget and typical rates for this kind of stay. Not a live rate and not a booking.";

/** A complete, honest `CostEstimate`. The only way one should be constructed. */
export function buildCostEstimate(input: {
  amount: number;
  currency: Currency;
  confidence: CostEstimate["confidence"];
}): CostEstimate {
  return {
    amount: round(input.amount),
    currency: input.currency,
    // The only basis a generated figure may claim. A provider tag or a user-
    // supplied price is a different kind of number and does not come from here.
    basis: "category-estimate",
    confidence: input.confidence,
    disclaimer: COST_ESTIMATE_DISCLAIMER,
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
