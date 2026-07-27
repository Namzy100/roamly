import { describe, expect, it } from "vitest";

import { discoverPlaces } from "@/lib/providers/osm/discover";
import { isProviderError } from "@/lib/providers/osm/errors";
import { geocodeDestination } from "@/lib/providers/osm/geocode";
import { isCanonicalId } from "@/lib/providers/osm/identity";
import { buildVerifiedPlacePool } from "@/lib/schemas/pool";
import type { GeocodedDestination } from "@/lib/providers/osm/normalize";
import type { PlaceDiscoveryResult } from "@/lib/providers/osm/discover";

/**
 * Opt-in live check against the public OpenStreetMap services.
 *
 * Run with `npm run test:integration:osm`. Deliberately **excluded** from
 * `npm test` — Nominatim and Overpass are volunteer-run, and a unit suite that hit
 * them on every save would be exactly the abuse the rate limiter exists to prevent.
 *
 * Responsible-use properties:
 *  - **three requests total**: one geocode, one discovery, one cached repeat
 *  - one fixed destination (Lisbon), a 1.5 km radius, two categories
 *  - the real limiter, so pacing is honoured
 *  - no polling and no loop
 *  - a provider outage **skips** rather than fails, so this can never break CI over
 *    someone else's server load
 */

const DESTINATION = "Lisbon";
const CATEGORIES = ["museum", "viewpoint"] as const;
const RADIUS_METERS = 1_500;

/** Overpass in particular sheds load by returning a busy page. Not our bug. */
function isOutage(error: unknown): boolean {
  return (
    isProviderError(error) &&
    ["unavailable", "timeout", "rate_limited"].includes(error.kind)
  );
}

describe("live OpenStreetMap providers", () => {
  let destination: GeocodedDestination | null = null;
  let discovery: PlaceDiscoveryResult | null = null;

  it("geocodes a destination through Nominatim", async () => {
    try {
      const result = await geocodeDestination({ destination: DESTINATION });
      expect(result.candidates.length).toBeGreaterThan(0);

      destination = result.candidates[0];
      expect(isCanonicalId(destination.canonicalId)).toBe(true);
      expect(Number.isFinite(destination.latitude)).toBe(true);
      expect(Number.isFinite(destination.longitude)).toBe(true);
      expect(
        `osm:${destination.source.osmType}:${destination.source.osmId}`,
      ).toBe(destination.canonicalId);

      console.log(`  destination: ${destination.displayName}`);
      console.log(`  attribution: ${result.attribution}`);
    } catch (error) {
      if (isOutage(error)) {
        console.log("  SKIPPED — Nominatim unavailable right now");
        return;
      }
      throw error;
    }
  });

  it("discovers real places through Overpass", async () => {
    if (!destination) {
      console.log("  SKIPPED — no destination from the previous step");
      return;
    }

    try {
      discovery = await discoverPlaces({
        center: {
          latitude: destination.latitude,
          longitude: destination.longitude,
        },
        categories: [...CATEGORIES],
        radiusMeters: RADIUS_METERS,
        limitPerCategory: 10,
      });
    } catch (error) {
      if (isOutage(error)) {
        console.log("  SKIPPED — Overpass unavailable right now");
        return;
      }
      throw error;
    }

    expect(discovery.places.length).toBeGreaterThan(0);

    for (const place of discovery.places) {
      expect(isCanonicalId(place.placeId)).toBe(true);
      expect(place.source.provider).toBe("openstreetmap");
      expect(place.source.canonicalId).toBe(place.placeId);
      expect(`osm:${place.source.osmType}:${place.source.osmId}`).toBe(
        place.placeId,
      );
      expect(place.name.trim().length).toBeGreaterThan(0);
      expect(Number.isFinite(place.coordinates.lat)).toBe(true);
      expect(Number.isFinite(place.coordinates.lng)).toBe(true);
      expect(discovery.categoriesRequested).toContain(place.category);

      // The no-fabrication guarantee, asserted against live data.
      expect(place.rating).toBeUndefined();
      expect(place.userRatingCount).toBeUndefined();
      expect(place.priceLevel).toBeUndefined();
    }

    console.log(`  ${discovery.places.length} places, sample:`);
    for (const place of discovery.places.slice(0, 5)) {
      const optional = [
        place.address ? "address" : null,
        place.website ? "website" : null,
        place.openingHours ? "opening_hours" : null,
      ].filter(Boolean);
      console.log(
        `    ${place.placeId}  ${place.name} [${place.category}]` +
          (optional.length
            ? ` (+${optional.join(", ")})`
            : " (no optional metadata)"),
      );
    }
    console.log(`  attribution: ${discovery.attribution}`);
  });

  it("builds a valid pool from live results", () => {
    if (!discovery) {
      console.log("  SKIPPED — no discovery result");
      return;
    }

    const pool = buildVerifiedPlacePool(discovery.places, {
      poolId: "integration-check",
      createdAt: discovery.fetchedAt,
      categories: discovery.categoriesRequested,
      attribution: discovery.attribution,
    });

    expect(pool.places).toHaveLength(discovery.places.length);
  });

  it("serves an identical repeat query from cache", async () => {
    if (!destination || !discovery) {
      console.log("  SKIPPED — nothing cached to re-request");
      return;
    }

    const repeat = await discoverPlaces({
      center: {
        latitude: destination.latitude,
        longitude: destination.longitude,
      },
      categories: [...CATEGORIES],
      radiusMeters: RADIUS_METERS,
      limitPerCategory: 10,
    });

    // Proves the cache genuinely spares the public service a second request.
    expect(repeat.fromCache).toBe(true);
    expect(repeat.places).toHaveLength(discovery.places.length);
  });
});
