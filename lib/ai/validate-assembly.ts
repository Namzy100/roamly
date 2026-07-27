import type { Currency, VerifiedPlacePool } from "@/lib/schemas";

import { findProhibitedFields } from "./prohibited";
import {
  GeneratedTripAssemblySchema,
  type AssemblyDay,
  type GeneratedTripAssembly,
  type GenerationViolation,
  type SearchRequirement,
  type TripStrategy,
} from "./schemas";

/**
 * Assembly validation — the mechanical no-invention gate.
 *
 * This is the module the whole phase turns on. Everything upstream is a prompt and
 * everything downstream trusts its verdict, so it is written to fail loudly and
 * never to repair.
 *
 * ## The three classes of check
 *
 * **Identity.** A `placeId` must be in the exact pool that was searched, and the
 * declared category must equal the canonical record's. These are unrepairable: a
 * model referencing a place it was not given has fabricated one, and a second
 * attempt is an invitation to fabricate differently. Note that `assertItineraryUsesPool`
 * runs *again* on the finished plan — this check is not a substitute for it, it is
 * an earlier and more legible failure for the same invariant.
 *
 * **Structure.** Day coverage, unique ids, one item per slot, every required slot
 * either filled or explicitly `unavailable`. Repairable, because these are
 * ordinary mistakes with an obvious correction.
 *
 * **Time and money.** Times that parse, end after start, no overlaps within a day,
 * a cost basis of `category-estimate` in the request's currency. Also repairable.
 *
 * ## What is deliberately *not* checked here
 *
 * Cost *amounts*. The model may propose a figure and it is clamped into a
 * configured band during canonical attachment, not rejected — the model is
 * allowed to allocate, and it is not allowed to certify. Rejecting an
 * out-of-band amount would invite the model to guess our bands rather than the
 * traveller's spending.
 */

export type AssemblyValidationInput = {
  /** Raw provider JSON, before Zod strips anything. */
  raw: unknown;
  /** The exact pool assembly was given. Nothing outside it may be referenced. */
  pool: VerifiedPlacePool;
  /** The slots the strategy asked for, keyed by id in `slotIndex`. */
  strategy: TripStrategy;
  /** The request's currency. A cost in any other currency is a violation. */
  currency: Currency;
};

export type AssemblyValidationResult =
  | { ok: true; assembly: GeneratedTripAssembly; violations: [] }
  | { ok: false; violations: GenerationViolation[] };

export function validateAssembly(
  input: AssemblyValidationInput,
): AssemblyValidationResult {
  const violations: GenerationViolation[] = [];

  /**
   * `placeId` is the one identity field assembly *must* use, so it is allowed —
   * and it is the only one. Everything else in `PROHIBITED_KEYS` stays banned,
   * which is what stops the model attaching a name, a coordinate or a rating
   * beside the id it was given.
   */
  for (const finding of findProhibitedFields(input.raw, { allow: ["placeId"] })) {
    violations.push({
      code: "prohibited_field",
      message: `Assembly output contained the field "${finding.path}". Reference places by placeId only — the server attaches names, coordinates, addresses and every other provider fact itself.`,
    });
  }
  if (violations.length > 0) return { ok: false, violations };

  const parsed = GeneratedTripAssemblySchema.safeParse(input.raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 12)) {
      violations.push({
        code: "assembly_schema",
        message: `${issue.path.join(".") || "(root)"}: ${issue.message}`,
      });
    }
    return { ok: false, violations };
  }
  const assembly = parsed.data;

  const poolById = new Map(
    input.pool.places.map((place) => [place.placeId, place]),
  );
  const slotIndex = indexSlots(input.strategy);

  violations.push(...validateDays(assembly, input.strategy));
  violations.push(
    ...validateItems({ assembly, poolById, slotIndex, currency: input.currency }),
  );
  violations.push(...validateSlotFulfilment(assembly, slotIndex));
  violations.push(...validateBackups({ assembly, poolById, slotIndex }));

  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, assembly, violations: [] };
}

/* -------------------------------------------------------------------------- */

type SlotIndex = Map<string, SearchRequirement & { dayNumber: number }>;

function indexSlots(strategy: TripStrategy): SlotIndex {
  const index: SlotIndex = new Map();
  for (const day of strategy.days) {
    for (const slot of day.searchRequirements) {
      index.set(slot.slotId, { ...slot, dayNumber: day.dayNumber });
    }
  }
  return index;
}

/** Exactly the strategy's days, once each. */
function validateDays(
  assembly: GeneratedTripAssembly,
  strategy: TripStrategy,
): GenerationViolation[] {
  const violations: GenerationViolation[] = [];
  const expected = new Set(strategy.days.map((day) => day.dayNumber));

  if (assembly.days.length !== strategy.days.length) {
    violations.push({
      code: "assembly_day_count",
      message: `The strategy planned ${strategy.days.length} day${strategy.days.length === 1 ? "" : "s"}, but the itinerary has ${assembly.days.length}. Produce one day per planned day.`,
    });
  }

  const seen = new Set<number>();
  for (const day of assembly.days) {
    if (!expected.has(day.dayNumber)) {
      violations.push({
        code: "assembly_unknown_day",
        message: `Day ${day.dayNumber} was not part of the strategy.`,
        dayNumber: day.dayNumber,
      });
      continue;
    }
    if (seen.has(day.dayNumber)) {
      violations.push({
        code: "assembly_duplicate_day",
        message: `Day ${day.dayNumber} appears twice.`,
        dayNumber: day.dayNumber,
      });
      continue;
    }
    seen.add(day.dayNumber);
  }

  for (const dayNumber of expected) {
    if (!seen.has(dayNumber)) {
      violations.push({
        code: "assembly_missing_day",
        message: `Day ${dayNumber} is missing from the itinerary.`,
        dayNumber,
      });
    }
  }

  return violations;
}

function validateItems(context: {
  assembly: GeneratedTripAssembly;
  poolById: Map<string, VerifiedPlacePool["places"][number]>;
  slotIndex: SlotIndex;
  currency: Currency;
}): GenerationViolation[] {
  const { assembly, poolById, slotIndex, currency } = context;
  const violations: GenerationViolation[] = [];
  const itemIds = new Set<string>();

  for (const day of assembly.days) {
    const placesUsedToday = new Set<string>();

    for (const item of day.items) {
      if (itemIds.has(item.itemId)) {
        violations.push({
          code: "assembly_duplicate_item_id",
          message: `Item id "${item.itemId}" is used more than once. Ids must be unique across the whole trip.`,
          dayNumber: day.dayNumber,
          itemId: item.itemId,
        });
      }
      itemIds.add(item.itemId);

      if (item.kind === "unavailable") {
        violations.push(...validateSlotReference(item.slotId, day, slotIndex));
        // Both times or neither. One of the two is a half-scheduled gap, which
        // the itinerary has no way to render honestly.
        if ((item.startTime === undefined) !== (item.endTime === undefined)) {
          violations.push({
            code: "assembly_partial_time",
            message: `Unavailable slot "${item.slotId}" has only one of startTime and endTime. Give both, or neither.`,
            dayNumber: day.dayNumber,
            slotId: item.slotId,
          });
        }
        if (item.startTime !== undefined && item.endTime !== undefined) {
          violations.push(
            ...validateInterval(item.startTime, item.endTime, day, item.itemId),
          );
        }
        continue;
      }

      violations.push(
        ...validateInterval(item.startTime, item.endTime, day, item.itemId),
      );
      violations.push(...validateCost(item.estimatedCost, currency, day, item.itemId));

      if (item.kind === "non-place") continue;

      violations.push(...validateSlotReference(item.slotId, day, slotIndex));

      const canonical = poolById.get(item.placeId);
      if (!canonical) {
        violations.push({
          code: "place_outside_pool",
          message: `"${item.placeId}" is not one of the candidate places supplied for this trip. Only the listed placeIds may be used.`,
          dayNumber: day.dayNumber,
          itemId: item.itemId,
          placeId: item.placeId,
        });
        continue;
      }

      if (canonical.category !== item.category) {
        violations.push({
          code: "assembly_category_mismatch",
          message: `Place "${item.placeId}" is a ${canonical.category}, but it was scheduled as a ${item.category}.`,
          dayNumber: day.dayNumber,
          itemId: item.itemId,
          placeId: item.placeId,
        });
      }

      const slot = slotIndex.get(item.slotId);
      if (slot && slot.category !== item.category) {
        violations.push({
          code: "assembly_slot_category_mismatch",
          message: `Slot "${item.slotId}" asked for a ${slot.category}, but a ${item.category} was scheduled in it.`,
          dayNumber: day.dayNumber,
          slotId: item.slotId,
          itemId: item.itemId,
        });
      }

      if (placesUsedToday.has(item.placeId)) {
        violations.push({
          code: "assembly_duplicate_place_in_day",
          message: `Place "${item.placeId}" is visited twice on day ${day.dayNumber}. Choose a different candidate for one of the slots.`,
          dayNumber: day.dayNumber,
          placeId: item.placeId,
        });
      }
      placesUsedToday.add(item.placeId);
    }

    violations.push(...validateNoOverlap(day));
  }

  return violations;
}

function validateSlotReference(
  slotId: string,
  day: AssemblyDay,
  slotIndex: SlotIndex,
): GenerationViolation[] {
  const slot = slotIndex.get(slotId);
  if (!slot) {
    return [
      {
        code: "assembly_unknown_slot",
        message: `Slot "${slotId}" was not one of the strategy's search requirements.`,
        dayNumber: day.dayNumber,
        slotId,
      },
    ];
  }
  if (slot.dayNumber !== day.dayNumber) {
    return [
      {
        code: "assembly_slot_wrong_day",
        message: `Slot "${slotId}" belongs to day ${slot.dayNumber} but was used on day ${day.dayNumber}.`,
        dayNumber: day.dayNumber,
        slotId,
      },
    ];
  }
  return [];
}

/** Every required slot is either filled or explicitly reported unfillable. */
function validateSlotFulfilment(
  assembly: GeneratedTripAssembly,
  slotIndex: SlotIndex,
): GenerationViolation[] {
  const violations: GenerationViolation[] = [];
  const claimedBy = new Map<string, string>();

  for (const day of assembly.days) {
    for (const item of day.items) {
      if (item.kind === "non-place") continue;
      const previous = claimedBy.get(item.slotId);
      if (previous) {
        violations.push({
          code: "assembly_duplicate_slot_fulfilment",
          message: `Slot "${item.slotId}" is filled twice, by "${previous}" and "${item.itemId}". One item per slot.`,
          slotId: item.slotId,
          itemId: item.itemId,
        });
        continue;
      }
      claimedBy.set(item.slotId, item.itemId);
    }
  }

  for (const [slotId, slot] of slotIndex) {
    if (!slot.required) continue;
    if (!claimedBy.has(slotId)) {
      violations.push({
        code: "assembly_required_slot_omitted",
        message: `Required slot "${slotId}" (${slot.category}) was neither filled nor marked unavailable. If no supplied candidate fits, add an item with kind "unavailable" for it.`,
        dayNumber: slot.dayNumber,
        slotId,
      });
    }
  }

  return violations;
}

function validateBackups(context: {
  assembly: GeneratedTripAssembly;
  poolById: Map<string, VerifiedPlacePool["places"][number]>;
  slotIndex: SlotIndex;
}): GenerationViolation[] {
  const { assembly, poolById, slotIndex } = context;
  const violations: GenerationViolation[] = [];
  const backupIds = new Set<string>();

  for (const day of assembly.days) {
    for (const backup of day.backups) {
      if (backupIds.has(backup.backupId)) {
        violations.push({
          code: "assembly_duplicate_backup_id",
          message: `Backup id "${backup.backupId}" is used more than once.`,
          dayNumber: day.dayNumber,
        });
      }
      backupIds.add(backup.backupId);

      if (!slotIndex.has(backup.slotId)) {
        violations.push({
          code: "assembly_unknown_slot",
          message: `Backup "${backup.backupId}" refers to slot "${backup.slotId}", which the strategy never requested.`,
          dayNumber: day.dayNumber,
          slotId: backup.slotId,
        });
      }

      if (backup.placeId === undefined) {
        if (!backup.unavailableReason) {
          violations.push({
            code: "assembly_backup_without_reason",
            message: `Backup "${backup.backupId}" names no place, so it needs an unavailableReason explaining that no alternative was available.`,
            dayNumber: day.dayNumber,
          });
        }
        continue;
      }

      if (!poolById.has(backup.placeId)) {
        violations.push({
          code: "backup_outside_pool",
          message: `Backup "${backup.backupId}" refers to "${backup.placeId}", which is not one of the supplied candidates.`,
          dayNumber: day.dayNumber,
          placeId: backup.placeId,
        });
      }
    }
  }

  return violations;
}

/* -------------------------------------------------------------------------- */

/** Minutes since midnight. The schema has already guaranteed the format. */
export function minutesOfDay(time: string): number {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function validateInterval(
  startTime: string,
  endTime: string,
  day: AssemblyDay,
  itemId: string,
): GenerationViolation[] {
  if (minutesOfDay(endTime) > minutesOfDay(startTime)) return [];
  return [
    {
      code: "assembly_invalid_interval",
      message: `"${itemId}" on day ${day.dayNumber} ends at ${endTime}, which is not after its ${startTime} start. Stops cannot end before they begin, and a plan does not cross midnight.`,
      dayNumber: day.dayNumber,
      itemId,
    },
  ];
}

/**
 * No two scheduled blocks on a day may overlap.
 *
 * Sorted by start, then compared pairwise, so the report names the actual pair
 * rather than "something overlaps". Items with no times — an unavailable slot the
 * model chose not to schedule — are excluded, because an unscheduled gap cannot
 * conflict with anything.
 */
function validateNoOverlap(day: AssemblyDay): GenerationViolation[] {
  const scheduled = day.items
    .flatMap((item) =>
      item.startTime !== undefined && item.endTime !== undefined
        ? [
            {
              itemId: item.itemId,
              start: minutesOfDay(item.startTime),
              end: minutesOfDay(item.endTime),
              startTime: item.startTime,
              endTime: item.endTime,
            },
          ]
        : [],
    )
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const violations: GenerationViolation[] = [];
  for (let index = 1; index < scheduled.length; index += 1) {
    const previous = scheduled[index - 1];
    const current = scheduled[index];
    if (current.start < previous.end) {
      violations.push({
        code: "assembly_overlapping_items",
        message: `On day ${day.dayNumber}, "${current.itemId}" starts at ${current.startTime} while "${previous.itemId}" runs until ${previous.endTime}. Leave time between stops.`,
        dayNumber: day.dayNumber,
        itemId: current.itemId,
      });
    }
  }
  return violations;
}

/**
 * A cost may be proposed, but not certified.
 *
 * `basis` and `currency` are claims about *where a number came from*, and those
 * are ours to make. `category-estimate` is the only honest basis available to a
 * model: it has no provider tag, no user input and no live price feed.
 * Converting a currency would be a second fabricated fact on top of the first, so
 * a mismatch is rejected rather than converted.
 */
function validateCost(
  cost: { amount: number; currency: string; basis: string },
  currency: Currency,
  day: AssemblyDay,
  itemId: string,
): GenerationViolation[] {
  const violations: GenerationViolation[] = [];

  if (cost.basis !== "category-estimate") {
    violations.push({
      code: "assembly_cost_basis",
      message: `"${itemId}" claims a cost basis of "${cost.basis}". Every generated cost is a planning estimate, so basis must be "category-estimate".`,
      dayNumber: day.dayNumber,
      itemId,
    });
  }

  if (cost.currency !== currency) {
    violations.push({
      code: "assembly_cost_currency",
      message: `"${itemId}" priced in ${cost.currency}, but this trip's budget is in ${currency}. Use ${currency} throughout; do not convert.`,
      dayNumber: day.dayNumber,
      itemId,
    });
  }

  if (!Number.isFinite(cost.amount) || cost.amount < 0) {
    violations.push({
      code: "assembly_cost_amount",
      message: `"${itemId}" has an unusable cost amount.`,
      dayNumber: day.dayNumber,
      itemId,
    });
  }

  return violations;
}
