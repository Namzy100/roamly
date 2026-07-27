import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { nominatimCache, overpassCache } from "./cache";
import { discoverPlaces } from "./discover";
import { ProviderError } from "./errors";
import { geocodeDestination } from "./geocode";

/**
 * Client behaviour with a mocked `fetch`. No public endpoint is contacted.
 *
 * ## Why this file takes ~30 seconds
 *
 * The module-level limiters are the real ones, enforcing a genuine ≥1.1s gap between
 * outbound Nominatim calls — so a suite that makes N mocked network calls waits
 * N × 1.1s. That is the point: it demonstrates the pacing is actually wired into the
 * clients, not merely implemented next to them.
 *
 * **Do not "fix" the duration by shortening the interval or bypassing the limiter.**
 * The pacing logic itself is verified quickly and exhaustively against a virtual
 * clock in `rate-limit.test.ts`; this file deliberately pays the real cost.
 *
 * Cache hits are checked *before* the limiter, so they cost nothing — which is why
 * the cache tests are fast.
 */

const NOMINATIM_BODY = [
  {
    osm_type: "relation",
    osm_id: 5400890,
    lat: "38.7077507",
    lon: "-9.1365919",
    name: "Lisboa",
    display_name: "Lisboa, Portugal",
    boundingbox: ["38.6913994", "38.7967584", "-9.2298356", "-9.0863328"],
    address: { country_code: "pt" },
  },
];

const OVERPASS_BODY = {
  elements: [
    {
      type: "node",
      id: 1623055925,
      lat: 38.7124,
      lon: -9.1381,
      tags: { name: "Museu Geológico", tourism: "museum" },
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  nominatimCache.clear();
  overpassCache.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geocodeDestination", () => {
  it("normalises a provider response into candidates", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NOMINATIM_BODY));

    const result = await geocodeDestination({ destination: "Lisbon" });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].canonicalId).toBe("osm:relation:5400890");
    expect(result.attribution).toContain("OpenStreetMap");
    expect(result.fromCache).toBe(false);
  });

  it("sends an identifying User-Agent and asks for JSON", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NOMINATIM_BODY));
    await geocodeDestination({ destination: "Lisbon" });

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    // Nominatim blocks unidentified traffic; this is a policy requirement.
    expect(headers["User-Agent"]).toContain("RoamlyWeekendProject");
    expect(headers["User-Agent"]).toContain("http");
    expect(headers.Accept).toBe("application/json");
  });

  it("requests only supported parameters", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NOMINATIM_BODY));
    await geocodeDestination({ destination: "Lisbon", countryCode: "PT" });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/search");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("countrycodes")).toBe("pt");
  });

  it("serves a repeat query from cache without a second request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NOMINATIM_BODY));

    const first = await geocodeDestination({ destination: "Lisbon" });
    const second = await geocodeDestination({ destination: "Lisbon" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.candidates).toEqual(first.candidates);
  });

  it("treats the cache key as case-insensitive for the query", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NOMINATIM_BODY));
    await geocodeDestination({ destination: "Lisbon" });
    const second = await geocodeDestination({ destination: "LISBON" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
  });

  it("caches an empty result too, so a miss is not re-asked immediately", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    const first = await geocodeDestination({ destination: "Nowhereatall" });
    const second = await geocodeDestination({ destination: "Nowhereatall" });

    expect(first.candidates).toEqual([]);
    expect(second.fromCache).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deduplicates candidates sharing one OSM identity", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([NOMINATIM_BODY[0], NOMINATIM_BODY[0]]),
    );
    const result = await geocodeDestination({ destination: "Lisbon" });
    expect(result.candidates).toHaveLength(1);
  });

  it("drops malformed records but keeps the valid ones", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        NOMINATIM_BODY[0],
        { ...NOMINATIM_BODY[0], osm_type: "street", osm_id: 1 },
      ]),
    );
    // The whole array fails schema validation, so this surfaces as invalid_response
    // rather than silently returning half the data.
    await expect(
      geocodeDestination({ destination: "Lisbon" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
  });

  it("rejects an empty or over-long destination without calling out", async () => {
    await expect(geocodeDestination({ destination: "   " })).rejects.toBeInstanceOf(
      ProviderError,
    );
    await expect(
      geocodeDestination({ destination: "x".repeat(200) }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed country code without calling out", async () => {
    await expect(
      geocodeDestination({ destination: "Lisbon", countryCode: "portugal" }),
    ).rejects.toMatchObject({ kind: "malformed_query" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not cache a provider failure as successful data", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));

    await expect(geocodeDestination({ destination: "Lisbon" })).rejects.toBeInstanceOf(
      ProviderError,
    );
    // A retry happened (2 attempts), and nothing was cached.
    expect(nominatimCache.size).toBe(0);
  });
});

describe("error and retry model", () => {
  it("retries a 5xx exactly once, then gives up", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));

    await expect(
      geocodeDestination({ destination: "Retry Test" }),
    ).rejects.toMatchObject({ kind: "unavailable" });

    // One retry ceiling: two attempts total, never a storm.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("succeeds on the retry when the first attempt was transient", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse(NOMINATIM_BODY));

    const result = await geocodeDestination({ destination: "Flaky" });
    expect(result.candidates).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400 — a malformed query will not fix itself", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 400));

    await expect(
      geocodeDestination({ destination: "Bad Query" }),
    ).rejects.toMatchObject({ kind: "malformed_query" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unreadable-but-stable response", async () => {
    fetchMock.mockResolvedValue(
      new Response("not json at all", { status: 200 }),
    );

    await expect(
      geocodeDestination({ destination: "Garbage" }),
    ).rejects.toMatchObject({ kind: "invalid_response" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies Overpass's HTML busy page as transient, not invalid", async () => {
    // Verified live: Overpass answers "server too busy" with HTTP 200 and HTML.
    // Misclassifying that as a permanent invalid_response would skip the retry.
    const html =
      "<html><body><p>Error: runtime error: ... The server is probably too busy to handle your request.</p></body></html>";
    // A fresh Response per call: a body can only be read once, and this path retries.
    fetchMock.mockImplementation(() => new Response(html, { status: 200 }));

    await expect(
      discoverPlaces({
        center: { latitude: 38.72, longitude: -9.14 },
        categories: ["museum"],
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies an Overpass JSON remark about timing out as transient", async () => {
    fetchMock.mockImplementation(() =>
      jsonResponse({ elements: [], remark: "runtime error: Query timed out" }),
    );

    await expect(
      discoverPlaces({
        center: { latitude: 38.72, longitude: -9.14 },
        categories: ["cafe"],
      }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("surfaces a caller abort as aborted, and does not retry it", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      geocodeDestination({ destination: "Aborted", signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps provider detail internal but exposes a safe message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 429));

    try {
      await geocodeDestination({ destination: "Limited" });
      throw new Error("expected a rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      const providerError = error as ProviderError;
      expect(providerError.status).toBe(429);
      expect(providerError.httpStatus).toBe(429);
      // Nothing identifying the upstream service reaches the user-facing string.
      expect(providerError.userMessage).not.toMatch(/nominatim|overpass|http/i);
    }
  });
});

describe("discoverPlaces", () => {
  it("normalises elements and reports query metadata", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OVERPASS_BODY));

    const result = await discoverPlaces({
      center: { latitude: 38.7223, longitude: -9.1393 },
      categories: ["museum"],
      radiusMeters: 2_000,
    });

    expect(result.places).toHaveLength(1);
    expect(result.places[0].placeId).toBe("osm:node:1623055925");
    expect(result.query.radiusMeters).toBe(2_000);
    expect(result.categoriesRequested).toEqual(["museum"]);
    expect(result.attribution).toContain("OpenStreetMap");
  });

  it("POSTs the query rather than putting it in a URL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OVERPASS_BODY));
    await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["museum"],
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("data=");
    expect(String(init.body)).toContain("out+center");
  });

  it("never sends a category outside the allowlist", async () => {
    await expect(
      discoverPlaces({
        center: { latitude: 38.72, longitude: -9.14 },
        categories: ["nightlife" as never],
      }),
    ).rejects.toMatchObject({ kind: "malformed_query" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports why elements were discarded", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        elements: [
          OVERPASS_BODY.elements[0],
          { type: "node", id: 2, lat: 1, lon: 2 },
          { type: "node", id: 3, lat: 1, lon: 2, tags: { tourism: "museum" } },
          { type: "relation", id: 4, tags: { name: "X", leisure: "park" } },
        ],
      }),
    );

    const result = await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["museum"],
    });

    expect(result.places).toHaveLength(1);
    expect(result.discarded.total).toBe(3);
    expect(result.discarded.noCategory).toBe(1);
    expect(result.discarded.noName).toBe(1);
    expect(result.discarded.noCoordinates).toBe(1);
  });

  it("lists categories that returned nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OVERPASS_BODY));
    const result = await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["museum", "beach"],
    });
    expect(result.query.categoriesWithNoResults).toEqual(["beach"]);
  });

  it("serves a repeat discovery from cache", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OVERPASS_BODY));

    const input = {
      center: { latitude: 38.7223, longitude: -9.1393 },
      categories: ["museum" as const],
      radiusMeters: 2_000,
    };
    const first = await discoverPlaces(input);
    const second = await discoverPlaces(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
  });

  it("shares one cache entry regardless of category order", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(OVERPASS_BODY));
    await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["museum", "cafe"],
    });
    const second = await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["cafe", "museum"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
  });

  it("returns an empty result rather than throwing when nothing matches", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ elements: [] }));
    const result = await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["beach"],
    });
    expect(result.places).toEqual([]);
    expect(result.query.categoriesWithNoResults).toEqual(["beach"]);
  });

  it("does not leak the raw provider payload", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ ...OVERPASS_BODY, generator: "Overpass API 0.7.62" }),
    );
    const result = await discoverPlaces({
      center: { latitude: 38.72, longitude: -9.14 },
      categories: ["museum"],
    });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain("Overpass API");
    expect(serialised).not.toContain("elements");
    expect("elements" in (result as object)).toBe(false);
  });
});
