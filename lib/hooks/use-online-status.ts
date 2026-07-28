"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether the browser thinks it can reach the network.
 *
 * ## What `navigator.onLine` does and does not mean
 *
 * `true` means there is *a* network interface up. It does not mean the internet is reachable, that
 * Overpass is answering, or that a captive portal is not intercepting everything. So this drives one
 * thing only: **not starting requests that cannot possibly succeed**, and saying so.
 *
 * `false`, by contrast, is reliable in the direction that matters. No browser reports offline while a
 * request would have worked. That asymmetry is why the app treats `false` as actionable and `true` as
 * merely "worth trying" — a provider failure while nominally online is still handled by the provider
 * paths that already exist, unchanged.
 *
 * ## Why `useSyncExternalStore`
 *
 * The value lives outside React and changes without a render. An effect-plus-state mirror would
 * cascade a render on mount and could read a stale value in between; this is exactly the shape the
 * hook exists for. `getServerSnapshot` returns `true` so the server renders the ordinary interface —
 * an offline banner in server HTML would be a claim about a machine that has no browser.
 */

function subscribe(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function getSnapshot(): boolean {
  // Some environments omit the property entirely; absence is not evidence of being offline.
  return typeof navigator === "undefined" ? true : navigator.onLine !== false;
}

const getServerSnapshot = () => true;

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * What is still possible with no network, stated once.
 *
 * Written here rather than in each component so the banner, the disabled controls and the tests agree
 * about which actions are provider-backed. Getting this list wrong in one place is how a traveller
 * ends up pressing a button that spins forever.
 */
export const OFFLINE_MESSAGE =
  "You're offline. Saved trip details, opening-hours checks, cost recalculation and structural edits all still work. Maps, place searches, route calculation and AI planning need a connection.";

/** Actions that cannot work offline, by the surface that offers them. */
export const PROVIDER_BACKED_ACTIONS = [
  "generate",
  "geocode",
  "route",
  "refine",
  "refresh-pool",
  "enrich-landmarks",
] as const;
export type ProviderBackedAction = (typeof PROVIDER_BACKED_ACTIONS)[number];

export function offlineReasonFor(action: ProviderBackedAction): string {
  switch (action) {
    case "generate":
      return "Generating a trip needs a connection: it searches OpenStreetMap for real places.";
    case "geocode":
      return "Confirming a destination needs a connection.";
    case "route":
      return "Calculating routes needs a connection to the routing service.";
    case "refine":
      return "This change needs a connection to the planner.";
    case "refresh-pool":
      return "Refreshing the available places needs a connection to OpenStreetMap.";
    case "enrich-landmarks":
      /*
       * Names both services, because they are two separate volunteer projects and a traveller who recognises one may not
       * recognise the other. "Landmark photos and context" rather than "enrichment", which is our word and not theirs.
       */
      return "Adding landmark photos and context needs a connection to Wikidata and Wikimedia Commons.";
  }
}
