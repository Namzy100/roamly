import type { ItineraryItem, TripPlan } from "@/lib/schemas";
import type { DayFilter } from "@/lib/store/workspace-store";

export type VisibleItem = {
  item: ItineraryItem;
  dayNumber: number;
  /** The number shown on both the itinerary card and the map pin. */
  displayNumber: number;
};

/**
 * The single derivation of "what is on screen right now".
 *
 * Both panes read from this, which is what keeps a card's number and its pin's
 * number identical by construction rather than by two parallel calculations
 * that could drift.
 *
 * A single day numbers from 1. "All days" numbers continuously across the trip,
 * so no two visible pins ever share a number.
 */
export function getVisibleItems(
  plan: TripPlan,
  selectedDay: DayFilter,
): VisibleItem[] {
  const days =
    selectedDay === "all"
      ? plan.days
      : plan.days.filter((day) => day.dayNumber === selectedDay);

  const visible: VisibleItem[] = [];
  for (const day of days) {
    for (const item of day.items) {
      visible.push({
        item,
        dayNumber: day.dayNumber,
        displayNumber: visible.length + 1,
      });
    }
  }
  return visible;
}

/** Cross-pane lookup: item id → its display number. */
export function buildNumberLookup(
  visible: VisibleItem[],
): Map<string, number> {
  return new Map(visible.map((entry) => [entry.item.id, entry.displayNumber]));
}
