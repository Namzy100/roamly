import { describe, expect, it, vi } from "vitest";

import { mapWithConcurrency } from "./concurrency";

/**
 * The batching guarantees, in isolation from anything network-shaped.
 *
 * Three properties matter and each has a failure mode that only shows up under
 * load: the ceiling (or we hammer a donated server), the ordering (or a leg's
 * result is attached to the wrong leg), and the deduplication (or a hotel
 * departed from and returned to costs two requests).
 */

/** A deferred promise, so a test can control exactly when a task finishes. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("mapWithConcurrency", () => {
  it("returns an empty array for no items", async () => {
    const task = vi.fn();
    expect(await mapWithConcurrency([], task, { limit: 3 })).toEqual([]);
    expect(task).not.toHaveBeenCalled();
  });

  it("never exceeds the concurrency ceiling", async () => {
    let active = 0;
    let peak = 0;

    const results = await mapWithConcurrency(
      Array.from({ length: 12 }, (_, index) => index),
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return item * 2;
      },
      { limit: 3 },
    );

    expect(peak).toBe(3);
    expect(results).toHaveLength(12);
  });

  it("preserves input order regardless of completion order", async () => {
    const results = await mapWithConcurrency(
      [30, 5, 20, 1],
      async (delay) => {
        await new Promise((resolve) => setTimeout(resolve, delay));
        return delay;
      },
      { limit: 4 },
    );

    // Completion order would be 1, 5, 20, 30. Input order is what comes back.
    expect(results).toEqual([30, 5, 20, 1]);
  });

  it("issues one request for duplicate keys and shares the result", async () => {
    const task = vi.fn(async (item: string) => `routed:${item}`);

    const results = await mapWithConcurrency(
      ["a", "b", "a", "a", "b"],
      task,
      { limit: 3, keyOf: (item) => item },
    );

    expect(task).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      "routed:a",
      "routed:b",
      "routed:a",
      "routed:a",
      "routed:b",
    ]);
  });

  it("shares an in-flight duplicate rather than starting a second", async () => {
    const gate = deferred<string>();
    const task = vi.fn(() => gate.promise);

    const pending = mapWithConcurrency(["x", "x", "x"], task, {
      limit: 3,
      keyOf: (item) => item,
    });

    // Let the workers reach their await before resolving.
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(1);

    gate.resolve("done");
    expect(await pending).toEqual(["done", "done", "done"]);
  });

  it("does not deduplicate when the key function opts out", async () => {
    const task = vi.fn(async (item: string) => item);

    await mapWithConcurrency(["a", "a"], task, {
      limit: 2,
      keyOf: () => null,
    });

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("propagates an abort before starting further items", async () => {
    const controller = new AbortController();
    const task = vi.fn(async (item: number) => {
      if (item === 0) controller.abort();
      return item;
    });

    await expect(
      mapWithConcurrency([0, 1, 2, 3, 4, 5], task, {
        limit: 1,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // The aborting item ran; nothing after it was started.
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("rejects a limit below one rather than silently serialising", async () => {
    await expect(
      mapWithConcurrency([1], async (item) => item, { limit: 0 }),
    ).rejects.toThrow(RangeError);
  });

  it("runs fewer workers than the limit when there are fewer items", async () => {
    let peak = 0;
    let active = 0;

    await mapWithConcurrency(
      [1, 2],
      async (item) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return item;
      },
      { limit: 8 },
    );

    expect(peak).toBe(2);
  });
});
