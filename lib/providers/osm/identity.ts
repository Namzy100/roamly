import type { OsmElementType } from "@/lib/schemas/place";

/**
 * The one authoritative place canonical OSM ids are built and parsed.
 *
 * Format: `osm:{type}:{id}` — `osm:node:240109189`.
 *
 * Why the element type is part of the identity: OSM id spaces are **per element
 * type**. Node 240109189, way 240109189 and relation 240109189 are three
 * different things that all exist. Keying on the numeric id alone would collide
 * them, silently merging unrelated places.
 *
 * Identity never derives from a name, a coordinate or an array index. Names and
 * coordinates change as the map is edited; array position changes on every
 * refilter. Only the element type and id are stable.
 */

const CANONICAL_PATTERN = /^osm:(node|way|relation):(\d+)$/;

export type OsmIdentity = {
  osmType: OsmElementType;
  osmId: string;
};

export class InvalidOsmIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOsmIdentityError";
  }
}

/**
 * Builds a canonical id. Throws rather than returning a sentinel: an unusable
 * identity must fail at the point of construction, not travel onward as a string
 * that merely looks like an id.
 */
export function toCanonicalId(
  osmType: OsmElementType,
  osmId: string | number,
): string {
  const id = typeof osmId === "number" ? String(osmId) : osmId.trim();

  if (!/^\d+$/.test(id)) {
    throw new InvalidOsmIdentityError(
      `OSM id must be a positive integer, received ${JSON.stringify(osmId)}`,
    );
  }
  // Rejects "007" and "0": OSM ids start at 1 and are never zero-padded, so a
  // padded value means two spellings of one identity.
  if (id.length > 1 && id.startsWith("0")) {
    throw new InvalidOsmIdentityError(
      `OSM id must not be zero-padded, received ${JSON.stringify(osmId)}`,
    );
  }
  if (id === "0") {
    throw new InvalidOsmIdentityError("OSM ids start at 1");
  }
  if (osmType !== "node" && osmType !== "way" && osmType !== "relation") {
    throw new InvalidOsmIdentityError(
      `Unknown OSM element type ${JSON.stringify(osmType)}`,
    );
  }

  return `osm:${osmType}:${id}`;
}

/** Parses a canonical id, or returns null when it is not one. */
export function parseCanonicalId(canonicalId: string): OsmIdentity | null {
  const match = CANONICAL_PATTERN.exec(canonicalId);
  if (!match) return null;

  const [, osmType, osmId] = match;
  if (osmId.length > 1 && osmId.startsWith("0")) return null;
  if (osmId === "0") return null;

  return { osmType: osmType as OsmElementType, osmId };
}

/** Throwing form, for places where a malformed id is a hard failure. */
export function requireCanonicalId(canonicalId: string): OsmIdentity {
  const parsed = parseCanonicalId(canonicalId);
  if (!parsed) {
    throw new InvalidOsmIdentityError(
      `Not a canonical OSM id: ${JSON.stringify(canonicalId)}`,
    );
  }
  return parsed;
}

export function isCanonicalId(value: string): boolean {
  return parseCanonicalId(value) !== null;
}

/**
 * True when `osmType`/`osmId` reconstruct exactly `canonicalId`.
 *
 * Pool validation uses this so a record cannot carry an identity that disagrees
 * with its own element fields.
 */
export function identityMatchesCanonicalId(
  canonicalId: string,
  osmType: OsmElementType,
  osmId: string,
): boolean {
  try {
    return toCanonicalId(osmType, osmId) === canonicalId;
  } catch {
    return false;
  }
}

/** Nominatim's `osm_type` is a single letter on some endpoints. */
export function normalizeOsmType(raw: string): OsmElementType | null {
  switch (raw.toLowerCase()) {
    case "n":
    case "node":
      return "node";
    case "w":
    case "way":
      return "way";
    case "r":
    case "relation":
      return "relation";
    default:
      return null;
  }
}
