import { formatTimeRange } from "@/lib/format";
import { isMappableItem, type ItineraryItem } from "@/lib/schemas";

/**
 * What the itinerary card's selection control announces.
 *
 * Extracted from the component deliberately. Before Phase 8 the whole card was one `<button>`, so
 * this string *was* the card's accessible name and nothing else could be confused with it. Now the
 * card is an `<article>` with a separate selection control and its own action buttons, which means
 * three names exist in one region and only one of them says "select to locate on the map".
 *
 * Keeping it here, pure and free of JSX, is what lets it be tested at all: the repository has no
 * jsdom and no React Testing Library, so a rendered assertion is not available. The DOM wiring is
 * checked in `test/browser/run.mjs`; the wording is checked here.
 */
export function selectionLabelFor({
  item,
  displayNumber,
}: {
  item: ItineraryItem;
  displayNumber: number;
}): string {
  /**
   * The same predicate the map derivation uses.
   *
   * A card must not offer "locate on the map" for a stop that has no marker — an unfilled slot or a
   * placeless free-time block. Asking `isMappableItem` rather than re-testing `status` and `place`
   * here is what keeps the promise and the map from drifting apart.
   */
  const mappable = isMappableItem(item);

  return [
    `Stop ${displayNumber}: ${item.title}`,
    item.place ? ` at ${item.place.name}` : "",
    `. ${formatTimeRange(item.startTime, item.endTime)}.`,
    item.status === "unavailable" ? " Not currently available." : "",
    mappable ? " Select to locate on the map." : "",
  ].join("");
}

/**
 * The id of the card's outer region, and the anchor the panel scrolls to.
 *
 * A function rather than a template literal repeated in two files: the panel looks this element up
 * with `getElementById` to scroll a map-originated selection into view, and a card that renamed its
 * own id would break that silently — the scroll would simply stop happening, with nothing thrown.
 */
export function cardElementId(itemId: string): string {
  return `trip-item-${itemId}`;
}

/** The heading the outer region is named by. Separate from the selection control's own label. */
export function cardTitleId(itemId: string): string {
  return `trip-item-${itemId}-title`;
}
