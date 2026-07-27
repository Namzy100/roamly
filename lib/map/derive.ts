import { isMappableItem, type TripPlan } from "@/lib/schemas";
import { getVisibleItems } from "@/lib/trip/visible-items";

import type { DayFilterValue, VisibleMapPlace } from "./types";

/**
 * Turns a plan plus the active day filter into the flat list of places the map
 * renders.
 *
 * Three rules, in this order:
 *
 *  1. **Numbering is the itinerary's, not the map's.** Sequence numbers come from
 *     `getVisibleItems`, which numbers every visible card. The map then filters,
 *     so its numbers can have gaps — card 3 being unavailable means there is no
 *     marker 3. That is correct: the alternative is renumbering, which would make
 *     a card and its marker disagree.
 *  2. **Unmappable items are dropped**, never rendered at 0,0 or at the city
 *     centre. An item is unmappable if the pipeline could not fill it
 *     (`status: "unavailable"`) or it has no single location (`place: null`).
 *  3. **Accommodation is appended, not interleaved.** It is a distinct kind, has
 *     no sequence number of its own, and belongs to no single day.
 *
 * Duplicate coordinates are kept: two stops can legitimately share a place (a
 * market visited twice), and each needs its own marker tied to its own card.
 */
export function deriveVisibleMapPlaces(
  plan: TripPlan,
  activeDay: DayFilterValue,
  options: { includeAccommodation?: boolean } = {},
): VisibleMapPlace[] {
  const { includeAccommodation = true } = options;

  // `flatMap` with a guarded local binding rather than `filter` + `map`: it lets
  // the type predicate narrow `place` to non-null without a `!` assertion.
  const places: VisibleMapPlace[] = getVisibleItems(plan, activeDay).flatMap(
    (entry) => {
      const item = entry.item;
      if (!isMappableItem(item)) return [];
      return [
        {
          itemId: item.id,
          placeId: item.place.placeId,
          sequenceNumber: entry.displayNumber,
          name: item.place.name,
          latitude: item.place.coordinates.lat,
          longitude: item.place.coordinates.lng,
          kind: "stop" as const,
          dayNumber: entry.dayNumber,
        },
      ];
    },
  );

  // Null when no stay could be recommended — a generated trip in a place with no
  // mapped accommodation. There is simply no marker to draw.
  if (includeAccommodation && plan.accommodation !== null) {
    const stay = plan.accommodation.place;
    places.push({
      // Prefixed so it can never collide with an itinerary item id, and so a
      // marker click on the stay cannot select a card that does not exist.
      itemId: `accommodation:${stay.placeId}`,
      placeId: stay.placeId,
      sequenceNumber: 0,
      name: stay.name,
      latitude: stay.coordinates.lat,
      longitude: stay.coordinates.lng,
      kind: "accommodation",
      dayNumber: null,
    });
  }

  return places;
}

/** True for the synthetic id `deriveVisibleMapPlaces` gives the accommodation. */
export function isAccommodationSelection(itemId: string | null): boolean {
  return itemId !== null && itemId.startsWith("accommodation:");
}

/**
 * Drops a selection that is no longer on the map — the usual cause being a day
 * change that filtered the selected stop away.
 *
 * The accommodation is exempt: it is present in every day view, so a selected
 * stay survives day changes.
 */
export function reconcileSelection(
  selectedItemId: string | null,
  places: VisibleMapPlace[],
): string | null {
  if (selectedItemId === null) return null;
  return places.some((place) => place.itemId === selectedItemId)
    ? selectedItemId
    : null;
}
