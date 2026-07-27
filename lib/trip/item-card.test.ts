import { describe, expect, it } from "vitest";

import { fixtureSavedPlan } from "@/lib/refinement/test-fixtures";
import type { ItineraryItem } from "@/lib/schemas";

import { cardElementId, cardTitleId, selectionLabelFor } from "./item-card";

/**
 * What the card's selection control says.
 *
 * This is the whole of what a screen-reader user gets from the control — the card's visible text is
 * inside a `pointer-events-none` region with no role of its own — so the wording is load-bearing
 * rather than decorative. The DOM structure that carries it is checked in `test/browser/run.mjs`;
 * these tests pin the sentence.
 */

function itemNamed(id: string): ItineraryItem {
  const found = fixtureSavedPlan()
    .days.flatMap((day) => day.items)
    .find((item) => item.id === id);

  if (!found) throw new Error(`fixture has no item ${id}`);
  return found;
}

describe("selectionLabelFor", () => {
  it("leads with the stop number, so the card and its map pin share one handle", () => {
    const label = selectionLabelFor({
      item: itemNamed("museum-one"),
      displayNumber: 2,
    });

    expect(label.startsWith("Stop 2: ")).toBe(true);
  });

  it("names the place and the time window", () => {
    const item = itemNamed("museum-one");
    const label = selectionLabelFor({ item, displayNumber: 2 });

    expect(label).toContain(item.title);
    expect(item.place).not.toBeNull();
    expect(label).toContain(` at ${item.place?.name}`);
    expect(label).toContain(item.startTime);
    expect(label).toContain(item.endTime);
  });

  /**
   * The promise is conditional on there being something to keep it with.
   *
   * A placeless stop — a free-time block — has no marker, so offering to locate it on the map would
   * be an instruction that silently does nothing. `isMappableItem` is the single predicate the map
   * derivation uses, which is why this cannot drift.
   */
  it("offers to locate a stop on the map only when it has a marker", () => {
    const withPlace = itemNamed("museum-one");
    expect(selectionLabelFor({ item: withPlace, displayNumber: 2 })).toContain(
      "Select to locate on the map.",
    );

    const placeless: ItineraryItem = { ...withPlace, place: null };
    const label = selectionLabelFor({ item: placeless, displayNumber: 2 });

    expect(label).not.toContain("locate on the map");
    /**
     * The exact string, because a substring assertion cannot express "no place clause was
     * appended" — the fixture's own title contains the word "at", and a `not.toContain(" at ")`
     * would fail on the title while proving nothing about the clause.
     */
    expect(label).toBe(
      `Stop 2: ${placeless.title}. ${placeless.startTime} – ${placeless.endTime}.`,
    );
  });

  it("says an unavailable stop is unavailable, and does not offer to locate it", () => {
    const unavailable: ItineraryItem = {
      ...itemNamed("museum-one"),
      status: "unavailable",
    };

    const label = selectionLabelFor({ item: unavailable, displayNumber: 2 });

    expect(label).toContain("Not currently available.");
    expect(label).not.toContain("locate on the map");
  });

  /**
   * The number is the *display* number, not the position in the day.
   *
   * With a single day selected the two coincide; across the whole trip they do not, and the card
   * must agree with the map pin rather than with its own index.
   */
  it("uses the display number it is given rather than anything derived from the item", () => {
    const item = itemNamed("museum-one");

    expect(selectionLabelFor({ item, displayNumber: 7 })).toContain("Stop 7:");
    expect(selectionLabelFor({ item, displayNumber: 1 })).toContain("Stop 1:");
  });
});

describe("card element ids", () => {
  /**
   * The panel scrolls a map-originated selection into view by looking this id up. A card that
   * renamed its own id would break that with nothing thrown — the scroll would just stop happening
   * — so both sides go through one function.
   */
  it("derives the scroll anchor from the item id", () => {
    expect(cardElementId("museum-one")).toBe("trip-item-museum-one");
  });

  it("gives the heading an id distinct from the region's", () => {
    expect(cardTitleId("museum-one")).not.toBe(cardElementId("museum-one"));
    expect(
      cardTitleId("museum-one").startsWith(cardElementId("museum-one")),
    ).toBe(true);
  });
});
