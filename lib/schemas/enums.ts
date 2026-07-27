import { z } from "zod";

/**
 * Closed vocabularies shared by the request and the plan.
 *
 * Each enum is paired with an ordered `*_OPTIONS` list carrying its display
 * label. The schema owns the valid values; the options list owns presentation.
 * Keeping them in one file means a new vibe or interest can never be added to
 * the UI without also being accepted by validation.
 */

export const CurrencySchema = z.enum(["EUR", "USD", "GBP", "AED"]);
export type Currency = z.infer<typeof CurrencySchema>;

export const VibeSchema = z.enum([
  "culture",
  "food",
  "nature",
  "nightlife",
  "relaxation",
  "adventure",
  "shopping",
  "romance",
]);
export type Vibe = z.infer<typeof VibeSchema>;

export const PaceSchema = z.enum(["relaxed", "balanced", "packed"]);
export type Pace = z.infer<typeof PaceSchema>;

export const AccommodationStyleSchema = z.enum([
  "boutique",
  "hotel",
  "apartment",
  "hostel",
  "luxury",
]);
export type AccommodationStyle = z.infer<typeof AccommodationStyleSchema>;

export const DietarySchema = z.enum([
  "none",
  "vegetarian",
  "vegan",
  "halal",
  "kosher",
  "gluten-free",
  "no-pork",
  "no-shellfish",
]);
export type Dietary = z.infer<typeof DietarySchema>;

export const InterestSchema = z.enum([
  "museums",
  "architecture",
  "history",
  "local-markets",
  "coffee",
  "wine",
  "street-food",
  "fine-dining",
  "live-music",
  "viewpoints",
  "beaches",
  "day-trips",
  "photography",
  "bookshops",
]);
export type Interest = z.infer<typeof InterestSchema>;

export const TravelModeSchema = z.enum(["WALK", "TRANSIT", "DRIVE", "BICYCLE"]);
export type TravelMode = z.infer<typeof TravelModeSchema>;

/**
 * The subset of `TravelMode` a routing provider can actually produce.
 *
 * `TRANSIT` is excluded because we cannot route it: no transit feed is loaded on
 * the free routing service, and labelling a walking or driving route as transit
 * would misdescribe what the traveller is being told to do. A transit leg can
 * still exist in a plan — as an **estimate**, which is what the sample data's
 * transit legs are — but never as a routed one. The type system enforces the
 * distinction rather than a code review having to catch it.
 */
export const RoutedTravelModeSchema = z.enum(["WALK", "DRIVE", "BICYCLE"]);
export type RoutedTravelMode = z.infer<typeof RoutedTravelModeSchema>;

/**
 * `transport` and `logistics` (Phase 5B) are the two things a generated day needs
 * that no place search can supply: getting between neighbourhoods or to an
 * airport, and checking in or out. They exist so those blocks can be *stated*
 * rather than omitted — a day whose 90-minute airport run is invisible reads as a
 * day with a suspiciously easy afternoon.
 *
 * Both carry `place: null`, so they never acquire a map marker or a routed leg.
 * Widening the enum is backwards-compatible: no stored plan can contain a value
 * that was not previously accepted.
 */
export const ItemKindSchema = z.enum([
  "meal",
  "attraction",
  "experience",
  "viewpoint",
  "rest",
  "transport",
  "logistics",
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const MealTypeSchema = z.enum(["breakfast", "lunch", "dinner", "snack"]);
export type MealType = z.infer<typeof MealTypeSchema>;

/**
 * Google Places (New) price bands, carried through verbatim so the eventual
 * live integration needs no translation layer on the way in.
 */
export const PriceLevelSchema = z.enum([
  "PRICE_LEVEL_FREE",
  "PRICE_LEVEL_INEXPENSIVE",
  "PRICE_LEVEL_MODERATE",
  "PRICE_LEVEL_EXPENSIVE",
  "PRICE_LEVEL_VERY_EXPENSIVE",
]);
export type PriceLevel = z.infer<typeof PriceLevelSchema>;

type Option<T extends string> = { value: T; label: string };

export const CURRENCY_OPTIONS: Option<Currency>[] = [
  { value: "EUR", label: "EUR — Euro" },
  { value: "USD", label: "USD — US Dollar" },
  { value: "GBP", label: "GBP — Pound Sterling" },
  { value: "AED", label: "AED — UAE Dirham" },
];

export const VIBE_OPTIONS: Option<Vibe>[] = [
  { value: "culture", label: "Culture" },
  { value: "food", label: "Food" },
  { value: "nature", label: "Nature" },
  { value: "nightlife", label: "Nightlife" },
  { value: "relaxation", label: "Relaxation" },
  { value: "adventure", label: "Adventure" },
  { value: "shopping", label: "Shopping" },
  { value: "romance", label: "Romance" },
];

export const PACE_OPTIONS: (Option<Pace> & { hint: string })[] = [
  { value: "relaxed", label: "Relaxed", hint: "2–3 stops a day" },
  { value: "balanced", label: "Balanced", hint: "3–4 stops a day" },
  { value: "packed", label: "Packed", hint: "5+ stops a day" },
];

export const ACCOMMODATION_OPTIONS: (Option<AccommodationStyle> & {
  hint: string;
})[] = [
  { value: "boutique", label: "Boutique", hint: "Small, characterful" },
  { value: "hotel", label: "Hotel", hint: "Reliable mid-range" },
  { value: "apartment", label: "Apartment", hint: "Space and a kitchen" },
  { value: "hostel", label: "Hostel", hint: "Budget and social" },
  { value: "luxury", label: "Luxury", hint: "Five-star service" },
];

export const DIETARY_OPTIONS: Option<Dietary>[] = [
  { value: "none", label: "No restrictions" },
  { value: "vegetarian", label: "Vegetarian" },
  { value: "vegan", label: "Vegan" },
  { value: "halal", label: "Halal" },
  { value: "kosher", label: "Kosher" },
  { value: "gluten-free", label: "Gluten-free" },
  { value: "no-pork", label: "No pork" },
  { value: "no-shellfish", label: "No shellfish" },
];

export const INTEREST_OPTIONS: Option<Interest>[] = [
  { value: "museums", label: "Museums" },
  { value: "architecture", label: "Architecture" },
  { value: "history", label: "History" },
  { value: "local-markets", label: "Local markets" },
  { value: "coffee", label: "Coffee" },
  { value: "wine", label: "Wine" },
  { value: "street-food", label: "Street food" },
  { value: "fine-dining", label: "Fine dining" },
  { value: "live-music", label: "Live music" },
  { value: "viewpoints", label: "Viewpoints" },
  { value: "beaches", label: "Beaches" },
  { value: "day-trips", label: "Day trips" },
  { value: "photography", label: "Photography" },
  { value: "bookshops", label: "Bookshops" },
];

export const TRAVEL_MODE_LABELS: Record<TravelMode, string> = {
  WALK: "Walk",
  TRANSIT: "Transit",
  DRIVE: "Taxi",
  BICYCLE: "Cycle",
};

export const ITEM_KIND_LABELS: Record<ItemKind, string> = {
  meal: "Meal",
  attraction: "Attraction",
  experience: "Experience",
  viewpoint: "Viewpoint",
  rest: "Downtime",
  transport: "Getting there",
  logistics: "Logistics",
};

export const PRICE_LEVEL_LABELS: Record<PriceLevel, string> = {
  PRICE_LEVEL_FREE: "Free",
  PRICE_LEVEL_INEXPENSIVE: "€",
  PRICE_LEVEL_MODERATE: "€€",
  PRICE_LEVEL_EXPENSIVE: "€€€",
  PRICE_LEVEL_VERY_EXPENSIVE: "€€€€",
};
