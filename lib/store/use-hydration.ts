"use client";

import { useEffect, useSyncExternalStore } from "react";

import { useTripStore } from "./trip-store";

/**
 * Zustand's persist API is already a subscribe/snapshot pair, so hydration state
 * is read with `useSyncExternalStore` rather than mirrored into local state via
 * an effect. That avoids the cascading render an effect-plus-setState causes, and
 * `getServerSnapshot` guarantees the server and the first client render agree.
 */
const subscribe = (onStoreChange: () => void) =>
  useTripStore.persist.onFinishHydration(onStoreChange);

const getSnapshot = () => useTripStore.persist.hasHydrated();

/** The server never has storage, so it always reports "not hydrated". */
const getServerSnapshot = () => false;

/**
 * Reads persisted trips out of localStorage after mount and reports when that
 * has finished.
 *
 * Callers must hold back any storage-dependent UI until this returns `true` —
 * otherwise React reconciles a "no trips" server tree against a "has trips"
 * client tree.
 */
export function useTripStoreHydration(): boolean {
  // The store is created with `skipHydration`, so the read has to be kicked off
  // explicitly. Safe to call repeatedly; zustand no-ops once hydrated.
  useEffect(() => {
    void useTripStore.persist.rehydrate();
  }, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
