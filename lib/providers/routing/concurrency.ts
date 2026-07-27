/**
 * Bounded-concurrency mapping with order preservation and deduplication.
 *
 * ## Why not `Promise.all`
 *
 * A five-day itinerary is fifteen-odd legs. `Promise.all` over them opens
 * fifteen simultaneous connections to a volunteer-run demo server, which is
 * rude, gets us rate-limited, and makes the failure of one leg indistinguishable
 * from the failure of all of them. Three at a time, in order, with each result
 * kept independently.
 *
 * ## Deduplication
 *
 * Two stops at the same coordinates in the same mode is not hypothetical — a
 * market visited twice, a hotel departed from and returned to. Identical
 * requests share one in-flight promise rather than becoming two calls, and both
 * output positions receive the same result. This happens *before* the
 * concurrency gate, so duplicates never occupy a slot.
 */

export type ConcurrentMapOptions<T> = {
  /** Maximum simultaneously running tasks. */
  limit: number;
  /**
   * Requests producing the same key are issued once and the result shared.
   * Return `null` to opt an item out of deduplication.
   */
  keyOf?: (item: T, index: number) => string | null;
  signal?: AbortSignal;
};

/**
 * Runs `task` over `items` with at most `limit` in flight.
 *
 * Results come back **in input order**, whatever order they completed in. A task
 * that rejects propagates — callers that want partial success (which is all of
 * them here) return a result union from the task rather than throwing.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  task: (item: T, index: number) => Promise<R>,
  options: ConcurrentMapOptions<T>,
): Promise<R[]> {
  const { limit, keyOf, signal } = options;

  if (items.length === 0) return [];
  if (limit < 1) throw new RangeError("Concurrency limit must be at least 1");

  const results = new Array<R>(items.length);
  const inFlightByKey = new Map<string, Promise<R>>();

  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      // Abort between items rather than mid-request: the in-flight fetch has the
      // same signal and will reject on its own.
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");

      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      const item = items[index];
      const key = keyOf?.(item, index) ?? null;

      if (key !== null) {
        const existing = inFlightByKey.get(key);
        if (existing) {
          results[index] = await existing;
          continue;
        }
        const promise = task(item, index);
        inFlightByKey.set(key, promise);
        results[index] = await promise;
        continue;
      }

      results[index] = await task(item, index);
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    () => worker(),
  );

  await Promise.all(workers);

  return results;
}
