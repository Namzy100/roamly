import type { RoutingMode } from "./types";

/**
 * The one authoritative constructor and parser for routing leg identity.
 *
 * Format: `day:{dayNumber}:from:{originItemId}:to:{destinationItemId}:mode:{mode}`
 *
 * ## Why identity is built from these four things
 *
 * A leg is "the journey between two specific stops on a specific day, by a
 * specific means". Each component is load-bearing:
 *
 *  - **`dayNumber`** — the same two places can be visited on two days, and those
 *    are two different journeys with two different results. Without the day, a
 *    Tuesday result could be attached to a Wednesday leg.
 *  - **item ids**, not place ids — a market visited twice in one day is two
 *    stops, and each needs its own leg. Item ids are also what the itinerary UI
 *    and the map already key selection on.
 *  - **mode** — the walking and driving routes between the same points are
 *    different paths with different durations. Two results for the same pair in
 *    different modes must not collide.
 *
 * ## Why not array position
 *
 * A day's eligible stops are derived by *filtering* the itinerary: an
 * unavailable slot or a placeless afternoon is skipped, so leg 2 of the derived
 * list is not item 2 of the day. Position is a property of one derivation run,
 * not of the journey, and keying on it means a plan that gains an unavailable
 * item silently reattaches every result to the wrong leg.
 *
 * ## Why not coordinates
 *
 * Coordinates are a *fact about* a leg, and they are checked as one — but two
 * stops can share coordinates (a market visited twice), so they cannot be the
 * primary identity. They serve as defence in depth in `lib/plan/enrich-routing`.
 */

/**
 * The synthetic item ids used when a day is bracketed by the accommodation.
 *
 * Hyphenated rather than colon-separated because a colon is the leg id's own
 * delimiter, and these have to survive round-tripping through it. The `@`
 * prefix is what a `nanoid` and the mock's `d1_i2_<placeId>` scheme both cannot
 * produce, so these can never collide with a real item id.
 */
export const ACCOMMODATION_ORIGIN_ID = "@accommodation-origin";
/** Distinct from the origin, so an outbound and a return leg cannot collide. */
export const ACCOMMODATION_RETURN_ID = "@accommodation-return";

export type RoutingLegIdParts = {
  dayNumber: number;
  fromItemId: string;
  toItemId: string;
  mode: RoutingMode;
};

/**
 * Item ids come from `nanoid` and from the mock's own `d1_i2_<placeId>` scheme,
 * neither of which contains a colon — but nothing enforces that, and a colon in
 * an id would make the result ambiguous to parse. Rejected at construction so a
 * malformed identity cannot exist rather than being discovered later.
 */
const FORBIDDEN_IN_SEGMENT = ":";

export class InvalidLegIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLegIdError";
  }
}

export function routingLegId(parts: RoutingLegIdParts): string {
  const { dayNumber, fromItemId, toItemId, mode } = parts;

  if (!Number.isInteger(dayNumber) || dayNumber < 1) {
    throw new InvalidLegIdError(
      `Day number must be a positive integer, received ${JSON.stringify(dayNumber)}`,
    );
  }
  assertUsableSegment("origin item id", fromItemId);
  assertUsableSegment("destination item id", toItemId);

  return `day:${dayNumber}:from:${fromItemId}:to:${toItemId}:mode:${mode}`;
}

const LEG_ID_PATTERN =
  /^day:(\d+):from:([^:]+):to:([^:]+):mode:(walk|drive|bicycle)$/;

/** Parses a leg id, or returns `null` when the string is not one. */
export function parseRoutingLegId(value: string): RoutingLegIdParts | null {
  const match = LEG_ID_PATTERN.exec(value);
  if (!match) return null;

  const [, dayNumber, fromItemId, toItemId, mode] = match;
  return {
    dayNumber: Number(dayNumber),
    fromItemId,
    toItemId,
    mode: mode as RoutingMode,
  };
}

export function isRoutingLegId(value: string): boolean {
  return parseRoutingLegId(value) !== null;
}

/**
 * The accommodation's synthetic ids are deliberately colon-bearing in spirit but
 * not in fact — they use a prefix a real item id cannot produce, and they are
 * built here so no caller invents a third spelling.
 */
export function accommodationLegEndpointId(
  position: "origin" | "return",
): string {
  return position === "origin"
    ? ACCOMMODATION_ORIGIN_ID
    : ACCOMMODATION_RETURN_ID;
}

function assertUsableSegment(label: string, value: string): void {
  if (value.length === 0) {
    throw new InvalidLegIdError(`Leg ${label} must not be empty`);
  }
  if (value.includes(FORBIDDEN_IN_SEGMENT)) {
    throw new InvalidLegIdError(
      `Leg ${label} must not contain ":", received ${JSON.stringify(value)}`,
    );
  }
}
