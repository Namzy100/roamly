import { toRoutingMode } from "@/lib/routing";
import { isRoutedSegment, type TripPlan } from "@/lib/schemas";

import type { DayFilterValue, MapRouteLine } from "./types";

/**
 * Turns an enriched plan plus the active day filter into the route lines the map
 * draws.
 *
 * The routing counterpart of `deriveVisibleMapPlaces`, and it follows the same
 * three rules:
 *
 *  1. **Only routed segments produce a line.** An estimate has no geometry and
 *     an unavailable leg has nothing to draw. Neither contributes a feature, so
 *     there is no path by which a guess or a gap reaches the map looking like a
 *     road.
 *  2. **Day filtering is the itinerary's.** A line belongs to the day whose
 *     items produced it, so the All Days view keeps each day's routes separate
 *     exactly as the sequence line does.
 *  3. **Identity is stable.** The segment's own leg id, which encodes day, both
 *     item ids and the mode — never an array index, which changes on every
 *     refilter and would recycle the wrong React key.
 *
 * Route geometry survives a page refresh for free: it lives on the validated
 * plan in localStorage, so this derivation runs against restored data on the
 * next visit with nothing extra to rehydrate.
 */
export function deriveMapRouteLines(
  plan: TripPlan,
  activeDay: DayFilterValue,
  options: { selectedItemId?: string | null } = {},
): MapRouteLine[] {
  const days =
    activeDay === "all"
      ? plan.days
      : plan.days.filter((day) => day.dayNumber === activeDay);

  const lines: MapRouteLine[] = [];

  for (const day of days) {
    for (const item of day.items) {
      const segment = item.travelToNext;
      if (!segment || !isRoutedSegment(segment)) continue;

      // `RoutedTravelMode` is the uppercase itinerary vocabulary; the map speaks
      // the lowercase routing one. `toRoutingMode` is partial only for transit,
      // which a routed segment cannot be.
      const mode = toRoutingMode(segment.mode);
      if (mode === null) continue;

      lines.push({
        legId: segment.id,
        mode,
        coordinates: segment.geometry.coordinates,
        dayNumber: day.dayNumber,
        // The leg leaving the selected stop is the one worth emphasising: it is
        // the journey the traveller is looking at from that card.
        selected: options.selectedItemId === item.id,
      });
    }
  }

  return lines;
}

/** True when a plan has at least one routed leg anywhere. */
export function planHasRoutedGeometry(plan: TripPlan): boolean {
  return plan.days.some((day) =>
    day.items.some((item) => item.travelToNext && isRoutedSegment(item.travelToNext)),
  );
}
