"use client";

import { create } from "zustand";

/**
 * Ephemeral workspace UI state — deliberately not persisted.
 *
 * This store is the single source of truth for selection, which is what makes
 * the itinerary and the map bidirectional without either pane holding a ref to
 * the other. A card click and a pin click write the same field; both panes read
 * it. `selectionSource` exists so only a map-originated selection scrolls the
 * list — otherwise clicking a card would fight the user's own scroll position.
 */

export type SelectionSource = "list" | "map" | "day";

/** `"all"` shows every day at once; a number narrows to that day. */
export type DayFilter = number | "all";

export type MobilePane = "plan" | "map";

type WorkspaceState = {
  selectedDay: DayFilter;
  selectedItemId: string | null;
  hoveredItemId: string | null;
  selectionSource: SelectionSource | null;
  mobilePane: MobilePane;
  selectDay: (day: DayFilter) => void;
  selectItem: (itemId: string | null, source: SelectionSource) => void;
  hoverItem: (itemId: string | null) => void;
  setMobilePane: (pane: MobilePane) => void;
  reset: () => void;
};

const INITIAL = {
  selectedDay: 1 as DayFilter,
  selectedItemId: null,
  hoveredItemId: null,
  selectionSource: null,
  mobilePane: "plan" as MobilePane,
};

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  ...INITIAL,

  selectDay: (day) =>
    set({ selectedDay: day, selectedItemId: null, selectionSource: "day" }),

  selectItem: (itemId, source) =>
    set((state) => ({
      // Clicking the selected card again clears it, which is how you dismiss a
      // highlighted pin without hunting for a close affordance.
      selectedItemId: state.selectedItemId === itemId ? null : itemId,
      selectionSource: source,
    })),

  hoverItem: (itemId) => set({ hoveredItemId: itemId }),

  setMobilePane: (pane) => set({ mobilePane: pane }),

  reset: () => set(INITIAL),
}));
