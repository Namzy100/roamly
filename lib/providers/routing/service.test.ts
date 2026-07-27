import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MatrixRequest, RouteRequest } from "@/lib/routing";

import { routingCache } from "./cache";
import { ROUTING_CLIENT_ID } from "./config";
import { RoutingProviderError } from "./errors";
import { routeMatrix, routeSegment, routeSegments } from "./service";

/**
 * Service behaviour with a mocked `fetch`. No public endpoint is contacted.
 *
 * ## Why this file is not instant
 *
 * The module-level limiter is the real one, enforcing a genuine gap between
 * outbound request *starts*. A suite making N mocked calls therefore waits
 * roughly N × the interval. That is deliberate: it demonstrates the pacing is
 * actually wired into the service rather than merely implemented next to it,
 * and the interval is short enough that the cost is a couple of seconds.
 *
 * Cache hits are checked before the limiter, so they cost nothing — which is
 * why the cache tests are fast.
 */

const SHAPE = "kb|yhAnkylPjvB_uCpxBoyF";

const REQUEST: RouteRequest = {
  origin: { latitude: 38.7139, longitude: -9.1394 },
  destination: { latitude: 38.7101, longitude: -9.133 },
  mode: "walk",
};

function routeBody(overrides: { time?: number; length?: number } = {}) {
  const summary = {
    time: overrides.time ?? 681.558,
    length: overrides.length ?? 0.881,
  };
  return {
    trip: {
      status: 0,
      status_message: "Found route between points",
      units: "kilometers",
      summary,
      legs: [{ summary, shape: SHAPE }],
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  routingCache.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("routeSegment — success path", () => {
  it("returns a normalised routed segment", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));

    const result = await routeSegment(REQUEST);

    expect(result.status).toBe("routed");
    if (result.status !== "routed") return;
    expect(result.distanceMeters).toBeCloseTo(881, 3);
    expect(result.geometry.coordinates).toHaveLength(3);
  });

  it("sends the identifying fair-use headers", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));
    await routeSegment(REQUEST);

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;

    // The demo server's operator must be able to see who is generating traffic.
    expect(headers["X-Client-Id"]).toBe(ROUTING_CLIENT_ID);
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["User-Agent"]).toContain("RoamlyWeekendProject");
  });

  it("requests only what this phase needs", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));
    await routeSegment(REQUEST);

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/route");

    const body = JSON.parse(init.body as string);
    expect(body.costing).toBe("pedestrian");
    expect(body.units).toBe("kilometers");
    // Maneuvers suppressed: ~80% smaller response for data we would discard.
    expect(body.directions_type).toBe("none");
    expect(body.locations).toHaveLength(2);
    expect(body.alternates).toBeUndefined();
  });

  it("maps each mode to its costing profile", async () => {
    for (const [mode, costing] of [
      ["walk", "pedestrian"],
      ["drive", "auto"],
      ["bicycle", "bicycle"],
    ] as const) {
      fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));
      await routeSegment({ ...REQUEST, mode });

      const call = fetchMock.mock.calls.at(-1)!;
      expect(JSON.parse(call[1].body as string).costing).toBe(costing);
    }
  });

  it("never changes the requested mode", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));

    // A 25 km bicycle request stays a bicycle request. Substitution is a
    // product decision and it does not happen in the provider layer.
    const result = await routeSegment({
      ...REQUEST,
      destination: { latitude: 38.7979, longitude: -9.3907 },
      mode: "bicycle",
    });

    expect(result.status === "routed" && result.mode).toBe("bicycle");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).costing).toBe(
      "bicycle",
    );
  });
});

describe("routeSegment — unsupported modes", () => {
  it("refuses transit without contacting the provider", async () => {
    const result = await routeSegment({
      ...REQUEST,
      // Reaching past the type system, as a plain-JS caller could.
      mode: "transit" as never,
    });

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toBe("unsupported_mode");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("routeSegment — failure classification", () => {
  it("treats error_code 170 as a genuine no-route", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          error_code: 170,
          error: "Locations are in unconnected regions.",
          status_code: 400,
        },
        400,
      ),
    );

    const result = await routeSegment(REQUEST);

    expect(result.status).toBe("unavailable");
    expect(result.status === "unavailable" && result.reason).toBe("no_route");
    // One attempt. A no-route will not improve on a second ask.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats error_code 154 as a no-route, not a malformed request", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error_code: 154, error: "Path distance exceeds the max distance limit" },
        400,
      ),
    );

    const result = await routeSegment(REQUEST);
    expect(result.status === "unavailable" && result.reason).toBe("no_route");
  });

  it("treats an input error code as invalid_locations", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error_code: 120, error: "Insufficient locations" }, 400),
    );

    const result = await routeSegment(REQUEST);
    expect(result.status === "unavailable" && result.reason).toBe("invalid_locations");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a provider-level error inside HTTP 200", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        trip: {
          status: 207,
          status_message: "No path could be found",
          summary: { time: 0, length: 0 },
          legs: [],
        },
      }),
    );

    const result = await routeSegment(REQUEST);
    expect(result.status === "unavailable" && result.reason).toBe("no_route");
  });

  it("treats an HTML body under HTTP 200 as transient and retries once", async () => {
    fetchMock
      .mockResolvedValueOnce(
        textResponse("<html><body>502 Bad Gateway</body></html>", 200, {
          "Content-Type": "text/html",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(routeBody()));

    const result = await routeSegment(REQUEST);

    expect(result.status).toBe("routed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats an empty 200 body as transient", async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse("", 200))
      .mockResolvedValueOnce(jsonResponse(routeBody()));

    const result = await routeSegment(REQUEST);
    expect(result.status).toBe("routed");
  });

  it("treats malformed JSON as unreadable and does not retry", async () => {
    fetchMock.mockResolvedValueOnce(textResponse("{ not json", 200));

    const result = await routeSegment(REQUEST);

    expect(result.status === "unavailable" && result.reason).toBe("invalid_response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 503 exactly once, then gives up", async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse("busy", 503))
      .mockResolvedValueOnce(textResponse("busy", 503));

    const result = await routeSegment(REQUEST);

    expect(result.status === "unavailable" && result.reason).toBe(
      "provider_unavailable",
    );
    // One retry, never a storm.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("honours Retry-After on a 429", async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse("slow down", 429, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(routeBody()));

    const result = await routeSegment(REQUEST);
    expect(result.status).toBe("routed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a network failure as unavailable rather than throwing", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const result = await routeSegment(REQUEST);
    expect(result.status).toBe("unavailable");
  });

  it("reports a caller abort without retrying", async () => {
    const abortError = new Error("Aborted");
    abortError.name = "AbortError";
    fetchMock.mockRejectedValueOnce(abortError);

    const result = await routeSegment(REQUEST);

    expect(result.status === "unavailable" && result.reason).toBe("aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("routeSegment — caching", () => {
  it("serves a repeat request without a second call", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));

    const first = await routeSegment(REQUEST);
    const second = await routeSegment(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("keys separately by mode", async () => {
    // A factory, not a shared instance: a Response body can only be read once.
    fetchMock.mockImplementation(() => jsonResponse(routeBody()));

    await routeSegment({ ...REQUEST, mode: "walk" });
    await routeSegment({ ...REQUEST, mode: "drive" });

    // Collapsing these would return a walking duration for a drive, which is
    // the most damaging cache bug available here.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rounds coordinates so float noise does not fragment the cache", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));

    await routeSegment(REQUEST);
    await routeSegment({
      ...REQUEST,
      origin: { latitude: 38.71390000001, longitude: -9.13940000002 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not collapse materially different coordinates", async () => {
    // A factory, not a shared instance: a Response body can only be read once.
    fetchMock.mockImplementation(() => jsonResponse(routeBody()));

    await routeSegment(REQUEST);
    await routeSegment({
      ...REQUEST,
      origin: { latitude: 38.7149, longitude: -9.1394 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("caches a genuine no-route", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error_code: 170, error: "Unconnected regions" }, 400),
    );

    const first = await routeSegment(REQUEST);
    const second = await routeSegment(REQUEST);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("never caches a provider failure as though it were data", async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse("busy", 503))
      .mockResolvedValueOnce(textResponse("busy", 503))
      .mockResolvedValueOnce(jsonResponse(routeBody()));

    const first = await routeSegment(REQUEST);
    expect(first.status).toBe("unavailable");

    // The next ask reaches the provider again — an outage must not be pinned
    // into the app for 24 hours.
    const second = await routeSegment(REQUEST);
    expect(second.status).toBe("routed");
  });

  it("does not cache an unsupported-mode refusal", async () => {
    await routeSegment({ ...REQUEST, mode: "transit" as never });
    fetchMock.mockResolvedValueOnce(jsonResponse(routeBody()));

    const result = await routeSegment(REQUEST);
    expect(result.status).toBe("routed");
  });
});

describe("routeSegments — batching", () => {
  const REQUESTS: RouteRequest[] = [
    REQUEST,
    { ...REQUEST, destination: { latitude: 38.72, longitude: -9.14 } },
    { ...REQUEST, destination: { latitude: 38.73, longitude: -9.15 } },
  ];

  it("returns one result per request, in order", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(routeBody({ time: 100 })))
      .mockResolvedValueOnce(jsonResponse(routeBody({ time: 200 })))
      .mockResolvedValueOnce(jsonResponse(routeBody({ time: 300 })));

    const results = await routeSegments(REQUESTS);

    expect(results).toHaveLength(3);
    expect(results.every((result) => result.status === "routed")).toBe(true);
  });

  it("keeps successful legs when one fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(routeBody()))
      .mockResolvedValueOnce(
        jsonResponse({ error_code: 170, error: "Unconnected regions" }, 400),
      )
      .mockResolvedValueOnce(jsonResponse(routeBody()));

    const results = await routeSegments(REQUESTS);

    // Partial failure is the normal case. Discarding two good legs because of
    // one bad one would be the worst possible handling of a flaky server.
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual(["routed", "routed", "unavailable"]);
  });

  it("deduplicates identical requests within a batch", async () => {
    // A factory, not a shared instance: a Response body can only be read once.
    fetchMock.mockImplementation(() => jsonResponse(routeBody()));

    const results = await routeSegments([REQUEST, REQUEST, REQUEST]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual(results[2]);
  });

  it("returns an empty array for no requests", async () => {
    expect(await routeSegments([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates an abort", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      routeSegments(REQUESTS, { signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("routeMatrix", () => {
  const MATRIX: MatrixRequest = {
    sources: [
      { latitude: 38.7139, longitude: -9.1394 },
      { latitude: 38.7101, longitude: -9.133 },
    ],
    targets: [
      { latitude: 38.7139, longitude: -9.1394 },
      { latitude: 38.6968, longitude: -9.2035 },
    ],
    mode: "drive",
  };

  const MATRIX_BODY = {
    units: "kilometers",
    sources_to_targets: [
      [
        { from_index: 0, to_index: 0, time: 0, distance: 0 },
        { from_index: 0, to_index: 1, time: 987, distance: 7.363 },
      ],
      [
        { from_index: 1, to_index: 0, time: 197, distance: 0.941 },
        { from_index: 1, to_index: 1, time: 938, distance: 7.16 },
      ],
    ],
  };

  it("returns a normalised matrix", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MATRIX_BODY));

    const matrix = await routeMatrix(MATRIX);

    expect(matrix.durationsSeconds).toHaveLength(2);
    expect(matrix.distancesMeters[0][1]).toBeCloseTo(7_363, 3);
  });

  it("hits the matrix endpoint, not the route endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MATRIX_BODY));
    await routeMatrix(MATRIX);

    expect(String(fetchMock.mock.calls[0][0])).toContain("/sources_to_targets");
  });

  it("caches a repeat matrix", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(MATRIX_BODY));

    await routeMatrix(MATRIX);
    await routeMatrix(MATRIX);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not share a cache entry when sources and targets are swapped", async () => {
    fetchMock.mockImplementation(() => jsonResponse(MATRIX_BODY));

    await routeMatrix(MATRIX);
    await routeMatrix({
      ...MATRIX,
      sources: MATRIX.targets,
      targets: MATRIX.sources,
    });

    // A matrix is read positionally, so these are different answers.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a request over the element cap without calling out", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      latitude: 38.7 + index / 1_000,
      longitude: -9.1,
    }));

    await expect(
      routeMatrix({ sources: many, targets: many, mode: "drive" }),
    ).rejects.toThrow(RoutingProviderError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsupported mode without calling out", async () => {
    await expect(
      routeMatrix({ ...MATRIX, mode: "transit" as never }),
    ).rejects.toThrow(/cannot be routed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws rather than returning a partial matrix", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ sources_to_targets: [MATRIX_BODY.sources_to_targets[0]] }),
    );

    await expect(routeMatrix(MATRIX)).rejects.toThrow(/rows, expected 2/);
  });
});
