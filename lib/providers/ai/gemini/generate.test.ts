import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createGeminiGenerator } from "./generate";

/**
 * Gemini normalisation, against hand-built envelopes.
 *
 * **No live call is made anywhere in this file.** `fetch` is replaced per test, so
 * the suite runs offline, needs no key, and can construct the three response shapes
 * that matter — including the two that arrive as HTTP 200 and would crash a naive
 * client.
 *
 * `console.error` is silenced because the adapter deliberately logs every failure
 * server-side; a suite that exercises fifteen failure paths should not print fifteen
 * stack traces.
 */

const SCHEMA = z.object({ title: z.string() });

const CONFIG = {
  apiKey: "test-key",
  model: "gemini-test",
  baseUrl: "https://gemini.test",
};

function request() {
  return {
    operation: "strategy" as const,
    systemInstruction: "You are a planner.",
    input: { destinationName: "Lisbon" },
    outputSchema: SCHEMA,
    schemaName: "Thing",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

function candidate(text: string, finishReason = "STOP") {
  return {
    candidates: [{ finishReason, content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40 },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Gemini adapter — the happy path", () => {
  it("returns the parsed object with provider, model and usage", async () => {
    fetchMock.mockResolvedValue(jsonResponse(candidate('{"title":"Two days"}')));

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result).toEqual({
      status: "success",
      value: { title: "Two days" },
      provider: "gemini",
      model: "gemini-test",
      usage: { inputTokens: 120, outputTokens: 40 },
    });
  });

  it("returns the raw object without applying the output schema", async () => {
    // Validation is deliberately downstream, so the prohibited-field scan can see
    // keys Zod would strip. See `StructuredGenerator` in lib/ai/types.ts.
    fetchMock.mockResolvedValue(
      jsonResponse(candidate('{"title":"Two days","rating":4.6}')),
    );

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.value).toHaveProperty("rating", 4.6);
  });

  it("sends the key as a header and never in the URL", async () => {
    fetchMock.mockResolvedValue(jsonResponse(candidate('{"title":"x"}')));

    await createGeminiGenerator(CONFIG).generate(request());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "test-key",
    );
  });

  it("asks for JSON and a deterministic temperature", async () => {
    fetchMock.mockResolvedValue(jsonResponse(candidate('{"title":"x"}')));

    await createGeminiGenerator(CONFIG).generate(request());

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.temperature).toBe(0);
    // The instruction is passed through byte-for-byte, which is what a provider's
    // prompt cache needs and what makes the prompt reviewable in one place.
    expect(body.systemInstruction.parts[0].text).toBe(request().systemInstruction);
  });

  it("puts the input and the schema in the user turn", async () => {
    fetchMock.mockResolvedValue(jsonResponse(candidate('{"title":"x"}')));

    await createGeminiGenerator(CONFIG).generate(request());

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const userTurn: string = body.contents[0].parts[0].text;

    expect(userTurn).toContain("Lisbon");
    // The contract is restated immediately before the answer: a long candidate list
    // between instruction and output measurably increases drift, and this is the
    // cheap correction. The schema also carries no dialect declaration or $ref.
    expect(userTurn).toContain('"title"');
    expect(userTurn).not.toContain("$schema");
    expect(userTurn).not.toContain("$ref");
  });

  it("does not send a provider-side response schema", async () => {
    // A rejected schema is a hard 400 that would take the feature down for everyone
    // on that model. The prompt-embedded contract degrades instead, and our own
    // validator is the authority either way.
    fetchMock.mockResolvedValue(jsonResponse(candidate('{"title":"x"}')));

    await createGeminiGenerator(CONFIG).generate(request());

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(body.generationConfig.responseSchema).toBeUndefined();
  });

  it("joins multi-part content", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [
          {
            finishReason: "STOP",
            content: { parts: [{ text: '{"title":' }, { text: '"split"}' }] },
          },
        ],
      }),
    );

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(result.value).toEqual({ title: "split" });
  });

  it("omits usage entirely when the provider did not report it", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{}" }] } }],
      }),
    );

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    // A zero would be a fabricated fact about our own usage.
    expect(result.usage).toBeUndefined();
  });
});

describe("Gemini adapter — refusal and empty content", () => {
  /**
   * The crash this test exists to prevent: a prompt-level block returns 200 with
   * **no `candidates` key at all**, so `candidates[0].content` throws.
   */
  it("reports a prompt-level block as a refusal without indexing into candidates", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ promptFeedback: { blockReason: "SAFETY" } }),
    );

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result.status).toBe("refused");
    if (result.status !== "refused") return;
    // Nothing about the provider or the reason code reaches the traveller.
    expect(result.userMessage).not.toContain("SAFETY");
    expect(result.userMessage).not.toContain("Gemini");
  });

  it("reports a candidate-level safety stop as a refusal", async () => {
    for (const reason of ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "RECITATION"]) {
      fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ finishReason: reason }] }));

      const result = await createGeminiGenerator(CONFIG).generate(request());
      expect(result.status, reason).toBe("refused");
    }
  });

  it("reports an absent candidate list as empty content", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [] }));

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result).toMatchObject({ status: "unavailable", reason: "empty_response" });
  });

  it("reports a candidate with no content as empty content", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ candidates: [{ finishReason: "STOP" }] }));

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result).toMatchObject({ status: "unavailable", reason: "empty_response" });
  });

  it("treats truncation as invalid rather than salvaging a prefix", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(candidate('{"title":"Two da', "MAX_TOKENS")),
    );

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid_response",
    });
  });

  it("treats an unfamiliar finish reason as normal and lets the parser decide", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(candidate('{"title":"ok"}', "SOMETHING_NEW")),
    );

    expect((await createGeminiGenerator(CONFIG).generate(request())).status).toBe(
      "success",
    );
  });
});

describe("Gemini adapter — transport failures", () => {
  it("maps 429 to rate_limited and explains free-tier caps", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: {} }, 429));

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result).toMatchObject({ status: "unavailable", reason: "rate_limited" });
    if (result.status !== "unavailable") return;
    expect(result.userMessage).toContain("rate limited");
  });

  it("maps 401 and 403 to not_configured", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValue(jsonResponse({ error: {} }, status));

      const result = await createGeminiGenerator(CONFIG).generate(request());
      expect(result, String(status)).toMatchObject({ reason: "not_configured" });
    }
  });

  it("maps 5xx to provider_unavailable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: {} }, 503));

    expect(await createGeminiGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "provider_unavailable",
    });
  });

  it("maps 400 to invalid_response, because a 400 is our request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: {} }, 400));

    expect(await createGeminiGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "invalid_response",
    });
  });

  it("reports an HTML body as the provider being unreachable", async () => {
    fetchMock.mockResolvedValue(textResponse("<html><body>Proxy error</body></html>"));

    expect(await createGeminiGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "provider_unavailable",
    });
  });

  it("reports an unparseable envelope as invalid", async () => {
    fetchMock.mockResolvedValue(
      new Response("not json at all", { status: 200 }),
    );

    expect(await createGeminiGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "invalid_response",
    });
  });

  it("reports an empty body as empty", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    expect(await createGeminiGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "empty_response",
    });
  });

  it("reports a network failure as the provider being unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    expect(await createGeminiGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "provider_unavailable",
    });
  });

  it("distinguishes a caller abort from a timeout", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const pending = createGeminiGenerator(CONFIG).generate({
      ...request(),
      signal: controller.signal,
    });
    controller.abort();

    expect(await pending).toMatchObject({
      status: "unavailable",
      reason: "aborted",
    });
  });

  it("reports its own timeout as a timeout", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason ?? new Error("aborted")),
          );
        }),
    );

    try {
      const pending = createGeminiGenerator(CONFIG).generate(request());
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await pending).toMatchObject({
        status: "unavailable",
        reason: "timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never leaks a provider hostname or body into the user message", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { message: "API key not valid for gemini.test" } }, 500),
    );

    const result = await createGeminiGenerator(CONFIG).generate(request());

    expect(result.status).toBe("unavailable");
    if (result.status !== "unavailable") return;
    expect(result.userMessage).not.toMatch(/gemini|api key|500/i);
  });
});
