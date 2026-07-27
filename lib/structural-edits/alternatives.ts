import { evaluateItem } from "@/lib/plan";
import type { TripGenerationContext, TripPlace, TripPlan } from "@/lib/schemas";

import { locateItem } from "./locate";
import { alternativeIsSelectable } from "./select-alternative";

/**
 * How many alternatives a stop offers at once.
 *
 * Six, matching `hoursConflictCandidates`. A swap is a choice between recognisable options, not a
 * browse through the pool — a list long enough to scroll is a list nobody reads to the end, and the
 * place pool panel is where the full set belongs.
 */
const DEFAULT_LIMIT = 6;

/**
 * The places a stop could be swapped to.
 *
 * ## Why this exists as a derivation rather than a filter at the call site
 *
 * `alternativeIsSelectable` answers the question for *one* place, and its own comment describes it
 * as "the predicate the alternatives derivation filters on" — this is that derivation. Keeping it
 * here rather than inline in the panel means the picker cannot show an option the applier would
 * refuse, because both sides ask the same function in the same order.
 *
 * ## Same category, and nothing cleverer
 *
 * A swap replaces a museum with a museum. Widening it to "anything nearby" would turn a swap into a
 * re-plan, and re-planning is what the refinement commands are for — this one is deliberately the
 * small, deterministic edit that needs no model. A stop with no place has no category and so offers
 * nothing, which is the same answer `alternativeIsSelectable` gives.
 *
 * ## Closed places are ordered last, not hidden
 *
 * `hoursConflictCandidates` *excludes* a place the hours say is shut, because there the whole point
 * is escaping a closure. Here the traveller is choosing freely, and a place that is shut on this
 * day may still be exactly what they want — they may intend to move the stop afterwards. So the
 * hours affect the **order** and never the membership, and `commitStructuralEdit` raises
 * `hours_conflict_after_edit` if the swap lands on a closure. Hiding an option and refusing one are
 * both defensible; hiding it *silently* while claiming to list the alternatives is not.
 *
 * Pure: no clock beyond the day's own date, no network, no model, no store.
 */
export function alternativesForItem(input: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
  dayNumber: number;
  itemId: string;
  /** From the generation context. Absent means hours cannot be judged, so order is pool order. */
  timezone?: string | null;
  limit?: number;
}): TripPlace[] {
  if (!input.generation) return [];

  const located = locateItem(input.plan, input.dayNumber, input.itemId);
  if (!located.ok) return [];

  const { day, item } = located.value;

  const category = item.place?.category;
  if (!category) return [];

  const open: TripPlace[] = [];
  const unknown: TripPlace[] = [];
  const closed: TripPlace[] = [];

  for (const place of input.generation.placePool.places) {
    if (place.category !== category) continue;

    /**
     * The one gate, asked exactly as the applier asks it.
     *
     * Covers the lock, the place-less stop, the same place, a retained place, membership of the
     * active pool, and a place the plan already uses. Re-implementing any of those here is how a
     * picker starts offering something that fails on save.
     */
    if (
      !alternativeIsSelectable({
        plan: input.plan,
        generation: input.generation,
        item,
        place,
      })
    ) {
      continue;
    }

    const status = evaluateItem(
      { ...item, place },
      day.date,
      input.timezone ?? undefined,
    ).status;

    if (status === "confirmed_open") open.push(place);
    else if (status === "confirmed_closed") closed.push(place);
    else unknown.push(place);
  }

  // Open first, because it is the only group we can say anything definite about; shut last.
  return [...open, ...unknown, ...closed].slice(0, input.limit ?? DEFAULT_LIMIT);
}
