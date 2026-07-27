import type { PlaceCategory } from "@/lib/schemas/place";

import { isAllowedCategory, tagFiltersFor } from "./categories";
import { LIMITS, OVERPASS_QUERY_TIMEOUT_S } from "./config";
import { ProviderError } from "./errors";

/**
 * Overpass QL construction.
 *
 * ## Why this cannot be injected
 *
 * Nothing caller-supplied is ever interpolated as text. The query is assembled
 * from exactly three kinds of value:
 *
 *  1. **Tag keys and values** — looked up from the allowlist in `categories.ts`.
 *     A category that is not in the allowlist throws before any string building.
 *  2. **Numbers** — latitude, longitude, radius and limits, each range-checked and
 *     then re-emitted through `Number.prototype.toFixed`/`String(Math.round(...))`.
 *     A non-finite value is rejected, so no `NaN`, `Infinity`, or numeric string
 *     carrying punctuation can survive.
 *  3. **Literal syntax** written in this file.
 *
 * There is therefore no path for a `;`, `]`, `)` or `->` supplied by a caller to
 * reach the query. The tests assert this directly by attempting it.
 *
 * ## Shape
 *
 * One statement per category, each with its own result-set and `out`, so the
 * per-category cap is enforced by Overpass rather than after transfer. `nwr`
 * matches nodes, ways and relations; `center` gives ways and relations a single
 * representative coordinate so every result is mappable.
 */

export type OverpassQueryInput = {
  center: { latitude: number; longitude: number };
  categories: PlaceCategory[];
  radiusMeters: number;
  limitPerCategory: number;
};

export type ValidatedOverpassQuery = {
  query: string;
  /** Echoed back so callers and cache keys use the clamped values, not the input. */
  categories: PlaceCategory[];
  radiusMeters: number;
  limitPerCategory: number;
  center: { latitude: number; longitude: number };
};

/**
 * Validates and clamps input, then builds the query.
 *
 * Clamping rather than rejecting for radius and limit: a caller asking for a
 * 500 km radius has made a mistake we can safely correct downwards, and refusing
 * outright would be less useful than answering within our ceiling. Categories are
 * the opposite — an unknown category is a programming error or an attack, and is
 * rejected.
 */
export function buildOverpassQuery(
  input: OverpassQueryInput,
): ValidatedOverpassQuery {
  const latitude = requireFiniteInRange(input.center.latitude, -90, 90, "latitude");
  const longitude = requireFiniteInRange(
    input.center.longitude,
    -180,
    180,
    "longitude",
  );

  if (!Array.isArray(input.categories) || input.categories.length === 0) {
    throw new ProviderError(
      "malformed_query",
      "overpass",
      "At least one category is required",
    );
  }

  // Deduplicate before capping, so a caller repeating one category does not use up
  // their category budget.
  const unique: PlaceCategory[] = [];
  for (const candidate of input.categories) {
    if (!isAllowedCategory(candidate)) {
      throw new ProviderError(
        "malformed_query",
        "overpass",
        `Category not in the allowlist: ${JSON.stringify(candidate)}`,
      );
    }
    if (!unique.includes(candidate)) unique.push(candidate);
  }

  if (unique.length > LIMITS.maxCategoriesPerRequest) {
    throw new ProviderError(
      "malformed_query",
      "overpass",
      `At most ${LIMITS.maxCategoriesPerRequest} categories per request, received ${unique.length}`,
    );
  }

  const radiusMeters = clampInteger(
    input.radiusMeters,
    LIMITS.minRadiusMeters,
    LIMITS.maxRadiusMeters,
    LIMITS.defaultRadiusMeters,
  );
  const limitPerCategory = clampInteger(
    input.limitPerCategory,
    1,
    LIMITS.maxResultsPerCategory,
    LIMITS.maxResultsPerCategory,
  );

  // Sorted so the same request always produces the same query text, which in turn
  // makes the cache key and any recorded fixture stable.
  const categories = [...unique].sort();

  // 7 decimal places is ~1 cm; well beyond what a radius search needs, and it
  // guarantees no exponential notation for small values.
  const lat = latitude.toFixed(7);
  const lon = longitude.toFixed(7);

  const statements = categories
    .map((category, index) => {
      const set = `c${index}`;
      const filters = tagFiltersFor(category)
        .map(
          (filter) =>
            `  nwr["${filter.key}"="${filter.value}"](around:${radiusMeters},${lat},${lon});`,
        )
        .join("\n");
      return `(\n${filters}\n)->.${set};\n.${set} out center ${limitPerCategory};`;
    })
    .join("\n");

  const query = `[out:json][timeout:${OVERPASS_QUERY_TIMEOUT_S}];\n${statements}\n`;

  return {
    query,
    categories,
    radiusMeters,
    limitPerCategory,
    center: { latitude, longitude },
  };
}

function requireFiniteInRange(
  value: unknown,
  min: number,
  max: number,
  label: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderError(
      "malformed_query",
      "overpass",
      `${label} must be a finite number`,
    );
  }
  if (value < min || value > max) {
    throw new ProviderError(
      "malformed_query",
      "overpass",
      `${label} must be between ${min} and ${max}`,
    );
  }
  return value;
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
