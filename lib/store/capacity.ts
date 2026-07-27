import { classifyStorageError, type StorageFailure } from "./storage-usage";

/**
 * Asking whether a write will fit *before* committing it.
 *
 * ## The problem this solves
 *
 * Zustand's `persist` middleware writes to `localStorage` **after** the state update. So a quota
 * failure arrives when the in-memory store already holds the new trip — the traveller sees their
 * change applied, and it silently vanishes on the next reload. That is the worst possible shape for a
 * storage failure: it looks like success.
 *
 * The alternatives were worse. Catching and rolling back means the state briefly held a value that
 * was never persisted, and any render in between shows it. Replacing the storage adapter to write
 * synchronously inside the reducer means reimplementing the persist envelope, which would then drift
 * from whatever the middleware writes on ordinary updates.
 *
 * So: probe first. Serialise the candidate state, write it to a scratch key, delete the key. If that
 * write throws, the real one would have thrown too, and the caller refuses before touching state.
 *
 * ## What it costs, and where it runs
 *
 * One extra serialise-and-write of the whole records map — a few hundred kilobytes. Far too expensive
 * for every keystroke, and entirely affordable on a *guarded save*, which is the only place it runs:
 * generation, refinement, structural edits, pool refresh, import. Those are already revision-checked,
 * atomic, once-per-action writes.
 *
 * ## What it is not
 *
 * Not a quota calculation. It does not ask how much room there is, because no browser reliably
 * answers that. It asks whether *this value* fits, which is the question that has a real answer.
 */

export type CapacityCheck =
  | { ok: true }
  | { ok: false; failure: StorageFailure; error: unknown };

/**
 * Whether `value` can be written under `key` right now.
 *
 * `value` is the *serialised* candidate, so the caller controls exactly what is measured — and so
 * this module never has to know the persist envelope's shape.
 */
export function canPersist(key: string, value: string): CapacityCheck {
  if (typeof localStorage === "undefined") {
    // Server render, or storage switched off entirely. Nothing to probe against.
    return { ok: true };
  }

  try {
    /**
     * Written to the **real** key, not a sibling probe key.
     *
     * A side-by-side probe was the first design and it was wrong: with the old value still under
     * `key`, the check needed `oldSize + newSize` of headroom while the real write — which *replaces*
     * `key` in place — needs only `newSize`. On an origin with 5 MB, 4 MB already stored and a 4.3 MB
     * candidate, the real write succeeds and the probe throws. That refuses a save that would have
     * fitted, in exactly the situation this feature exists to handle well.
     *
     * Writing to the real key is also safe. `setItem` is atomic: a failed write leaves the previous
     * value untouched, so a refusal costs nothing. And a *successful* probe has simply performed the
     * write early — `persist` writes the identical payload moments later, because `reserve()` is
     * called immediately before the `set()` it is guarding and the caller always commits when it
     * returns `ok`.
     *
     * The whole candidate value is used rather than a byte count against a guessed ceiling: browsers
     * charge for the key as well as the value, some engines count UTF-16, and rejection depends on the
     * origin's total rather than this one item. Writing the actual bytes is the only check that cannot
     * be wrong.
     */
    localStorage.setItem(key, value);
    return { ok: true };
  } catch (error) {
    return { ok: false, failure: classifyStorageError(error), error };
  }
}

/**
 * The serialised form of what `persist` will write, for probing.
 *
 * Mirrors the middleware's `{ state, version }` envelope — the one duplication this module accepts,
 * and it is asserted by a test that compares against a real store write. The alternative was probing
 * with a value of a different size from the real one, which would make the check meaningless in
 * exactly the case it exists for.
 */
export function persistedPayload(state: unknown, version: number): string {
  return JSON.stringify({ state, version });
}
