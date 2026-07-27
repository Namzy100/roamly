import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GenerateTripResponseSchema } from "@/lib/api/generate-contract";
import {
  FIXTURE_DESTINATION,
  FIXTURE_REQUEST,
} from "@/lib/generate/test-fixtures";
import { mockTripPlan } from "@/lib/mock/lisbon-trip";
import { routingPolicyForPace } from "@/lib/generate/pace-policy";
import { fixturePool } from "@/lib/generate/test-fixtures";
import {
  GENERATION_CONTEXT_SCHEMA_VERSION,
  type TripGenerationContext,
} from "@/lib/schemas";

import { POST, maxDuration } from "./route";

/**
 * The route boundary.
 *
 * The pipeline is mocked, because what is under test here is the *boundary*: the body
 * ceiling, the caps, the two delivery shapes, and — most importantly — that nothing
 * on the far side of it ever sees a prompt, a raw model response, or a provider
 * payload. That last property cannot be tested anywhere but here.
 */

const generateTripPlan = vi.hoisted(() => vi.fn());

vi.mock("@/lib/generate", async () => {
  const actual = await vi.importActual<typeof import("@/lib/generate")>(
    "@/lib/generate",
  );
  return { ...actual, generateTripPlan };
});

const GENERATION: TripGenerationContext = {
  schemaVersion: GENERATION_CONTEXT_SCHEMA_VERSION,
  provider: "gemini",
  model: "gemini-test",
  generatedAt: "2026-07-27T10:00:00.000Z",
  destination: FIXTURE_DESTINATION,
  placePool: fixturePool(),
  discoverySummary: {
    categoriesRequested: ["cafe", "museum", "restaurant"],
    categoriesWithNoResults: [],
    radiusMeters: 4_000,
    requestCount: 1,
    candidateCount: 7,
    discardedCount: 0,
    attribution: "© OpenStreetMap contributors (ODbL)",
  },
  warnings: [],
  routingPolicy: routingPolicyForPace("balanced"),
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    request: FIXTURE_REQUEST,
    destination: FIXTURE_DESTINATION,
    providerPreference: "auto",
    requestId: "req-abcdef123456",
    ...overrides,
  };
}

function post(payload: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/trips/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

/** Reads an SSE body into its frames, so the stream shape can be asserted. */
async function readStream(response: Response) {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const event = /event: (.+)/.exec(frame)?.[1] ?? "message";
      const data = /data: (.+)/.exec(frame)?.[1] ?? "null";
      return { event, data: JSON.parse(data) as unknown };
    });
}

beforeEach(() => {
  generateTripPlan.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/trips/generate — request validation", () => {
  it("declares an explicit duration budget", () => {
    // Not a promise that the work takes this long — the point at which the platform
    // stops waiting, above the pipeline's own 90 s budget.
    expect(maxDuration).toBe(120);
  });

  it("rejects a body over the ceiling before doing any work", async () => {
    const response = await POST(
      post(JSON.stringify(body({ padding: "x".repeat(20_000) }))),
    );

    expect(response.status).toBe(413);
    expect(generateTripPlan).not.toHaveBeenCalled();
  });

  it("rejects a malformed request with a field path and no echoed value", async () => {
    const response = await POST(post(body({ request: { destination: "Lisbon" } })));

    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_request");
    expect(generateTripPlan).not.toHaveBeenCalled();
  });

  it("rejects a destination whose coordinates are out of bounds", async () => {
    const response = await POST(
      post(
        body({
          destination: { ...FIXTURE_DESTINATION, latitude: 120 },
        }),
      ),
    );

    expect(response.status).toBe(400);
  });

  it("rejects non-JSON", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
  });

  it("rejects a trip longer than the day cap", async () => {
    const response = await POST(
      post(
        body({
          request: {
            ...FIXTURE_REQUEST,
            startDate: "2026-09-01",
            endDate: "2026-09-20",
          },
        }),
      ),
    );

    // `TripRequestSchema` refuses it first, which is the right layer — the route's own
    // cap is defence in depth for the provider budget.
    expect(response.status).toBe(400);
    expect(generateTripPlan).not.toHaveBeenCalled();
  });

  it("defaults the provider preference to auto", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    const { providerPreference: _dropped, ...withoutPreference } = body();
    await POST(post(withoutPreference));

    expect(generateTripPlan.mock.calls[0][0].providerPreference).toBe("auto");
  });

  it("assigns the trip id server-side", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    await POST(post(body({ tripId: "chosen-by-client" })));

    expect(generateTripPlan.mock.calls[0][0].tripId).not.toBe("chosen-by-client");
    expect(generateTripPlan.mock.calls[0][0].tripId).toHaveLength(10);
  });

  it("runs the pipeline exactly once per request", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    await POST(post(body()));

    expect(generateTripPlan).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/trips/generate — JSON delivery", () => {
  it("returns a complete plan and echoes the request id", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    const response = await POST(post(body()));
    const json: unknown = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const parsed = GenerateTripResponseSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== "success") return;
    expect(parsed.data.requestId).toBe("req-abcdef123456");
    expect(parsed.data.providerLabel).toBe("Gemini");
  });

  it("returns the exact pool alongside the plan", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    const json = (await (await POST(post(body()))).json()) as {
      generation: TripGenerationContext;
    };

    expect(json.generation.placePool.places).toHaveLength(7);
    expect(json.generation.placePool.poolId.startsWith("discovery:")).toBe(true);
  });

  it("returns a partial result as a 200 with warnings", async () => {
    generateTripPlan.mockResolvedValue({
      status: "partial",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [{ code: "slots_unfilled", message: "One stop was left open." }],
    });

    const response = await POST(post(body()));
    const parsed = GenerateTripResponseSchema.safeParse(await response.json());

    // A plan with visible gaps is a result, not an error.
    expect(response.status).toBe(200);
    expect(parsed.success && parsed.data.status).toBe("partial");
  });

  it("returns a refusal as a controlled 200 with a readable message", async () => {
    generateTripPlan.mockResolvedValue({
      status: "refused",
      userMessage: "The planner declined to plan this trip.",
    });

    const response = await POST(post(body()));
    const parsed = GenerateTripResponseSchema.safeParse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.success && parsed.data.status).toBe("refused");
  });

  it("returns a failure with our codes and no plan", async () => {
    generateTripPlan.mockResolvedValue({
      status: "failed",
      violations: [
        { code: "place_outside_pool", message: "osm:node:9 is not in the pool" },
      ],
      userMessage: "The itinerary did not pass verification, so nothing was saved.",
    });

    const json = (await (await POST(post(body()))).json()) as Record<string, unknown>;

    expect(json.status).toBe("failed");
    expect(json).not.toHaveProperty("plan");
    expect(json).not.toHaveProperty("generation");
  });

  it("returns an unavailable reason from the closed set", async () => {
    generateTripPlan.mockResolvedValue({
      status: "unavailable",
      reason: "not_configured",
      userMessage: "No AI planner is configured.",
    });

    const parsed = GenerateTripResponseSchema.safeParse(
      await (await POST(post(body()))).json(),
    );

    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.data.status !== "unavailable") return;
    expect(parsed.data.reason).toBe("not_configured");
  });

  it("converts an unexpected throw into a safe error, with no stack trace", async () => {
    generateTripPlan.mockRejectedValue(
      new Error("prompt was: You are the itinerary assembler…"),
    );

    const response = await POST(post(body()));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("prompt was");
    expect(text).not.toContain("assembler");
    expect(text).not.toContain("at Object");
  });
});

describe("POST /api/trips/generate — nothing leaks", () => {
  it("returns no prompt, model text, provider payload or secret", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    const text = await (await POST(post(body()))).text();

    // The system instructions, the raw Overpass envelope and any key material must
    // all be absent. `providerLabel` is a display string from a fixed table.
    expect(text).not.toMatch(/You are the (planning strategist|itinerary assembler)/);
    expect(text).not.toMatch(/systemInstruction|generationConfig|candidates\[/);
    expect(text).not.toMatch(/overpass|nominatim|generativelanguage|x-goog-api-key/i);
    expect(text).not.toMatch(/GEMINI_API_KEY|OLLAMA_BASE_URL/);
    expect(text).toContain("Gemini");
  });

  it("does not return the model id in the headline label", async () => {
    generateTripPlan.mockResolvedValue({
      status: "success",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [],
    });

    const json = (await (await POST(post(body()))).json()) as {
      providerLabel: string;
      generation: { model: string };
    };

    expect(json.providerLabel).toBe("Gemini");
    // Available for a details panel, not for a headline.
    expect(json.generation.model).toBe("gemini-test");
  });

  it("strips internal violation context, keeping code and message", async () => {
    generateTripPlan.mockResolvedValue({
      status: "failed",
      violations: [
        {
          code: "assembly_overlapping_items",
          message: "Two stops overlap on day 1.",
          dayNumber: 1,
          placeId: "osm:node:1001",
        },
      ],
      userMessage: "Nothing was saved.",
    });

    const json = (await (await POST(post(body()))).json()) as {
      violations: Record<string, unknown>[];
    };

    expect(json.violations[0]).toEqual({
      code: "assembly_overlapping_items",
      message: "Two stops overlap on day 1.",
    });
  });
});

describe("POST /api/trips/generate — streaming delivery", () => {
  it("streams real progress stages, then one result", async () => {
    generateTripPlan.mockImplementation(
      async (input: { onProgress?: (stage: string) => void }) => {
        input.onProgress?.("understanding");
        input.onProgress?.("discovering-places");
        input.onProgress?.("finalising");
        return {
          status: "success",
          plan: mockTripPlan,
          generation: GENERATION,
          warnings: [],
        };
      },
    );

    const response = await POST(post(body(), { Accept: "text/event-stream" }));

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-store");

    const frames = await readStream(response);
    expect(frames.map((frame) => frame.event)).toEqual([
      "progress",
      "progress",
      "progress",
      "result",
    ]);
    expect(frames[0].data).toEqual({ stage: "understanding" });
  });

  /**
   * The rule from ARCHITECTURE §14: the stream carries progress, never a partial
   * itinerary. A renderable half-plan is the failure this codebase is arranged to
   * prevent.
   */
  it("streams no part of the plan before the result", async () => {
    generateTripPlan.mockImplementation(
      async (input: { onProgress?: (stage: string) => void }) => {
        input.onProgress?.("building-days");
        return {
          status: "success",
          plan: mockTripPlan,
          generation: GENERATION,
          warnings: [],
        };
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
    generateTripPlan.mockRejectedValue(new Error("boom"));

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

  it("delivers a validated result over the stream, matching the JSON contract", async () => {
    generateTripPlan.mockResolvedValue({
      status: "partial",
      plan: mockTripPlan,
      generation: GENERATION,
      warnings: [{ code: "slots_unfilled", message: "One stop was left open." }],
    });

    const frames = await readStream(
      await POST(post(body(), { Accept: "text/event-stream" })),
    );

    const parsed = GenerateTripResponseSchema.safeParse(frames.at(-1)?.data);
    expect(parsed.success).toBe(true);
  });

  it("passes the caller's abort signal to the pipeline", async () => {
    generateTripPlan.mockResolvedValue({
      status: "unavailable",
      reason: "aborted",
      userMessage: "Cancelled.",
    });

    await POST(post(body(), { Accept: "text/event-stream" }));

    expect(generateTripPlan.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });
});
