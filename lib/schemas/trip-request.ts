import { differenceInCalendarDays, isValid, parseISO } from "date-fns";
import { z } from "zod";

import {
  AccommodationStyleSchema,
  CurrencySchema,
  DietarySchema,
  InterestSchema,
  PaceSchema,
  VibeSchema,
} from "./enums";

/** MVP constraint: a single destination, one base, at most a week. */
export const MAX_TRIP_DAYS = 7;
export const MIN_TRIP_DAYS = 1;

const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use the date picker to choose a date")
  .refine((value) => isValid(parseISO(value)), "That date does not exist");

/**
 * The validated form payload. This is the only shape the generation pipeline
 * will ever accept as input, so every constraint the product depends on is
 * expressed here rather than in the form component.
 */
export const TripRequestSchema = z
  .object({
    departureCity: z
      .string()
      .trim()
      .min(2, "Where are you flying from?")
      .max(80, "That city name is too long"),
    destination: z
      .string()
      .trim()
      .min(2, "Where would you like to go?")
      .max(80, "That destination name is too long"),
    startDate: IsoDateSchema,
    endDate: IsoDateSchema,
    budget: z
      .number({ error: "Enter your total budget" })
      .int("Use a whole number")
      .positive("Budget must be more than zero")
      .max(1_000_000, "That budget is beyond this planner"),
    currency: CurrencySchema,
    travelers: z
      .number({ error: "How many travellers?" })
      .int("Use a whole number")
      .min(1, "At least one traveller")
      .max(12, "Twelve travellers is the maximum"),
    vibes: z
      .array(VibeSchema)
      .min(1, "Pick at least one vibe")
      .max(4, "Four vibes keeps the plan focused"),
    pace: PaceSchema,
    accommodation: AccommodationStyleSchema,
    dietary: z.array(DietarySchema),
    interests: z
      .array(InterestSchema)
      .min(1, "Pick at least one interest")
      .max(8, "Eight interests is plenty"),
    notes: z.string().trim().max(600, "Keep notes under 600 characters"),
  })
  .refine(
    (value) => {
      const start = parseISO(value.startDate);
      const end = parseISO(value.endDate);
      if (!isValid(start) || !isValid(end)) return true;
      return differenceInCalendarDays(end, start) >= 0;
    },
    { message: "Return date cannot be before departure", path: ["endDate"] },
  )
  .refine(
    (value) => {
      const start = parseISO(value.startDate);
      const end = parseISO(value.endDate);
      if (!isValid(start) || !isValid(end)) return true;
      const days = differenceInCalendarDays(end, start) + 1;
      return days >= MIN_TRIP_DAYS && days <= MAX_TRIP_DAYS;
    },
    {
      message: `Trips can run from ${MIN_TRIP_DAYS} to ${MAX_TRIP_DAYS} days`,
      path: ["endDate"],
    },
  )
  .refine(
    (value) =>
      value.departureCity.trim().toLowerCase() !==
      value.destination.trim().toLowerCase(),
    {
      message: "Pick a destination different from where you started",
      path: ["destination"],
    },
  )
  .refine(
    (value) => !(value.dietary.includes("none") && value.dietary.length > 1),
    {
      message: "“No restrictions” cannot be combined with other preferences",
      path: ["dietary"],
    },
  );

export type TripRequest = z.infer<typeof TripRequestSchema>;

/** Inclusive night/day counts derived from a validated request. */
export function tripDayCount(request: {
  startDate: string;
  endDate: string;
}): number {
  return (
    differenceInCalendarDays(
      parseISO(request.endDate),
      parseISO(request.startDate),
    ) + 1
  );
}

export function tripNightCount(request: {
  startDate: string;
  endDate: string;
}): number {
  return Math.max(0, tripDayCount(request) - 1);
}
