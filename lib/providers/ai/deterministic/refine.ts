import "server-only";

import { z } from "zod";

import {
  MealTypeSchema,
  PlaceCategorySchema,
  type Currency,
} from "@/lib/schemas";
import { bandFor, costClassFor } from "@/lib/plan";

/**
 * The deterministic planner's refinement.
 *
 * ## Why this exists rather than "refinement needs a model"
 *
 * A trip built by the demo planner is template output. Refusing to refine it unless
 * a model is configured would make the keyless path a dead end — plan a trip for
 * free, then be told you cannot change it — and that is the opposite of free by
 * default.
 *
 * It is also not the substitution the brief forbids. Using the demo planner on a
 * *Gemini* trip would be silently swapping planners behind the traveller's back; the
 * orchestrator refuses that. Using it on a trip it built itself is the same planner
 * doing the same job.
 *
 * ## What it can and cannot do
 *
 * It picks the nearest eligible candidate, which is already the order the candidate
 * list arrives in. For a day adjustment it makes the one mechanical change the action
 * names — drop the priciest optional stop, drop the last optional stop, or fill the
 * largest usable gap — and reports `unavailable` when the day offers no such move.
 *
 * That last part matters: "cheaper" on a day of nothing but meals returns
 * `unavailable` with a reason, rather than shaving estimates until the number goes
 * down. Lowering a figure to satisfy a button is how an estimate becomes a fiction.
 *
 * Fully deterministic: no clock, no randomness, no iteration-order dependence.
 */

const CandidateSchema = z.object({
  placeId: z.string().min(1),
  name: z.string().min(1),
  category: PlaceCategorySchema,
  address: z.string().optional(),
  openingHours: z.string().optional(),
});

const CurrencySchema = z.enum(["EUR", "USD", "GBP", "AED"]);

/* -------------------------------------------------------------------------- */
/* replace-item                                                               */
/* -------------------------------------------------------------------------- */

const ReplaceItemInputSchema = z.object({
  action: z.literal("replace-item"),
  currency: CurrencySchema,
  travelers: z.number().int().min(1),
  current: z.object({
    placeId: z.string().min(1),
    category: PlaceCategorySchema,
    mealType: MealTypeSchema.nullable(),
    startTime: z.string(),
    endTime: z.string(),
    estimatedCost: z.number().nonnegative(),
  }),
  preferences: z
    .object({ cheaper: z.boolean().optional() })
    .loose()
    .optional(),
  candidates: z.array(CandidateSchema),
});

function replaceItem(input: z.infer<typeof ReplaceItemInputSchema>): unknown {
  const chosen = input.candidates[0];
  if (!chosen) {
    return {
      status: "unavailable",
      reason:
        "The place search around this destination turned up no other place of this kind nearby, so there is no alternative to offer.",
    };
  }

  const amount = deterministicAmount({
    category: chosen.category,
    mealType: input.current.mealType,
    currency: input.currency,
    travelers: input.travelers,
    /**
     * "Cheaper" is honoured by taking the band's floor rather than its typical
     * figure. If that still is not below the current estimate the request cannot be
     * met from this band, and saying so beats writing a number that satisfies the
     * check.
     */
    cheaper: input.preferences?.cheaper === true,
  });

  if (input.preferences?.cheaper === true && amount > input.current.estimatedCost) {
    return {
      status: "unavailable",
      reason:
        "Every alternative of this kind sits in the same price band as the current stop, so none of them would actually be cheaper.",
    };
  }

  return {
    status: "selected",
    placeId: chosen.placeId,
    description: describe(chosen, input.current.mealType),
    estimatedCost: {
      amount,
      currency: input.currency,
      basis: "category-estimate",
      confidence: "low",
    },
    reservationRecommended: input.current.mealType === "dinner",
  };
}

/* -------------------------------------------------------------------------- */
/* replace-backup                                                             */
/* -------------------------------------------------------------------------- */

const ReplaceBackupInputSchema = z.object({
  action: z.literal("replace-backup"),
  currency: CurrencySchema,
  travelers: z.number().int().min(1),
  candidates: z.array(CandidateSchema),
});

function replaceBackup(input: z.infer<typeof ReplaceBackupInputSchema>): unknown {
  const chosen = input.candidates[0];
  if (!chosen) {
    return {
      status: "unavailable",
      reason:
        "The place search found nothing else of this kind nearby, so there is no alternative backup to offer.",
    };
  }

  return {
    status: "selected",
    placeId: chosen.placeId,
    reason:
      "Another place of the same kind from the same OpenStreetMap search, close to the day's other stops. The demo planner cannot say whether it is nicer — only that it is nearby and of the right kind.",
    estimatedCost: {
      amount: deterministicAmount({
        category: chosen.category,
        mealType: null,
        currency: input.currency,
        travelers: input.travelers,
        cheaper: false,
      }),
      currency: input.currency,
      basis: "category-estimate",
      confidence: "low",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* adjust-day                                                                 */
/* -------------------------------------------------------------------------- */

const DayItemSchema = z.object({
  itemId: z.string().min(1),
  kind: z.enum(["place", "non-place", "unavailable"]),
  placeId: z.string().optional(),
  category: PlaceCategorySchema.optional(),
  nonPlaceCategory: z
    .enum(["transport", "free-time", "airport", "accommodation"])
    .optional(),
  mealType: MealTypeSchema.nullable(),
  startTime: z.string(),
  endTime: z.string(),
  title: z.string(),
  description: z.string(),
  estimatedCost: z.number().nonnegative(),
  reservationRecommended: z.boolean().optional(),
});

const AdjustDayInputSchema = z.object({
  action: z.literal("adjust-day"),
  adjustment: z.enum(["cheaper", "more-relaxed", "more-packed"]),
  dayNumber: z.number().int().min(1).max(7),
  currency: CurrencySchema,
  travelers: z.number().int().min(1),
  stopCap: z.number().int().min(1),
  items: z.array(DayItemSchema),
  candidates: z.array(CandidateSchema),
  backups: z.array(z.object({ backupId: z.string(), placeId: z.string() })),
});

/** A stop needs this much room, plus a gap either side. Mirrors `SCHEDULE_LIMITS`. */
const MIN_STOP_MINUTES = 45;
const MIN_TRANSITION_MINUTES = 10;
const DAY_END_MINUTES = 21 * 60;

function adjustDay(input: z.infer<typeof AdjustDayInputSchema>): unknown {
  const items = [...input.items].sort((a, b) =>
    a.startTime.localeCompare(b.startTime),
  );
  const optional = items.filter(
    (item) => item.kind === "place" && item.mealType === null,
  );

  const unavailable = (reason: string) => ({ status: "unavailable", reason });

  let next = items;

  switch (input.adjustment) {
    case "cheaper": {
      if (optional.length === 0) {
        return unavailable(
          "This day is only meals and free time, so there is no paid activity to drop. The demo planner will not lower an estimate just to make the total smaller.",
        );
      }
      // The priciest optional stop, with the id as a tie-break so the choice is
      // deterministic when two cost the same.
      const target = [...optional].sort(
        (a, b) =>
          b.estimatedCost - a.estimatedCost || a.itemId.localeCompare(b.itemId),
      )[0];
      next = items.filter((item) => item.itemId !== target.itemId);
      break;
    }

    case "more-relaxed": {
      if (optional.length === 0) {
        return unavailable(
          "This day has no optional stops left to remove — only meals and unscheduled time.",
        );
      }
      const target = optional[optional.length - 1];
      next = items.filter((item) => item.itemId !== target.itemId);
      break;
    }

    case "more-packed": {
      const stops = items.filter((item) => item.kind === "place").length;
      if (stops >= input.stopCap) {
        return unavailable(
          `This day already has ${stops} stops, which is the most a ${describePace(input.stopCap)} pace allows.`,
        );
      }
      const candidate = input.candidates[0];
      if (!candidate) {
        return unavailable(
          "The saved place search has nothing left nearby that is not already in this trip, so there is nothing to add.",
        );
      }
      const slot = findGap(items);
      if (!slot) {
        return unavailable(
          "There is no gap in this day long enough for another stop with sensible time to get between them.",
        );
      }

      next = [
        ...items,
        {
          itemId: `d${input.dayNumber}-added-${candidate.placeId.replace(/[^a-z0-9]+/gi, "").slice(-8).toLowerCase()}`,
          kind: "place" as const,
          placeId: candidate.placeId,
          category: candidate.category,
          mealType: null,
          startTime: slot.startTime,
          endTime: slot.endTime,
          title: candidate.name,
          description: describe(candidate, null),
          estimatedCost: deterministicAmount({
            category: candidate.category,
            mealType: null,
            currency: input.currency,
            travelers: input.travelers,
            cheaper: false,
          }),
          reservationRecommended: false,
        },
      ].sort((a, b) => a.startTime.localeCompare(b.startTime));
      break;
    }
  }

  return {
    status: "adjusted",
    dayNumber: input.dayNumber,
    summary: summaryFor(input.adjustment, next),
    items: next.map((item) => toRefinedItem(item, input.currency)),
    // Backups are untouched: they have no place in the schedule and this action did
    // not ask about them.
    backups: input.backups.map((backup) => ({
      backupId: backup.backupId,
      placeId: backup.placeId,
      reason:
        "Carried over unchanged — this adjustment changed the day's stops, not its fallbacks.",
    })),
  };
}

/**
 * The largest gap that can hold a stop, or the end of the day.
 *
 * Requires a transition either side, so the inserted stop never describes
 * teleportation — the same floor `validateSchedule` enforces, applied here so the
 * planner does not propose a day it knows will be rejected.
 */
function findGap(
  items: { startTime: string; endTime: string }[],
): { startTime: string; endTime: string } | null {
  const needed = MIN_STOP_MINUTES + MIN_TRANSITION_MINUTES * 2;

  let best: { start: number; end: number } | null = null;

  for (let index = 0; index < items.length - 1; index += 1) {
    const from = toMinutes(items[index].endTime);
    const to = toMinutes(items[index + 1].startTime);
    if (to - from < needed) continue;
    if (!best || to - from > best.end - best.start) best = { start: from, end: to };
  }

  const lastEnd = items.length > 0 ? toMinutes(items[items.length - 1].endTime) : null;
  if (lastEnd !== null && DAY_END_MINUTES - lastEnd >= needed) {
    const tail = { start: lastEnd, end: DAY_END_MINUTES };
    if (!best || tail.end - tail.start > best.end - best.start) best = tail;
  }

  if (!best) return null;

  const start = best.start + MIN_TRANSITION_MINUTES;
  const end = Math.min(best.end - MIN_TRANSITION_MINUTES, start + 90);
  if (end - start < MIN_STOP_MINUTES) return null;

  return { startTime: toClock(start), endTime: toClock(end) };
}

function toRefinedItem(
  item: z.infer<typeof DayItemSchema>,
  currency: Currency,
): unknown {
  const cost = {
    amount: item.estimatedCost,
    currency,
    basis: "category-estimate" as const,
    confidence: "low" as const,
  };

  if (item.kind === "place") {
    return {
      kind: "place",
      itemId: item.itemId,
      placeId: item.placeId,
      category: item.category,
      mealType: item.mealType,
      startTime: item.startTime,
      endTime: item.endTime,
      title: item.title,
      description: item.description,
      estimatedCost: cost,
      reservationRecommended: item.reservationRecommended ?? false,
    };
  }

  if (item.kind === "non-place") {
    return {
      kind: "non-place",
      itemId: item.itemId,
      category: item.nonPlaceCategory ?? "free-time",
      startTime: item.startTime,
      endTime: item.endTime,
      title: item.title,
      description: item.description,
      estimatedCost: cost,
    };
  }

  return {
    kind: "unavailable",
    itemId: item.itemId,
    reason: item.description,
    startTime: item.startTime,
    endTime: item.endTime,
    mealType: item.mealType,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * The refinement entry point. Returns `null` when the input is not one it knows,
 * which the caller turns into `invalid_response`.
 */
export function refineDeterministically(input: unknown): unknown | null {
  const replace = ReplaceItemInputSchema.safeParse(input);
  if (replace.success) return replaceItem(replace.data);

  const backup = ReplaceBackupInputSchema.safeParse(input);
  if (backup.success) return replaceBackup(backup.data);

  const day = AdjustDayInputSchema.safeParse(input);
  if (day.success) return adjustDay(day.data);

  return null;
}

/**
 * A figure from the band, never a guess.
 *
 * `cheaper` takes the floor; everything else takes the typical value. Both are then
 * clamped again during canonical attachment, so this is the planner proposing inside
 * the same range the server would allow anyway.
 */
function deterministicAmount(input: {
  category: z.infer<typeof PlaceCategorySchema>;
  mealType: z.infer<typeof MealTypeSchema> | null;
  currency: Currency;
  travelers: number;
  cheaper: boolean;
}): number {
  const costClass = costClassFor(input.category, input.mealType);
  const band = bandFor(input.currency, costClass);
  const units =
    costClass === "night"
      ? Math.max(1, Math.ceil(input.travelers / 2))
      : Math.max(1, input.travelers);

  return Math.round((input.cheaper ? band.min : band.typical) * units * 100) / 100;
}

/**
 * Prose built only from what the candidate carries.
 *
 * Same discipline as the deterministic generator: an address is copied, opening
 * hours are quoted and labelled uninterpreted, and the rest of the sentence is about
 * the itinerary rather than about the place.
 */
function describe(
  candidate: z.infer<typeof CandidateSchema>,
  mealType: z.infer<typeof MealTypeSchema> | null,
): string {
  const parts = [
    mealType
      ? `A ${mealType} stop of the same kind, chosen from the saved place search.`
      : "A stop of the same kind, chosen from the saved place search because it is the nearest alternative.",
    candidate.address
      ? `OpenStreetMap records the address as ${candidate.address}.`
      : "OpenStreetMap has no address recorded for this one.",
  ];

  if (candidate.openingHours) {
    parts.push(
      `Opening hours are recorded as “${candidate.openingHours}”, exactly as they appear in OpenStreetMap and not interpreted — check before you go.`,
    );
  }
  parts.push(
    "The demo planner selects by category and proximity only, and has no view on whether it is any good.",
  );

  return parts.join(" ");
}

function summaryFor(
  adjustment: "cheaper" | "more-relaxed" | "more-packed",
  items: { kind: string }[],
): string {
  const stops = items.filter((item) => item.kind === "place").length;

  switch (adjustment) {
    case "cheaper":
      return `Adjusted to cost less: the day's most expensive optional stop was removed, leaving ${stops} stops. Every figure is still a category estimate rather than a price.`;
    case "more-relaxed":
      return `Adjusted to be more relaxed: the last optional stop was removed, leaving ${stops} stops and more unscheduled time between them.`;
    case "more-packed":
      return `Adjusted to be fuller: one more place from the saved search was added into the day's largest gap, giving ${stops} stops with real time to get between them.`;
  }
}

function describePace(stopCap: number): string {
  if (stopCap <= 4) return "relaxed";
  if (stopCap <= 5) return "balanced";
  return "packed";
}

function toMinutes(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function toClock(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
