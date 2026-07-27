/**
 * The scan that Zod cannot do.
 *
 * ## Why this exists at all
 *
 * `z.object().parse()` **strips** unknown keys by default. A model that helpfully
 * returns
 *
 * ```json
 * { "slotId": "d1-s1", "placeId": "osm:node:1", "latitude": 38.7, "rating": 4.6 }
 * ```
 *
 * parses cleanly, and `latitude` and `rating` vanish without a word. That is the
 * quiet failure mode this codebase is built to prevent: the fabrication does not
 * reach the plan, but nobody learns the model produced one, and the next schema
 * change might give it somewhere to land.
 *
 * So the **raw** payload is scanned before it is parsed, and a prohibited key is
 * a hard failure rather than a strip. It is deliberately not repairable: a model
 * asserting coordinates or ratings has crossed the one line the architecture
 * draws, and a second attempt is an invitation to fabricate differently.
 *
 * ## Choosing the list
 *
 * Keys, not values. Scanning values for anything place-shaped would be a
 * heuristic with false positives on legitimate prose ("the tram stops at Praça do
 * Comércio" is a fine sentence in a description). A key named `rating` is
 * unambiguous.
 *
 * Comparison is case-insensitive with separators removed, so `place_id`,
 * `placeID` and `PlaceId` are all the same key. The list covers three families:
 *
 *  - **identity** — anything that would let the model name a place itself
 *  - **provider facts** — ratings, prices, contact details, opening claims
 *  - **routing facts** — durations, distances, geometry
 *
 * `placeId` is prohibited in *strategy* output and required in *assembly* output,
 * which is why the allowlist is a parameter rather than a constant.
 */

export type ProhibitedFieldFinding = {
  /** Dotted path to the offending key, for the error message. */
  path: string;
  key: string;
};

/** Identity a model may never assert. */
const IDENTITY_KEYS = [
  "placeid",
  "placeids",
  "osmid",
  "osmtype",
  "canonicalid",
  "place",
  "places",
  "venue",
  "venuename",
  "businessname",
  "placename",
  "restaurantname",
  "hotelname",
  "source",
  "attribution",
];

/** Provider facts a model may never assert. */
const PROVIDER_FACT_KEYS = [
  "latitude",
  "longitude",
  "lat",
  "lng",
  "lon",
  "coordinates",
  "coordinate",
  "boundingbox",
  "rating",
  "ratings",
  "userratingcount",
  "reviewcount",
  "reviews",
  "pricelevel",
  "address",
  "website",
  "url",
  "phone",
  "telephone",
  "openinghours",
  "openinghour",
  "isopen",
  "isopennow",
  "opennow",
  "wheelchair",
  "cuisine",
];

/** Routing facts a model may never assert — these come from Valhalla or nowhere. */
const ROUTING_FACT_KEYS = [
  "durationminutes",
  "durationseconds",
  "traveltime",
  "traveldurationminutes",
  "distancemeters",
  "distancekm",
  "geometry",
  "polyline",
  "route",
  "routes",
  "leg",
  "legs",
  "travelmode",
  "travelsegment",
  "traveltonext",
];

export const PROHIBITED_KEYS: readonly string[] = [
  ...IDENTITY_KEYS,
  ...PROVIDER_FACT_KEYS,
  ...ROUTING_FACT_KEYS,
];

function canonicaliseKey(key: string): string {
  return key.replace(/[\s_\-.]/g, "").toLowerCase();
}

/**
 * Every prohibited key in a raw model payload.
 *
 * Returns findings rather than throwing so the caller can report all of them at
 * once — a single pass that names three problems is more useful than three
 * consecutive failures.
 *
 * `allow` is matched after canonicalisation, so passing `["placeId"]` permits
 * `place_id` too. That is intentional: the allowlist describes a concept, not a
 * spelling.
 */
export function findProhibitedFields(
  value: unknown,
  options: { allow?: readonly string[] } = {},
): ProhibitedFieldFinding[] {
  const allowed = new Set((options.allow ?? []).map(canonicaliseKey));
  const findings: ProhibitedFieldFinding[] = [];
  const prohibited = new Set(PROHIBITED_KEYS);

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    if (node === null || typeof node !== "object") return;

    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      const canonical = canonicaliseKey(key);
      const childPath = path ? `${path}.${key}` : key;

      if (prohibited.has(canonical) && !allowed.has(canonical)) {
        findings.push({ path: childPath, key });
        // Do not descend: everything under a fabricated `place` object is part of
        // the same finding, and listing each leaf would bury the actual problem.
        continue;
      }
      walk(child, childPath);
    }
  };

  walk(value, "");
  return findings;
}
