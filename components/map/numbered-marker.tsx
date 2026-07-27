"use client";

import { BedDouble, Check } from "lucide-react";

import type { VisibleMapPlace } from "@/lib/map/types";
import { cn } from "@/lib/utils";

/**
 * A marker's visible button.
 *
 * Kept free of any map-library import so it renders identically under MapLibre
 * and under the fallback panel.
 *
 * Accessibility notes:
 *  - it is a real `<button>`, so it is tabbable and operable with Enter/Space
 *  - selection is conveyed by **shape and an icon**, not by colour alone: the
 *    selected marker gains a ring and a check glyph, and `aria-pressed` carries
 *    the state for assistive tech
 *  - the hit area is padded out to ~44×44 px via a transparent wrapper, while the
 *    visible dot stays 32 px, so touch targets meet the minimum without the map
 *    looking like it is covered in buttons
 */
export function NumberedMarker({
  place,
  selected,
  hovered,
  onSelect,
  onHoverChange,
}: {
  place: VisibleMapPlace;
  selected: boolean;
  hovered: boolean;
  onSelect: () => void;
  onHoverChange: (hovered: boolean) => void;
}) {
  const isStay = place.kind === "accommodation";

  const label = isStay
    ? `Where you're staying: ${place.name}`
    : `Stop ${place.sequenceNumber}: ${place.name}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
      onFocus={() => onHoverChange(true)}
      onBlur={() => onHoverChange(false)}
      aria-pressed={selected}
      aria-label={label}
      title={label}
      /**
       * Identifies a map marker regardless of which renderer drew it. The
       * itinerary cards carry a similar "Stop N: …" aria-label, so selecting
       * markers by label alone matches both; these attributes disambiguate.
       */
      data-roamly-marker={place.kind}
      data-item-id={place.itemId}
      // 44x44 hit area, transparent, centred on the coordinate.
      className="flex size-11 cursor-pointer items-center justify-center rounded-full bg-transparent p-0"
    >
      <span
        aria-hidden
        className={cn(
          "relative flex items-center justify-center rounded-full border-2 border-cream-raised font-display text-xs font-semibold shadow-card transition-all duration-150",
          selected ? "size-9" : "size-8",
          selected && "ring-2 ring-terracotta ring-offset-1 ring-offset-cream",
          isStay
            ? selected
              ? "bg-terracotta text-accent-foreground"
              : "bg-ink text-primary-foreground"
            : selected
              ? "bg-terracotta text-accent-foreground"
              : hovered
                ? "bg-forest-soft text-primary-foreground"
                : "bg-forest text-primary-foreground",
        )}
      >
        {isStay ? <BedDouble className="size-4" /> : place.sequenceNumber}

        {/*
         * Selection is signalled three ways that survive colour-blindness and
         * greyscale: the ring above, the size change above, and this badge. The
         * number itself always stays visible — replacing it would hide *which*
         * stop is selected, which is the one thing the marker exists to say.
         */}
        {selected ? (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border border-cream-raised bg-forest text-primary-foreground">
            <Check className="size-2.5" strokeWidth={3.5} />
          </span>
        ) : null}
      </span>
    </button>
  );
}
