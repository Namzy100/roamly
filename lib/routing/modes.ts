import type { TravelMode } from "@/lib/schemas/enums";

import type { RoutingMode } from "./types";

/**
 * The mode vocabulary, and the one place it is translated.
 *
 * Two vocabularies exist and both are load-bearing. `TravelMode` (`WALK`,
 * `TRANSIT`, `DRIVE`, `BICYCLE`) is what the itinerary and its UI speak, and it
 * includes transit because a *plan* may legitimately say "take the metro" as an
 * estimate. `RoutingMode` (`walk`, `drive`, `bicycle`) is what we can actually
 * route, and it excludes transit because we cannot.
 *
 * The asymmetry is the point: `toTravelMode` is total, `toRoutingMode` is
 * partial. A transit leg simply has no routable form, and the type system says
 * so rather than letting one be substituted.
 */

export const ROUTING_MODES: readonly RoutingMode[] = [
  "walk",
  "drive",
  "bicycle",
] as const;

export function isRoutingMode(value: unknown): value is RoutingMode {
  return (
    typeof value === "string" &&
    (ROUTING_MODES as readonly string[]).includes(value)
  );
}

/** Every routing mode has an itinerary mode. */
export function toTravelMode(mode: RoutingMode): TravelMode {
  switch (mode) {
    case "walk":
      return "WALK";
    case "drive":
      return "DRIVE";
    case "bicycle":
      return "BICYCLE";
  }
}

/**
 * Not every itinerary mode has a routable form. `TRANSIT` returns `null`, and
 * callers must handle that rather than falling back to walking or driving.
 */
export function toRoutingMode(mode: TravelMode): RoutingMode | null {
  switch (mode) {
    case "WALK":
      return "walk";
    case "DRIVE":
      return "drive";
    case "BICYCLE":
      return "bicycle";
    case "TRANSIT":
      return null;
  }
}

/**
 * Display labels.
 *
 * "Drive" rather than "Taxi": the routing profile is a private car on roads, and
 * calling it a taxi implies an availability and a price we know nothing about.
 * `TRAVEL_MODE_LABELS` keeps saying "Taxi" for the sample plan's estimates,
 * which is what that sample data actually meant.
 */
export const ROUTING_MODE_LABELS: Record<RoutingMode, string> = {
  walk: "Walk",
  drive: "Drive",
  bicycle: "Cycle",
};

/** Lower-case form for sentences: "12 min walk", "3.2 km drive". */
export const ROUTING_MODE_NOUNS: Record<RoutingMode, string> = {
  walk: "walk",
  drive: "drive",
  bicycle: "cycle",
};
