import { z } from "zod";

/**
 * Zod schemas for the **raw** provider payloads.
 *
 * These types never leave the provider module. Everything crossing the boundary is
 * a normalised `TripPlace` or `GeocodedDestination`. Validating here means a
 * provider changing its response shape produces a clean `invalid_response` at the
 * edge rather than `undefined` propagating into the itinerary.
 *
 * Shapes verified against live responses on 2026-07-26, not recalled.
 */

/**
 * Nominatim sends coordinates as strings. Reject anything not finite.
 *
 * The empty-string guard is load-bearing: `Number("")` and `Number(" ")` are `0`,
 * so without it a missing coordinate would validate as latitude 0, longitude 0 —
 * a real point in the Gulf of Guinea, and the classic "null island" data bug. An
 * absent coordinate must fail, not relocate the place to the Atlantic.
 */
const NumericString = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    if (typeof value === "string" && value.trim() === "") {
      ctx.addIssue({ code: "custom", message: "Coordinate must not be empty" });
      return z.NEVER;
    }
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
      ctx.addIssue({ code: "custom", message: "Expected a finite number" });
      return z.NEVER;
    }
    return parsed;
  });

const Latitude = NumericString.refine(
  (value) => value >= -90 && value <= 90,
  "Latitude out of range",
);
const Longitude = NumericString.refine(
  (value) => value >= -180 && value <= 180,
  "Longitude out of range",
);

/** Accepts both the full words and the single letters Nominatim can emit. */
export const RawOsmTypeSchema = z.enum([
  "node",
  "way",
  "relation",
  "n",
  "w",
  "r",
]);

/**
 * One `search` result under `format=jsonv2`.
 *
 * `boundingbox` is `[south, north, west, east]` — **not** the west/south/east/north
 * order most APIs use. Getting it wrong silently produces a valid-looking box in
 * the wrong place, so it is reordered explicitly in `normalize.ts`.
 */
export const NominatimSearchResultSchema = z.object({
  osm_type: RawOsmTypeSchema,
  osm_id: z.union([z.number().int(), z.string().regex(/^\d+$/)]),
  lat: Latitude,
  lon: Longitude,
  name: z.string().optional(),
  display_name: z.string().min(1),
  category: z.string().optional(),
  type: z.string().optional(),
  addresstype: z.string().optional(),
  boundingbox: z.array(z.string()).length(4).optional(),
  address: z
    .object({
      country_code: z.string().min(2).max(2).optional(),
      city: z.string().optional(),
      town: z.string().optional(),
      village: z.string().optional(),
      county: z.string().optional(),
      state: z.string().optional(),
      country: z.string().optional(),
    })
    .partial()
    .optional(),
});
export type NominatimSearchResult = z.infer<typeof NominatimSearchResultSchema>;

export const NominatimSearchResponseSchema = z.array(
  NominatimSearchResultSchema,
);

/**
 * One Overpass element under `out center`.
 *
 * Nodes carry top-level `lat`/`lon`; ways and relations carry `center: {lat, lon}`
 * instead. Both are accepted and reconciled in `normalize.ts` — an element with
 * neither is dropped rather than defaulted to a coordinate it does not have.
 */
export const OverpassElementSchema = z.object({
  type: z.enum(["node", "way", "relation"]),
  id: z.number().int().positive(),
  lat: Latitude.optional(),
  lon: Longitude.optional(),
  center: z
    .object({ lat: Latitude, lon: Longitude })
    .optional(),
  /** Absent when an element has no tags at all; such elements are dropped. */
  tags: z.record(z.string(), z.string()).optional(),
});
export type OverpassElement = z.infer<typeof OverpassElementSchema>;

export const OverpassResponseSchema = z.object({
  elements: z.array(OverpassElementSchema),
  /** Present on real responses; useful for diagnostics, not required. */
  generator: z.string().optional(),
  osm3s: z
    .object({
      timestamp_osm_base: z.string().optional(),
      copyright: z.string().optional(),
    })
    .optional(),
  /** Overpass reports some failures inside a 200 JSON body. */
  remark: z.string().optional(),
});
export type OverpassResponse = z.infer<typeof OverpassResponseSchema>;

/** Extracts a single coordinate from either element shape. */
export function elementCoordinates(
  element: OverpassElement,
): { lat: number; lon: number } | null {
  if (element.lat !== undefined && element.lon !== undefined) {
    return { lat: element.lat, lon: element.lon };
  }
  if (element.center) {
    return { lat: element.center.lat, lon: element.center.lon };
  }
  return null;
}
