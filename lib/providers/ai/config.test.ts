import { describe, expect, it } from "vitest";

import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_OLLAMA_MODEL,
  describeAvailability,
  resolveAiConfig,
  resolveProviderId,
} from "./config";
import { createStructuredGenerator } from "./create-provider";

/**
 * Configuration is read from an injected environment rather than `process.env`, so
 * these run with no globals touched and no ordering between them.
 */
const EMPTY = {} as NodeJS.ProcessEnv;

function env(values: Record<string, string>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe("resolveAiConfig", () => {
  it("needs nothing — the production build runs with no AI variables at all", () => {
    const config = resolveAiConfig(EMPTY);

    expect(config.preference).toBe("auto");
    expect(config.gemini).toBeNull();
    expect(config.ollama).toBeNull();
    expect(resolveProviderId(config)).toBe("deterministic");
  });

  it("defaults the Gemini model when only a key is set", () => {
    const config = resolveAiConfig(env({ GEMINI_API_KEY: "test-key" }));

    expect(config.gemini?.model).toBe(DEFAULT_GEMINI_MODEL);
    expect(config.gemini?.baseUrl).toContain("generativelanguage");
  });

  it("defaults the Ollama model when only a base URL is set", () => {
    const config = resolveAiConfig(env({ OLLAMA_BASE_URL: "http://localhost:11434" }));

    expect(config.ollama?.model).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("strips a trailing slash from either base URL", () => {
    const config = resolveAiConfig(
      env({
        GEMINI_API_KEY: "k",
        GEMINI_BASE_URL: "http://127.0.0.1:9999/",
        OLLAMA_BASE_URL: "http://127.0.0.1:11434/",
      }),
    );

    expect(config.gemini?.baseUrl).toBe("http://127.0.0.1:9999");
    expect(config.ollama?.baseUrl).toBe("http://127.0.0.1:11434");
  });

  it("treats blank variables as absent rather than as empty configuration", () => {
    const config = resolveAiConfig(
      env({ GEMINI_API_KEY: "   ", OLLAMA_BASE_URL: "" }),
    );

    expect(config.gemini).toBeNull();
    expect(config.ollama).toBeNull();
  });

  it("falls back to auto for an unrecognised preference rather than throwing", () => {
    // A typo in a deployment variable must not take down a feature that has a
    // working keyless path.
    expect(resolveAiConfig(env({ ROAMLY_AI_PROVIDER: "claude" })).preference).toBe(
      "auto",
    );
  });

  it("accepts the four documented preferences, case-insensitively", () => {
    for (const value of ["auto", "GEMINI", "Ollama", "deterministic"]) {
      expect(resolveAiConfig(env({ ROAMLY_AI_PROVIDER: value })).preference).toBe(
        value.toLowerCase(),
      );
    }
  });
});

describe("resolveProviderId", () => {
  const withGemini = resolveAiConfig(env({ GEMINI_API_KEY: "k" }));
  const withOllama = resolveAiConfig(
    env({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" }),
  );
  const withBoth = resolveAiConfig(
    env({ GEMINI_API_KEY: "k", OLLAMA_BASE_URL: "http://127.0.0.1:11434" }),
  );

  it("prefers Gemini under auto when both are configured", () => {
    expect(resolveProviderId(withBoth)).toBe("gemini");
  });

  it("picks Ollama under auto when only Ollama is configured", () => {
    expect(resolveProviderId(withOllama)).toBe("ollama");
  });

  it("picks the deterministic planner under auto when neither is", () => {
    expect(resolveProviderId(resolveAiConfig(EMPTY))).toBe("deterministic");
  });

  /**
   * The rule the whole layer exists for: an explicit demand that cannot be met
   * reports so, rather than quietly producing template output behind an AI label.
   */
  it("refuses an explicit Gemini request with no key, rather than falling back", () => {
    expect(resolveProviderId(resolveAiConfig(EMPTY), "gemini")).toBeNull();
    expect(resolveProviderId(withOllama, "gemini")).toBeNull();
  });

  it("refuses an explicit Ollama request with no base URL", () => {
    expect(resolveProviderId(withGemini, "ollama")).toBeNull();
  });

  it("honours an explicit deterministic request even when a model is configured", () => {
    expect(resolveProviderId(withBoth, "deterministic")).toBe("deterministic");
  });

  it("lets a request override the configured default in both directions", () => {
    const preferOllama = resolveAiConfig(
      env({
        ROAMLY_AI_PROVIDER: "ollama",
        GEMINI_API_KEY: "k",
        OLLAMA_BASE_URL: "http://127.0.0.1:11434",
      }),
    );

    expect(resolveProviderId(preferOllama)).toBe("ollama");
    expect(resolveProviderId(preferOllama, "gemini")).toBe("gemini");
  });
});

describe("describeAvailability", () => {
  it("reports booleans and a label, and never a value", () => {
    const availability = describeAvailability(
      resolveAiConfig(
        env({ GEMINI_API_KEY: "super-secret", GEMINI_MODEL: "gemini-x" }),
      ),
    );

    expect(availability).toEqual({
      geminiConfigured: true,
      ollamaConfigured: false,
      resolvedProvider: "gemini",
      modelAvailable: true,
    });

    // Nothing in the payload leaks a key, a host or a model id.
    expect(JSON.stringify(availability)).not.toContain("super-secret");
    expect(JSON.stringify(availability)).not.toContain("gemini-x");
  });

  it("reports no model available on a bare deployment", () => {
    const availability = describeAvailability(resolveAiConfig(EMPTY));

    expect(availability.modelAvailable).toBe(false);
    expect(availability.resolvedProvider).toBe("deterministic");
  });
});

describe("createStructuredGenerator", () => {
  it("builds the deterministic planner with no configuration", () => {
    const selection = createStructuredGenerator({ config: resolveAiConfig(EMPTY) });

    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.generator.id).toBe("deterministic");
  });

  it("reports not_configured for an unmeetable explicit demand", () => {
    const selection = createStructuredGenerator({
      config: resolveAiConfig(EMPTY),
      preference: "gemini",
    });

    expect(selection).toEqual({ ok: false, reason: "not_configured" });
  });

  it("builds each adapter with the configured model as its label", () => {
    const gemini = createStructuredGenerator({
      config: resolveAiConfig(
        env({ GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-test" }),
      ),
    });
    const ollama = createStructuredGenerator({
      config: resolveAiConfig(
        env({ OLLAMA_BASE_URL: "http://127.0.0.1:11434", OLLAMA_MODEL: "llama-test" }),
      ),
    });

    expect(gemini.ok && gemini.generator.model).toBe("gemini-test");
    expect(ollama.ok && ollama.generator.model).toBe("llama-test");
  });

  it("makes no network request when selecting a provider", async () => {
    // Selection is a pure function of configuration, which is what lets the status
    // route answer instantly and stops `auto` costing a probe on every request.
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("selection must not fetch");
    }) as typeof fetch;

    try {
      createStructuredGenerator({
        config: resolveAiConfig(env({ OLLAMA_BASE_URL: "http://127.0.0.1:11434" })),
      });
      expect(called).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
