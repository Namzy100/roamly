import type { z } from "zod";

import { kindForCategory } from "@/lib/generate/assemble-plan";
import { buildCostEstimate, clampPartyCost, costClassFor } from "@/lib/plan";
import type { SelectAlternativeCommandSchema } from "@/lib/refinement/commands";
import type {
  ItineraryItem,
  TripGenerationContext,
  TripPlace,
  TripPlan,
} from "@/lib/schemas";

import { commitStructuralEdit } from "./commit";
import { locateItem } from "./locate";
import { isEditLocked, lockRefusalFor } from "./locks";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";
import { retainedPlaceIds } from "./validate";

type SelectAlternativeCommand = z.infer<typeof SelectAlternativeCommandSchema>;

/**
 * Swapping a stop's place for one of its alternatives.
 *
 * ## The narrow half of the invariant, at its most exposed seam
 *
 * This is the only Phase 8 edit that *introduces* a place, so it is where the no-invention rule
 * earns its keep. The `placeId` must be in the **active pool**; there is no fallback lookup, no
 * geocode, no search. A retained place is refused with its own message, because "the latest search
 * no longer returns this" is a different fact from "this was never found", and the traveller
 * deserves the accurate one.
 *
 * The pool record is attached **unchanged**. `assertItineraryUsesPool` compares attached copies
 * field-by-field against the pool, so editing so much as a name here would read as tampering — and
 * correctly so.
 *
 * ## The item id is kept, unlike the refinement path
 *
 * `applyItemReplacement` and `applyHoursReplacePlace` both mint a new id, reasoning that routes
 * leaving the old stop measured a journey to a different place and a reused id would let them
 * survive re-keying.
 *
 * That reasoning does not apply here. `commitStructuralEdit` re-keys segments by **place** ids
 * (`rekeyPlanSegments`) and measures invalidation by diffing before against after
 * (`invalidatedLegIdsBetween`) rather than trusting an applier's account of it — so changing the
 * place changes the leg id whatever the item is called, and the stale leg is cleared either way.
 *
 * Keeping the id buys three things a new one would cost: the card stays selected and in place
 * rather than appearing to vanish and be replaced, any UI reference to it survives, and the summary
 * reports one *changed* stop rather than one removed and one added — which is what happened.
 *
 * ## The cost follows the band, not the venue
 *
 * An estimate here is a function of the destination profile and the *cost class* — which
 * `costClassFor` derives from category and meal type — never of the individual place. So the
 * existing figure is re-clamped into the new place's band: unchanged when the class is unchanged
 * (the common case, since most alternatives share a category), and pulled to the nearest bound when
 * a different class genuinely implies a different range.
 *
 * That is what makes a cheaper alternative actually cheaper in the total rather than merely labelled
 * so, and it is why a swap never invents a figure — it moves an existing one no further than the
 * band requires.
 */

export function applySelectAlternative(
  input: StructuralEditInput & { command: SelectAlternativeCommand },
): StructuralEditResult {
  const { plan, command, generation } = input;

  const located = locateItem(plan, command.dayNumber, command.itemId);
  if (!located.ok) return failed(located.error);

  const { dayIndex, day, itemIndex, item } = located.value;

  const refusal = lockRefusalFor(item);
  if (refusal) {
    return failed({ ...refusal, dayNumber: command.dayNumber, itemId: item.id });
  }

  /**
   * A place-less block has no primary to swap.
   *
   * Downtime and unfilled slots are excluded rather than treated as "fill this in": putting a place
   * into a free-time block would turn the traveller's rest into a stop, and filling an `unavailable`
   * slot is what `resolve-hours-conflict` and `replace-item` are for.
   */
  if (item.place === null) {
    return failed({
      code: "item_has_no_place",
      message: `“${item.title}” has no place attached, so there is nothing to swap.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  if (item.place.placeId === command.alternativePlaceId) {
    return failed({
      code: "no_change",
      message: `“${item.place.name}” is already the place for this stop.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
    });
  }

  if (retainedPlaceIds(generation).has(command.alternativePlaceId)) {
    return failed({
      code: "place_is_retained",
      message:
        "That place is one the latest search no longer returns, so it is kept only for the stops already using it and cannot be chosen for a new one.",
      dayNumber: command.dayNumber,
      itemId: item.id,
      placeId: command.alternativePlaceId,
    });
  }

  const chosen = generation.placePool.places.find(
    (place) => place.placeId === command.alternativePlaceId,
  );
  if (!chosen) {
    return failed({
      code: "place_outside_pool",
      message:
        "That place is not part of this trip's saved search results, so it cannot be added to the itinerary.",
      dayNumber: command.dayNumber,
      itemId: item.id,
      placeId: command.alternativePlaceId,
    });
  }

  if (placeIsInUse(plan, chosen.placeId, item.id)) {
    return failed({
      code: "place_already_used",
      message: `“${chosen.name}” is already somewhere in this trip.`,
      dayNumber: command.dayNumber,
      itemId: item.id,
      placeId: chosen.placeId,
    });
  }

  const cost = clampPartyCost({
    proposed: item.estimatedCost,
    currency: plan.request.currency,
    costClass: costClassFor(chosen.category, item.mealType),
    travelers: plan.request.travelers,
  });

  const swapped: ItineraryItem = {
    ...item,
    kind: kindForCategory(chosen.category, item.mealType),
    /**
     * A meal keeps its title ("Lunch"); anything else takes the place's name.
     *
     * The rule `applyHoursReplacePlace` uses. A meal's title names the occasion and stays true
     * across a change of restaurant; an attraction's title *was* the old venue, and leaving it would
     * label the new place with the old one's name.
     */
    title: item.mealType !== null ? item.title : chosen.name,
    /**
     * Says who chose, and from where. Claims nothing about the place.
     *
     * The alternative's own reason — "closer", "opens earlier" — is derived and shown beside the
     * choice. Baking it in here would freeze a comparison that was true of one moment into the saved
     * plan, where it would go stale with nothing to notice.
     */
    rationale: "You chose this from the alternatives found in this trip's own search results.",
    status: "confirmed",
    // The pool's record, attached unchanged.
    place: chosen,
    estimatedCost: cost.amount,
    ...(item.costEstimate
      ? {
          costEstimate: buildCostEstimate({
            amount: cost.amount,
            currency: plan.request.currency,
            confidence: item.costEstimate.confidence,
          }),
        }
      : {}),
    /**
     * The leg leaving this stop is cleared: it measured a journey *from a different place*.
     *
     * `rekeyPlanSegments` handles the leg coming in.
     */
    travelToNext: null,
  };

  const days = plan.days.map((entry, position) =>
    position === dayIndex
      ? {
          ...entry,
          items: entry.items.map((candidate, index) =>
            index === itemIndex ? swapped : candidate,
          ),
        }
      : entry,
  );

  return commitStructuralEdit({
    action: "select-alternative",
    before: plan,
    generation,
    days,
    revisionBefore: input.revisionBefore,
    affectedDays: [command.dayNumber],
    validateDays: [{ dayNumber: day.dayNumber, baseline: day }],
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
  });
}

/**
 * Whether this place may be offered as an alternative for this stop.
 *
 * The predicate the alternatives derivation filters on, so a card never shows an option the applier
 * would refuse. Deliberately the same questions in the same order.
 */
export function alternativeIsSelectable(input: {
  plan: TripPlan;
  generation: TripGenerationContext;
  item: ItineraryItem;
  place: TripPlace;
}): boolean {
  if (isEditLocked(input.item)) return false;
  if (input.item.place === null) return false;
  if (input.item.place.placeId === input.place.placeId) return false;
  if (retainedPlaceIds(input.generation).has(input.place.placeId)) return false;
  if (
    !input.generation.placePool.places.some(
      (candidate) => candidate.placeId === input.place.placeId,
    )
  ) {
    return false;
  }
  return !placeIsInUse(input.plan, input.place.placeId, input.item.id);
}

/**
 * Whether the plan already uses this place somewhere other than `exceptItemId`.
 *
 * The accommodation counts. A trip whose lunch is at its own hotel is not wrong, but it is almost
 * never what somebody picking an alternative meant, and `applyHoursReplacePlace` already treats it
 * as taken — two answers to "is this place free" would show up as an option that fails on save.
 *
 * Backups deliberately do **not** count. A place can legitimately be a backup for one day and the
 * primary for another; excluding backups would shrink the alternatives for no benefit, and the
 * commit's pool assertion is what actually guarantees consistency.
 */
function placeIsInUse(
  plan: TripPlan,
  placeId: string,
  exceptItemId: string,
): boolean {
  for (const day of plan.days) {
    for (const item of day.items) {
      if (item.id === exceptItemId) continue;
      if (item.place?.placeId === placeId) return true;
    }
  }
  return plan.accommodation?.place.placeId === placeId;
}

function failed(error: StructuralEditError): StructuralEditResult {
  return { status: "failed", errors: [error] };
}
