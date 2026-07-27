/**
 * Process-wide request pacing.
 *
 * Nominatim's usage policy allows at most one request per second, absolutely.
 * Meeting that needs more than a sleep before each call: two concurrent callers
 * would each check the clock, each see that enough time had passed, and both
 * fire. So the gate is a **promise chain** — every caller awaits the previous
 * one's slot, which serialises them by construction no matter how many arrive at
 * once.
 *
 * This is per Node process. Multiple serverless instances each hold their own
 * chain, so the real ceiling is (instances x 1/sec). For a portfolio demo that is
 * fine; anything with real traffic needs a shared limiter or a self-hosted
 * instance, which is documented in the README.
 */

export type RateLimiter = {
  /** Resolves when it is this caller's turn, then reserves the next slot. */
  acquire(signal?: AbortSignal): Promise<void>;
  /** Diagnostics only. */
  state(): { queueLength: number; lastStartedAt: number | null };
};

export function createRateLimiter(
  minIntervalMs: number,
  now: () => number = Date.now,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void> = delay,
): RateLimiter {
  /** Tail of the queue. Each caller chains onto it and becomes the new tail. */
  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt: number | null = null;
  let queueLength = 0;

  return {
    async acquire(signal?: AbortSignal): Promise<void> {
      signal?.throwIfAborted();

      queueLength += 1;

      // Capture the current tail, then immediately install our own promise as the
      // new tail. The next caller waits on us, not on whoever we waited for.
      const previous = tail;
      let release: () => void = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });

      try {
        // Ignore an upstream failure: one caller's error must not wedge the queue.
        await previous.catch(() => {});

        const elapsed =
          lastStartedAt === null ? Number.POSITIVE_INFINITY : now() - lastStartedAt;
        const wait = minIntervalMs - elapsed;
        if (wait > 0) await sleep(wait, signal);

        signal?.throwIfAborted();
        lastStartedAt = now();
      } finally {
        queueLength -= 1;
        // Always release, even on abort, or every later caller deadlocks.
        release();
      }
    },

    state() {
      return { queueLength, lastStartedAt };
    },
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
