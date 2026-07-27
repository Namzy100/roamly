import { describe, expect, it } from "vitest";

import { createRateLimiter } from "./rate-limit";

/**
 * A virtual clock and sleep, so pacing is verified deterministically rather than by
 * waiting a real second per assertion.
 *
 * `sleep` advances the clock immediately and records the requested duration, which
 * is what lets us assert "these two calls were at least 1s apart" without the suite
 * taking seconds.
 */
function harness(minIntervalMs = 1_000) {
  let now = 0;
  const sleeps: number[] = [];
  const startTimes: number[] = [];

  const limiter = createRateLimiter(
    minIntervalMs,
    () => now,
    async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  );

  return {
    limiter,
    sleeps,
    startTimes,
    get now() {
      return now;
    },
    advance(ms: number) {
      now += ms;
    },
    async acquire(signal?: AbortSignal) {
      await limiter.acquire(signal);
      startTimes.push(now);
    },
  };
}

describe("createRateLimiter", () => {
  it("lets the first request through without waiting", async () => {
    const h = harness();
    await h.acquire();
    expect(h.sleeps).toEqual([]);
    expect(h.startTimes).toEqual([0]);
  });

  it("keeps consecutive requests at least the interval apart", async () => {
    const h = harness(1_000);
    await h.acquire();
    await h.acquire();
    await h.acquire();

    expect(h.startTimes).toEqual([0, 1_000, 2_000]);
    for (let i = 1; i < h.startTimes.length; i += 1) {
      expect(h.startTimes[i] - h.startTimes[i - 1]).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("does not wait when enough time has already passed", async () => {
    const h = harness(1_000);
    await h.acquire();
    h.advance(5_000);
    await h.acquire();
    expect(h.sleeps).toEqual([]);
  });

  it("serialises concurrent callers instead of letting them race", async () => {
    // The reason the limiter is a promise chain rather than a clock check: five
    // callers arriving together must still be spaced, not all see "enough time has
    // passed" simultaneously and fire at once.
    const h = harness(1_000);

    await Promise.all([
      h.acquire(),
      h.acquire(),
      h.acquire(),
      h.acquire(),
      h.acquire(),
    ]);

    expect(h.startTimes).toHaveLength(5);
    const sorted = [...h.startTimes].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      expect(sorted[i] - sorted[i - 1]).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("uses the configured interval, so Nominatim's 1/sec floor is honoured", async () => {
    const h = harness(1_100);
    await h.acquire();
    await h.acquire();
    expect(h.startTimes[1] - h.startTimes[0]).toBeGreaterThanOrEqual(1_000);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const h = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.limiter.acquire(controller.signal)).rejects.toThrow();
  });

  it("does not wedge the queue when one caller aborts", async () => {
    // A rejected caller must still release its slot, or every later caller
    // deadlocks behind it.
    const h = harness(1_000);
    await h.acquire();

    const controller = new AbortController();
    controller.abort();
    await expect(h.limiter.acquire(controller.signal)).rejects.toThrow();

    await expect(h.acquire()).resolves.toBeUndefined();
  });

  it("reports queue state for diagnostics", async () => {
    const h = harness();
    expect(h.limiter.state().lastStartedAt).toBeNull();
    await h.acquire();
    expect(h.limiter.state().lastStartedAt).toBe(0);
    expect(h.limiter.state().queueLength).toBe(0);
  });
});
