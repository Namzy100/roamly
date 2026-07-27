import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createOllamaGenerator } from "./generate";

/**
 * Ollama normalisation. No live call, no running server, no model pulled.
 *
 * The two cases worth the file on their own: a `format` schema that a grammar
 * compiler can actually accept, and a 200 carrying an `error` string — which is what
 * a correctly-configured URL with the wrong model name returns, and the single most
 * likely real-world failure here.
 */

const SCHEMA = z.object({
  title: z.string(),
  item: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("a"), a: z.number() }),
    z.object({ kind: z.literal("b"), b: z.string() }),
  ]),
});

const CONFIG = { baseUrl: "http://127.0.0.1:11434", model: "test-model" };

function request(operation: "strategy" | "assembly" = "strategy") {
  return {
    operation,
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

describe("Ollama adapter — the happy path", () => {
  it("returns the parsed message content", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        done: true,
        message: { role: "assistant", content: '{"title":"Two days"}' },
        prompt_eval_count: 900,
        eval_count: 300,
      }),
    );

    const result = await createOllamaGenerator(CONFIG).generate(request());

    expect(result).toEqual({
      status: "success",
      value: { title: "Two days" },
      provider: "ollama",
      model: "test-model",
      usage: { inputTokens: 900, outputTokens: 300 },
    });
  });

  it("posts to /api/chat, non-streaming, at temperature zero", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: { content: '{"title":"x"}' } }),
    );

    await createOllamaGenerator(CONFIG).generate(request());

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:11434/api/chat");

    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.model).toBe("test-model");
    expect(body.options.temperature).toBe(0);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a planner.",
    });
  });

  /**
   * The schema *is* sent here, unlike the Gemini adapter, because Ollama compiles it
   * to a sampling grammar — which is the difference between an 8B model producing
   * valid JSON and producing something close to it.
   */
  it("sends the output schema as `format`, in grammar-friendly form", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: { content: '{"title":"x"}' } }),
    );

    await createOllamaGenerator(CONFIG).generate(request());

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const format = JSON.stringify(body.format);

    expect(body.format.type).toBe("object");
    // No pointer resolution and no `oneOf`: the grammar compiler handles neither
    // reliably, and `json-schema.ts` rewrites for exactly this consumer.
    expect(format).not.toContain("$ref");
    expect(format).not.toContain("$defs");
    expect(format).not.toContain("oneOf");
    expect(format).toContain("anyOf");
    expect(format).not.toContain("$schema");
  });

  it("asks for a context large enough to hold the candidate list", async () => {
    // The default 2048-token window would truncate the candidates, producing a model
    // that references places it can no longer see — which would look like
    // fabrication and would not be.
    fetchMock.mockResolvedValue(
      jsonResponse({ message: { content: '{"title":"x"}' } }),
    );

    await createOllamaGenerator(CONFIG).generate(request("assembly"));

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(32_768);
  });

  it("ignores a thinking trace entirely", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: {
          content: '{"title":"answer"}',
          thinking: "Let me consider inventing a restaurant…",
        },
      }),
    );

    const result = await createOllamaGenerator(CONFIG).generate(request());

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(JSON.stringify(result.value)).not.toContain("inventing");
  });

  it("makes no request before the first generate call", () => {
    // No availability probe: a speculative request on a path chosen for being
    // offline is the wrong trade.
    createOllamaGenerator(CONFIG);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Ollama adapter — failures", () => {
  it("reports a 200 carrying an error string as unavailable", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "model 'test-model' not found, try pulling it first" }),
    );

    const result = await createOllamaGenerator(CONFIG).generate(request());

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "provider_unavailable",
    });
    if (result.status !== "unavailable") return;
    // The operator can fix this from the server log; the traveller sees no model name.
    expect(result.userMessage).not.toContain("test-model");
  });

  it("reports empty content as empty rather than malformed", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: "" } }));

    expect(await createOllamaGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "empty_response",
    });
  });

  it("reports a missing message as empty content", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ done: true }));

    expect(await createOllamaGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "empty_response",
    });
  });

  it("reports malformed content as invalid", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ message: { content: '{"title": "unterminated' } }),
    );

    expect(await createOllamaGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "invalid_response",
    });
  });

  it("reports a stopped server as unreachable", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const result = await createOllamaGenerator(CONFIG).generate(request());

    expect(result).toMatchObject({ reason: "provider_unavailable" });
  });

  it("maps 404 to invalid_response and 5xx to provider_unavailable", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 404));
    expect(await createOllamaGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "invalid_response",
    });

    fetchMock.mockResolvedValue(jsonResponse({}, 500));
    expect(await createOllamaGenerator(CONFIG).generate(request())).toMatchObject({
      reason: "provider_unavailable",
    });
  });

  it("honours a caller abort", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );

    const pending = createOllamaGenerator(CONFIG).generate({
      ...request(),
      signal: controller.signal,
    });
    controller.abort();

    expect(await pending).toMatchObject({ reason: "aborted" });
  });

  it("tolerates extra fields a newer Ollama adds", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        message: { content: '{"title":"x"}', images: null },
        total_duration: 123,
        some_future_field: true,
      }),
    );

    expect((await createOllamaGenerator(CONFIG).generate(request())).status).toBe(
      "success",
    );
  });
});
