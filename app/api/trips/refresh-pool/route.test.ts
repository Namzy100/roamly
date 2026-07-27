import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RefreshPoolResponseSchema } from "@/lib/api/refresh-pool-contract";
import {
  FIXTURE_GENERATION,
  FIXTURE_PLACES,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { MAX_PERSISTED_POOL_PLACES } from "@/lib/schemas/generation";

import { POST, maxDuration } from "./route";

/**
 * The pool-refresh route boundary.
 *
 * The discovery adapter is mocked, because what is under test is the *boundary*: the body
 * ceiling, the caps, the destination requirement, the two delivery shapes, and — the properties
 * that cannot be tested anywhere else — that nothing here calls a model or the routing service,
 * that nothing is persisted, and that no raw provider payload ever crosses back.
 */

const refreshPlacePool = vi.hoisted(() => vi.fn());
const routeTripPlan = vi.hoisted(() => vi.fn());
const createStructuredGenerator = vi.hoisted(() => vi.fn());

vi.mock("@/lib/generate/refresh-pool", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/generate/refresh-pool")
  >("@/lib/generate/refresh-pool");
  return { ...actual, refreshPlacePool };
});
vi.mock("@/lib/providers/routing", () => ({ routeTripPlan }));
vi.mock("@/lib/providers/ai", () => ({ createStructuredGenerator }));

const PLAN = fixtureSavedPlan();

function body(overrides: Record<string, unknown> = {}) {
  return {
    plan: PLAN,
    generation: FIXTURE_GENERATION,
    reconciliation: "keep-valid-and-flag-missing",
    expectedRevision: 3,
    requestId: "req-abcdefgh",
    ...overrides,
  };
}

function request(payload: unknown): Request {
  return new Request("http://localhost/api/trips/refresh-pool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

/** A refreshed pool that is identical to the trip's, so nothing goes missing. */
function unchangedOutcome() {
  return {
    status: "ok" as const,
    partial: false,
    pool: {
      ...FIXTURE_GENERATION.placePool,
      createdAt: "2026-08-20T09:00:00.000Z",
    },
    summary: FIXTURE_GENERATION.discoverySummary,
    warnings: [],
  };
}

beforeEach(() => {
  refreshPlacePool.mockReset();
  routeTripPlan.mockReset();
  createStructuredGenerator.mockReset();
  refreshPlacePool.mockResolvedValue(unchangedOutcome());
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/trips/refresh-pool — a valid refresh", () => {
  it("returns a refreshed pool, a diff and a preview per policy", async () => {
    const response = await POST(request(body()));

    expect(response.status).toBe(200);
    const parsed = RefreshPoolResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== "ok") return;

    expect(parsed.data.pool.places.length).toBeGreaterThan(0);
    expect(parsed.data.changes.previousCount).toBe(
      FIXTURE_GENERATION.placePool.places.length,
    );
    expect(parsed.data.previews).toHaveLength(2);
    expect(parsed.data.previews.map((preview) => preview.policy).sort()).toEqual([
      "keep-valid-and-flag-missing",
      "replace-missing-with-unavailable",
    ]);
  });

  it("echoes the revision and the request id untouched", async () => {
    const response = await POST(request(body()));
    const json = await response.json();

    expect(json.expectedRevision).toBe(3);
    expect(json.requestId).toBe("req-abcdefgh");
  });

  it("searches the categories and radius the original search used", async () => {
    await POST(request(body()));

    expect(refreshPlacePool).toHaveBeenCalledTimes(1);
    const call = refreshPlacePool.mock.calls[0][0];
    expect(call.categories).toEqual(
      FIXTURE_GENERATION.discoverySummary.categoriesRequested,
    );
    expect(call.radiusMeters).toBe(
      FIXTURE_GENERATION.discoverySummary.radiusMeters,
    );
  });

  it("narrows to the categories the caller asked for", async () => {
    await POST(request(body({ categories: ["museum"], radiusMeters: 2_000 })));

    const call = refreshPlacePool.mock.calls[0][0];
    expect(call.categories).toEqual(["museum"]);
    expect(call.radiusMeters).toBe(2_000);
  });

  /**
   * The stored identity, never a fresh geocode. Re-geocoding "Lisbon" could resolve to a
   * different Lisbon and silently move the trip.
   */
  it("searches around the trip's own recorded destination", async () => {
    await POST(request(body()));

    const call = refreshPlacePool.mock.calls[0][0];
    expect(call.destination.canonicalId).toBe(
      FIXTURE_GENERATION.destination.canonicalId,
    );
    expect(call.destination.latitude).toBe(FIXTURE_GENERATION.destination.latitude);
  });

  it("passes an abort signal through", async () => {
    await POST(request(body()));
    expect(refreshPlacePool.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a missing used place in the diff", async () => {
    refreshPlacePool.mockResolvedValue({
      ...unchangedOutcome(),
      pool: {
        ...FIXTURE_GENERATION.placePool,
        createdAt: "2026-08-20T09:00:00.000Z",
        places: FIXTURE_GENERATION.placePool.places.filter(
          (place) => place.placeId !== FIXTURE_PLACES.museumOne.placeId,
        ),
      },
    });

    const response = await POST(request(body()));
    const parsed = RefreshPoolResponseSchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== "ok") return;

    expect(parsed.data.changes.missingUsedPlaceIds).toEqual([
      FIXTURE_PLACES.museumOne.placeId,
    ]);
    const keep = parsed.data.previews.find(
      (preview) => preview.policy === "keep-valid-and-flag-missing",
    );
    expect(keep?.retainedItemIds).toEqual(["museum-one"]);
  });

  it("passes a partial search through as partial", async () => {
    refreshPlacePool.mockResolvedValue({
      ...unchangedOutcome(),
      partial: true,
      warnings: [
        { code: "refresh_batch_failed", message: "One search did not complete." },
      ],
    });

    const response = await POST(request(body()));
    const json = await response.json();

    expect(json.partial).toBe(true);
    expect(json.warnings[0].code).toBe("refresh_batch_failed");
  });
});

describe("POST /api/trips/refresh-pool — what it never does", () => {
  it("calls no model and no routing service", async () => {
    await POST(request(body()));

    expect(createStructuredGenerator).not.toHaveBeenCalled();
    expect(routeTripPlan).not.toHaveBeenCalled();
  });

  /** A preview endpoint: it returns no plan, so nothing on the far side can save one unchecked. */
  it("returns no replacement plan", async () => {
    const response = await POST(request(body()));
    const json = await response.json();

    expect(json.plan).toBeUndefined();
    expect(json.generationContext).toBeUndefined();
  });

  it("lets no provider detail cross back", async () => {
    refreshPlacePool.mockResolvedValue({
      ...unchangedOutcome(),
      warnings: [
        { code: "refresh_batch_failed", message: "The search did not complete." },
      ],
    });

    const response = await POST(request(body()));
    const text = JSON.stringify(await response.json());

    for (const forbidden of ["overpass", "nominatim", "http://", "https://overpass"]) {
      expect(text.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("never caches its response", async () => {
    const response = await POST(request(body()));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /api/trips/refresh-pool — refusals", () => {
  it("rejects a body over the ceiling", async () => {
    const huge = "x".repeat(600 * 1024);
    const response = await POST(
      new Request("http://localhost/api/trips/refresh-pool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...body(), padding: huge }),
      }),
    );

    expect(response.status).toBe(413);
    expect(refreshPlacePool).not.toHaveBeenCalled();
  });

  it("rejects a malformed body", async () => {
    const response = await POST(request({ nope: true }));

    expect(response.status).toBe(400);
    expect(refreshPlacePool).not.toHaveBeenCalled();
  });

  it("rejects a radius outside the bounds", async () => {
    for (const radiusMeters of [10, 500, 90_000]) {
      const response = await POST(request(body({ radiusMeters })));
      expect(response.status, String(radiusMeters)).toBe(400);
    }
    expect(refreshPlacePool).not.toHaveBeenCalled();
  });

  it("rejects more categories than one refresh may search", async () => {
    const response = await POST(
      request(body({ categories: Array.from({ length: 9 }, () => "cafe") })),
    );

    expect(response.status).toBe(400);
    expect(refreshPlacePool).not.toHaveBeenCalled();
  });

  it("rejects a reconciliation policy it does not implement", async () => {
    const response = await POST(
      request(body({ reconciliation: "pick-something-similar" })),
    );

    expect(response.status).toBe(400);
  });

  it("rejects an oversized pool", async () => {
    const response = await POST(
      request(
        body({
          generation: {
            ...FIXTURE_GENERATION,
            placePool: {
              ...FIXTURE_GENERATION.placePool,
              places: Array.from(
                { length: MAX_PERSISTED_POOL_PLACES + 1 },
                (_, index) => ({
                  ...FIXTURE_PLACES.cafeOne,
                  placeId: `osm:node:${900_000 + index}`,
                  source: {
                    ...FIXTURE_PLACES.cafeOne.source,
                    canonicalId: `osm:node:${900_000 + index}`,
                    osmId: String(900_000 + index),
                  },
                }),
              ),
            },
          },
        }),
      ),
    );

    // Refused by the schema's own pool cap before the route's own check.
    expect(response.status).toBe(400);
    expect(refreshPlacePool).not.toHaveBeenCalled();
  });

  /**
   * A pool with no recorded search behind it cannot be compared with a fresh one, and searching
   * around a guessed centre would produce a diff that meant nothing.
   */
  it("refuses a trip whose pool did not come from a search", async () => {
    const response = await POST(
      request(
        body({
          generation: {
            ...FIXTURE_GENERATION,
            placePool: {
              ...FIXTURE_GENERATION.placePool,
              poolId: "plan-derived:trip-abc",
            },
          },
        }),
      ),
    );

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.status).toBe("failed");
    expect(json.reason).toBe("destination_unavailable");
    expect(refreshPlacePool).not.toHaveBeenCalled();
  });

  it("reports an empty search as a failure rather than an empty pool", async () => {
    refreshPlacePool.mockResolvedValue({
      status: "failed",
      reason: "no_results",
      message: "The refreshed search returned no places at all.",
    });

    const response = await POST(request(body()));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.status).toBe("failed");
    expect(json.reason).toBe("no_results");
  });

  it("reports a provider failure without naming the provider", async () => {
    refreshPlacePool.mockRejectedValue(
      new Error("connect ECONNREFUSED overpass-api.de:443"),
    );

    const response = await POST(request(body()));
    const json = await response.json();

    expect(json.status).toBe("failed");
    expect(json.reason).toBe("provider_unavailable");
    expect(JSON.stringify(json).toLowerCase()).not.toContain("overpass");
  });

  it("reports a cancelled search as aborted", async () => {
    refreshPlacePool.mockRejectedValue(
      new DOMException("Aborted", "AbortError"),
    );

    const response = await POST(request(body()));
    const json = await response.json();

    expect(json.status).toBe("failed");
    expect(json.reason).toBe("aborted");
  });

  it("reports a pool that fails verification", async () => {
    refreshPlacePool.mockResolvedValue({
      ...unchangedOutcome(),
      pool: {
        ...FIXTURE_GENERATION.placePool,
        createdAt: "2026-08-20T09:00:00.000Z",
        places: [
          FIXTURE_PLACES.cafeOne,
          // The same canonical id twice: an identity failure, not a thin result.
          FIXTURE_PLACES.cafeOne,
        ],
      },
    });

    const response = await POST(request(body()));
    const json = await response.json();

    expect(json.status).toBe("failed");
    expect(json.reason).toBe("pool_invalid");
  });
});

describe("POST /api/trips/refresh-pool — budget", () => {
  /** Shorter than generation's on purpose: three paced searches and no model call. */
  it("allows less time than generation", () => {
    expect(maxDuration).toBe(60);
  });
});
