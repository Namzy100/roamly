import { afterEach, describe, expect, it, vi } from "vitest";

import { logOperation, timed } from "./log";

/**
 * The logging tests are privacy tests.
 *
 * There is nothing interesting about whether `console.log` was called. What matters is that a caller
 * who passes travel data cannot get it into a log line — because that is the mistake a future edit will
 * actually make, and a server log on a hosting platform is readable and retained.
 */

const lines: string[] = [];

function capture() {
  return vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
}

afterEach(() => {
  lines.length = 0;
  vi.restoreAllMocks();
});

describe("logOperation", () => {
  it("writes one machine-readable line", () => {
    capture();
    logOperation({ operation: "discover", provider: "places", result: "ok", durationMs: 412 });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toMatchObject({
      operation: "discover",
      provider: "places",
      result: "ok",
      durationMs: 412,
    });
    expect(typeof parsed.at).toBe("string");
  });

  /**
   * The allowlist doing its job. A caller who passes a destination gets a log line *without* it, rather
   * than a leak — which is the whole reason the filter is a list of permitted keys and not a list of
   * forbidden ones.
   */
  it("drops anything not on the allowlist, including travel data", () => {
    capture();
    logOperation({
      operation: "generate",
      result: "ok",
      durationMs: 900,
      // Every one of these is something a hurried future edit might pass.
      destination: "Lisbon",
      placeIds: ["osm:node:1001"],
      prompt: "You are an itinerary assembler",
      notes: "First time in Portugal",
      apiKey: "secret",
    } as never);

    const parsed = JSON.parse(lines[0]);
    for (const forbidden of ["destination", "placeIds", "prompt", "notes", "apiKey"]) {
      expect(Object.keys(parsed), forbidden).not.toContain(forbidden);
    }
    expect(parsed.operation).toBe("generate");
  });

  it("omits absent optional fields rather than logging undefined", () => {
    capture();
    logOperation({ operation: "route", result: "ok", durationMs: 10 });

    const parsed = JSON.parse(lines[0]);
    expect(Object.keys(parsed).sort()).toEqual(["at", "durationMs", "operation", "result"]);
  });

  it("rounds the duration", () => {
    capture();
    logOperation({ operation: "x", result: "ok", durationMs: 12.987 });
    expect(JSON.parse(lines[0]).durationMs).toBe(13);
  });
});

describe("timed", () => {
  it("logs the result of a successful operation once", async () => {
    capture();
    const value = await timed({ operation: "discover", provider: "places" }, async () => ({
      value: 42,
      result: "partial" as const,
      partial: true,
    }));

    expect(value).toBe(42);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ result: "partial", partial: true });
  });

  /** A provider message can name a host, so only the error's class reaches the log. */
  it("logs a failure without the error's message", async () => {
    capture();

    await expect(
      timed({ operation: "discover", provider: "places" }, async () => {
        throw new Error("connect ECONNREFUSED overpass-api.de:443");
      }),
    ).rejects.toThrow();

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).not.toContain("overpass");
    expect(line).not.toContain("ECONNREFUSED");
    expect(JSON.parse(line)).toMatchObject({ result: "unavailable", errorCode: "Error" });
  });

  it("distinguishes a cancelled operation from an unavailable one", async () => {
    capture();

    await expect(
      timed({ operation: "generate" }, async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    ).rejects.toThrow();

    expect(JSON.parse(lines[0]).result).toBe("aborted");
  });

  it("re-throws, so logging never swallows a failure", async () => {
    capture();
    const boom = new Error("boom");

    await expect(
      timed({ operation: "x" }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
