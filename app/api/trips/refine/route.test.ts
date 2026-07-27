import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RefineTripResponseSchema } from "@/lib/api/refine-contract";
import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { MAX_PERSISTED_POOL_PLACES } from "@/lib/schemas/generation";
import type { TripRefinementResult } from "@/lib/refinement";

import { POST, maxDuration } from "./route";

/**
 * The refinement route boundary.
 *
 * The pipeline is mocked, because what is under test is the *boundary*: the body
 * ceiling, the caps, the two delivery shapes, and — the property that cannot be tested
 * anywhere else — that nothing on the far side ever sees a prompt, a raw model
 * response, or a provider payload.
 */

const refineTrip = vi.hoisted(() => vi.fn());

vi.mock("@/lib/refinement", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/refinement")>("@/lib/refinement");
  return { ...actual, refineTrip };
});

const PLAN = fixtureSavedPlan();

const SUMMARY = {
  action: "replace-item" as const,
  changedItemIds: [],
  addedItemIds: ["cafe-one-r1"],
  removedItemIds: ["cafe-one"],
  preservedItemIds: [],
  invalidatedLegIds: ["day:1:from:cafe-one:to:museum-one:mode:drive"],
  affectedDays: [1],
  previousEstimatedTotal: 1_000,
  newEstimatedTotal: 990,
  revisionBefore: 3,
};

const SUCCESS: TripRefinementResult = {
  status: "success",
  plan: PLAN,
  generationContext: FIXTURE_GENERATION,
  summary: SUMMARY,
  warnings: [],
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    plan: PLAN,
    generation: FIXTURE_GENERATION,
    command: {
      type: "replace-item",
      dayNumber: 1,
      itemId: PLAN.days[0].items[0].id,
    },
    providerPreference: "auto",
    expectedRevision: 3,
    requestId: "req-abcdef123456",
    ...overrides,
  };
}

function post(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/trips/refine", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function readStream(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => ({
      event: /event: (.+)/.exec(frame)?.[1] ?? "message",
      data: JSON.parse(/data: (.+)/.exec(frame)?.[1] ?? "null") as unknown,
    }));
}

beforeEach(() => {
  refineTrip.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/trips/refine — request validation", () => {
  it("declares a duration budget shorter than generation's", () => {
    // One small model call, and a traveller waiting on an edit has less patience than
    // one waiting on a whole trip.
    expect(maxDuration).toBe(90);
  });

  it("rejects an oversized body before doing any work", async () => {
    const response = await POST(
      post(JSON.stringify(body({ padding: "x".repeat(600_000) }))),
    );

    expect(response.status).toBe(413);
    expect(refineTrip).not.toHaveBeenCalled();
  });

  it("rejects a command outside the vocabulary", async () => {
    const response = await POST(
      post(body({ command: { type: "rewrite-everything" } })),
    );

    expect(response.status).toBe(400);
    expect(refineTrip).not.toHaveBeenCalled();
  });

  /**
   * Route retry belongs to the routing endpoint, which owns the routing provider and
   * its duration budget. This route accepting it would blur that boundary.
   */
  it("rejects retry-routes", async () => {
    const response = await POST(
      post(body({ command: { type: "retry-routes", scope: "all" } })),
    );

    expect(response.status).toBe(400);
    expect(refineTrip).not.toHaveBeenCalled();
  });

  it("requires a generation context, because a refinement needs the pool", async () => {
    const { generation: _dropped, ...withoutGeneration } = body();

    const response = await POST(post(withoutGeneration));

    expect(response.status).toBe(400);
    expect(refineTrip).not.toHaveBeenCalled();
  });

  it("rejects a day the trip does not have, before any model call", async () => {
    const response = await POST(
      post(
        body({
          command: { type: "adjust-day", dayNumber: 7, adjustment: "cheaper" },
        }),
      ),
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: { code: string } };
    expect(json.error.code).toBe("unknown_day");
    expect(refineTrip).not.toHaveBeenCalled();
  });

  it("rejects a pool larger than the stored ceiling", async () => {
    const oversized = Array.from(
      { length: MAX_PERSISTED_POOL_PLACES + 1 },
      (_, index) => ({
        ...FIXTURE_GENERATION.placePool.places[0],
        placeId: `osm:node:${70_000 + index}`,
        source: {
          ...FIXTURE_GENERATION.placePool.places[0].source,
          canonicalId: `osm:node:${70_000 + index}`,
          osmId: String(70_000 + index),
        },
      }),
    );

    const response = await POST(
      post(
        body({
          generation: {
            ...FIXTURE_GENERATION,
            placePool: {
              ...FIXTURE_GENERATION.placePool,
              places: oversized,
            },
          },
        }),
      ),
    );

    // The context schema's own bound fires first, which is the right layer.
    expect(response.status).toBe(400);
  });

  it("rejects non-JSON", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
  });

  it("runs the pipeline exactly once per request", async () => {
    refineTrip.mockResolvedValue(SUCCESS);

    await POST(post(body()));

    expect(refineTrip).toHaveBeenCalledTimes(1);
  });

  it("passes the revision through as the token the client compares", async () => {
    refineTrip.mockResolvedValue(SUCCESS);

    const response = await POST(post(body({ expectedRevision: 9 })));
    const json = (await response.json()) as { expectedRevision: number };

    expect(refineTrip.mock.calls[0][0].revisionBefore).toBe(9);
    expect(json.expectedRevision).toBe(9);
  });
});

describe("POST /api/trips/refine — JSON delivery", () => {
  it("returns the replacement plan, context and summary", async () => {
    refineTrip.mockResolvedValue(SUCCESS);

    const response = await POST(post(body()));
    const parsed = RefineTripResponseSchema.safeParse(await response.json());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== "success") return;

    expect(parsed.data.requestId).toBe("req-abcdef123456");
    expect(parsed.data.summary.invalidatedLegIds).toHaveLength(1);
    expect(parsed.data.generationContext.placePool.places.length).toBeGreaterThan(0);
  });

  it("returns a partial result as a 200 with warnings", async () => {
    refineTrip.mockResolvedValue({
      status: "partial",
      plan: PLAN,
      generationContext: FIXTURE_GENERATION,
      summary: SUMMARY,
      warnings: [{ code: "cost_clamped", message: "An estimate was adjusted." }],
    } satisfies TripRefinementResult);

    const response = await POST(post(body()));
    const parsed = RefineTripResponseSchema.safeParse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.success && parsed.data.status).toBe("partial");
  });

  it("returns a refusal without a plan", async () => {
    refineTrip.mockResolvedValue({
      status: "refused",
      userMessage: "The planner declined to make that change.",
    } satisfies TripRefinementResult);

    const json = (await (await POST(post(body()))).json()) as Record<string, unknown>;

    expect(json.status).toBe("refused");
    expect(json).not.toHaveProperty("plan");
  });

  it("returns not_configured without a plan", async () => {
    refineTrip.mockResolvedValue({
      status: "unavailable",
      reason: "not_configured",
      userMessage: "No AI planner is configured here.",
    } satisfies TripRefinementResult);

    const parsed = RefineTripResponseSchema.safeParse(
      await (await POST(post(body()))).json(),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== "unavailable") return;
    expect(parsed.data.reason).toBe("not_configured");
  });

  /**
   * The rollback guarantee, at the boundary: a rejected refinement returns no plan, so
   * there is nothing the client could save even by mistake.
   */
  it("returns no plan on failure", async () => {
    refineTrip.mockResolvedValue({
      status: "failed",
      errors: [
        {
          code: "place_outside_pool",
          message: "osm:node:9 was not offered.",
          dayNumber: 1,
          itemId: "cafe-one",
          placeId: "osm:node:9",
        },
      ],
      userMessage: "That change did not pass verification, so nothing was saved.",
    } satisfies TripRefinementResult);

    const json = (await (await POST(post(body()))).json()) as {
      status: string;
      errors: Record<string, unknown>[];
    };

    expect(json.status).toBe("failed");
    expect(json).not.toHaveProperty("plan");
    expect(json).not.toHaveProperty("generationContext");
    // `dayNumber` and `itemId` survive so the UI can point at the card; the internal
    // `placeId` context does not.
    expect(json.errors[0]).toEqual({
      code: "place_outside_pool",
      message: "osm:node:9 was not offered.",
      dayNumber: 1,
      itemId: "cafe-one",
    });
  });

  it("converts an unexpected throw into a safe error with no prompt or stack", async () => {
    refineTrip.mockRejectedValue(
      new Error("prompt was: You are refining a saved travel itinerary…"),
    );

    const response = await POST(post(body()));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("prompt was");
    expect(text).not.toContain("refining a saved");
    expect(text).not.toContain("at Object");
  });
});

describe("POST /api/trips/refine — nothing leaks", () => {
  it("returns no prompt, model text, provider payload or secret", async () => {
    refineTrip.mockResolvedValue(SUCCESS);

    const text = await (await POST(post(body()))).text();

    expect(text).not.toMatch(/You are refining a saved travel itinerary/);
    expect(text).not.toMatch(/systemInstruction|generationConfig|candidates\[/);
    expect(text).not.toMatch(/generativelanguage|x-goog-api-key|overpass/i);
    expect(text).not.toMatch(/GEMINI_API_KEY|OLLAMA_BASE_URL/);
  });
});

describe("POST /api/trips/refine — streaming delivery", () => {
  it("streams the refinement stages, then one result", async () => {
    refineTrip.mockImplementation(
      async (input: { onProgress?: (stage: string) => void }) => {
        input.onProgress?.("reviewing");
        input.onProgress?.("finding-alternatives");
        input.onProgress?.("finalising");
        return SUCCESS;
      },
    );

    const response = await POST(post(body(), { Accept: "text/event-stream" }));

    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const frames = await readStream(response);
    expect(frames.map((frame) => frame.event)).toEqual([
      "progress",
      "progress",
      "progress",
      "result",
    ]);
    expect(frames[0].data).toEqual({ stage: "reviewing" });
  });

  it("streams no part of the plan before the result", async () => {
    refineTrip.mockImplementation(
      async (input: { onProgress?: (stage: string) => void }) => {
        input.onProgress?.("rebuilding");
        return SUCCESS;
      },
    );

    const frames = await readStream(
      await POST(post(body(), { Accept: "text/event-stream" })),
    );

    for (const frame of frames.slice(0, -1)) {
      expect(Object.keys(frame.data as object)).toEqual(["stage"]);
    }
    expect(frames.at(-1)?.event).toBe("result");
  });

  it("always ends with a result, even when the pipeline throws", async () => {
    refineTrip.mockRejectedValue(new Error("boom"));

    const frames = await readStream(
      await POST(post(body(), { Accept: "text/event-stream" })),
    );

    // A stream that closed without one would leave the browser waiting forever.
    expect(frames.at(-1)?.event).toBe("result");
    expect(frames.at(-1)?.data).toMatchObject({
      status: "unavailable",
      requestId: "req-abcdef123456",
    });
  });

  it("passes the caller's abort signal through", async () => {
    refineTrip.mockResolvedValue(SUCCESS);

    await POST(post(body(), { Accept: "text/event-stream" }));

    expect(refineTrip.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
});
