import { describe, expect, it } from "vitest";

import { parseModelJson } from "./parse";

/**
 * The two accommodations, and the long list of things that are *not* accommodated.
 * Every "rejects" case below is output that could plausibly be salvaged by a
 * cleverer parser, and salvaging it is exactly the wrong move — a half-parsed
 * itinerary is indistinguishable from a complete one downstream.
 */
describe("parseModelJson", () => {
  it("parses a plain object", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });

  it("unwraps a fenced block", () => {
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });

  it("trims prose a smaller model put around the object", () => {
    const result = parseModelJson(
      'Here is your itinerary:\n{"title":"Two days"}\nHope that helps!',
    );

    expect(result).toEqual({ ok: true, value: { title: "Two days" } });
  });

  it("is not fooled by braces inside a string", () => {
    const result = parseModelJson(
      '{"summary":"the square (bracketed by cafés) } and a note","ok":true}',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      summary: "the square (bracketed by cafés) } and a note",
      ok: true,
    });
  });

  it("is not fooled by an escaped quote before a brace", () => {
    const result = parseModelJson('{"name":"Zé \\"dos\\" Cornos }","n":1}');

    expect(result.ok).toBe(true);
  });

  it("reports empty content as empty rather than malformed", () => {
    // The distinction matters: one is a provider quirk, the other a contract
    // problem, and they read differently to a traveller.
    expect(parseModelJson("")).toMatchObject({ reason: "empty_response" });
    expect(parseModelJson("   \n ")).toMatchObject({ reason: "empty_response" });
    expect(parseModelJson(undefined)).toMatchObject({ reason: "empty_response" });
    expect(parseModelJson(null)).toMatchObject({ reason: "empty_response" });
  });

  it("rejects truncated output instead of salvaging a prefix", () => {
    const result = parseModelJson('{"days":[{"dayNumber":1,"items":[{"title":"Ca');

    expect(result).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it("rejects a JSON array at the top level", () => {
    expect(parseModelJson("[1,2,3]")).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("rejects prose with no object in it", () => {
    expect(parseModelJson("I cannot help with that request.")).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("does not repair a trailing comma", () => {
    expect(parseModelJson('{"a":1,}')).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("does not repair single quotes", () => {
    expect(parseModelJson("{'a':1}")).toMatchObject({
      ok: false,
      reason: "invalid_response",
    });
  });

  it("rejects a bare JSON scalar", () => {
    expect(parseModelJson("42")).toMatchObject({ ok: false });
    expect(parseModelJson('"a string"')).toMatchObject({ ok: false });
  });
});
