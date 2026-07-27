import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AiStatusResponseSchema } from "@/lib/api/generate-contract";

import { GET } from "./route";

/**
 * The status route reads `process.env` through `resolveAiConfig`, so these tests
 * set and restore it rather than injecting — which is also the only way to check
 * that the real deployment path does not leak a key.
 */
const ORIGINAL = { ...process.env };

beforeEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.OLLAMA_MODEL;
  delete process.env.ROAMLY_AI_PROVIDER;
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("GET /api/ai/status", () => {
  it("reports demo-only on a bare deployment", async () => {
    const response = await GET();
    const parsed = AiStatusResponseSchema.safeParse(await response.json());

    expect(response.status).toBe(200);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data).toEqual({
      geminiConfigured: false,
      ollamaConfigured: false,
      resolvedProvider: "deterministic",
      modelAvailable: false,
      providerLabel: "Demo Planner",
    });
  });

  it("reports Gemini when a key is configured", async () => {
    process.env.GEMINI_API_KEY = "test-key";

    const json = (await (await GET()).json()) as Record<string, unknown>;

    expect(json.modelAvailable).toBe(true);
    expect(json.providerLabel).toBe("Gemini");
  });

  it("reports Ollama when only a base URL is configured", async () => {
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";

    const json = (await (await GET()).json()) as Record<string, unknown>;

    expect(json.resolvedProvider).toBe("ollama");
    expect(json.providerLabel).toBe("Ollama");
  });

  it("honours a configured preference for the demo planner", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    process.env.ROAMLY_AI_PROVIDER = "deterministic";

    const json = (await (await GET()).json()) as Record<string, unknown>;

    expect(json.geminiConfigured).toBe(true);
    // Configured but not selected: the interface must not offer what will not run.
    expect(json.modelAvailable).toBe(false);
  });

  /**
   * "Gemini is configured" is not a secret — the enabled button says as much. A key,
   * a host and a model id are deployment details with no business in a browser.
   */
  it("leaks no key, host or model id", async () => {
    process.env.GEMINI_API_KEY = "super-secret-key";
    process.env.GEMINI_MODEL = "gemini-internal-preview";
    process.env.OLLAMA_BASE_URL = "http://10.0.0.7:11434";

    const text = await (await GET()).text();

    expect(text).not.toContain("super-secret-key");
    expect(text).not.toContain("gemini-internal-preview");
    expect(text).not.toContain("10.0.0.7");
    expect(text).not.toContain("11434");
  });

  it("is never cached, so adding a key takes effect immediately", async () => {
    expect((await GET()).headers.get("cache-control")).toBe("no-store");
  });

  it("makes no provider request", async () => {
    // A probe would let a browser find out whether someone's local Ollama is running.
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:11434";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the status route must not fetch");
    }) as typeof fetch;

    try {
      expect((await GET()).status).toBe(200);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
