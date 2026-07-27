"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Tracks a CSS media query.
 *
 * `matchMedia` is an external store with a subscribe/read pair, so it is read
 * through `useSyncExternalStore` rather than mirrored into state by an effect —
 * the effect form causes a cascading render on every mount, and lint rightly
 * rejects it.
 *
 * `getServerSnapshot` returns `false`, so server output always reflects the
 * narrow layout and the client corrects after hydration without a mismatch.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onStoreChange);
      return () => list.removeEventListener("change", onStoreChange);
    },
    [query],
  );

  const getSnapshot = useCallback(
    () => window.matchMedia(query).matches,
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/** Matches Tailwind's `lg` breakpoint, where the split screen appears. */
export const LG_QUERY = "(min-width: 64rem)";
