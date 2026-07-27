import type { StoredTripRecord } from "./trip-record";

/**
 * How much room this app's trips are taking, and how much there might be.
 *
 * ## Two numbers that are not the same number
 *
 * `appBytes` is what *we* store, measured by serialising the records — a fact we can establish
 * exactly. `quota` and `usage` come from `navigator.storage.estimate()`, cover the whole origin
 * (including caches and anything else the browser counts), and are documented by the spec as
 * *estimates* browsers may fuzz for privacy.
 *
 * They are kept separate and labelled separately, because presenting our own figure as a share of
 * a browser estimate would produce a percentage that is wrong in two directions at once. When the
 * browser gives us nothing we say the quota is unknown rather than inventing 5 MB — the real
 * ceiling varies by browser, by origin, by whether storage is persisted, and by free disk.
 *
 * ## Measured once, not per render
 *
 * Serialising a dozen trips is megabytes of string work. Every entry point takes the records map
 * as an argument and is called from an event handler or a memo keyed on that map — never from a
 * render body.
 */

/** UTF-16 code units are not bytes, and storage is charged in UTF-8. */
function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export type TripStorageEntry = {
  tripId: string;
  destination: string;
  updatedAt: string;
  revision: number;
  /** Serialised size of the whole record: plan, context, pool and history. */
  bytes: number;
  /**
   * The history's share — the one part a traveller can choose to drop.
   *
   * Worth its own line because it answers "what can I free without losing a trip", and because it
   * is the part that *grows as they work*: a record's plan and pool are roughly fixed, while its
   * history is whatever the last twenty edits came to.
   */
  historyBytes: number;
  /** How many steps back and forward those bytes are buying. */
  undoDepth: number;
  redoDepth: number;
};

export type StorageReport = {
  tripCount: number;
  /** Exact, measured from the records themselves. */
  appBytes: number;
  entries: TripStorageEntry[];
  /** Largest first, for "what would free the most room". */
  largest: TripStorageEntry[];
};

export function measureTripStorage(
  records: Record<string, StoredTripRecord>,
): StorageReport {
  const entries: TripStorageEntry[] = Object.entries(records).map(
    ([tripId, record]) => {
      const { past, future } = record.history;
      /** Skipped entirely when there is nothing stored, which is the common case. */
      const historyBytes =
        past.length + future.length === 0
          ? 0
          : utf8Bytes(JSON.stringify(record.history));

      return {
        tripId,
        destination: record.plan.destination.city,
        updatedAt: record.updatedAt,
        revision: record.revision,
        bytes: utf8Bytes(JSON.stringify(record)),
        historyBytes,
        undoDepth: past.length,
        redoDepth: future.length,
      };
    },
  );

  return {
    tripCount: entries.length,
    appBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries: entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    largest: [...entries].sort((a, b) => b.bytes - a.bytes).slice(0, 3),
  };
}

export type BrowserStorageEstimate =
  | { status: "unavailable" }
  | { status: "estimated"; usageBytes: number | null; quotaBytes: number | null };

/**
 * The browser's own view, or an admission that we do not have one.
 *
 * `navigator.storage.estimate()` is absent in some browsers and private modes, and can reject.
 * All three outcomes are the same answer to the traveller — "your browser did not tell us" — and
 * none of them is an excuse to guess.
 */
export async function readBrowserEstimate(): Promise<BrowserStorageEstimate> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { status: "unavailable" };
  }

  try {
    const estimate = await navigator.storage.estimate();
    return {
      status: "estimated",
      usageBytes: typeof estimate.usage === "number" ? estimate.usage : null,
      quotaBytes: typeof estimate.quota === "number" ? estimate.quota : null,
    };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Why a write failed, in terms the interface can act on.
 *
 * `QuotaExceededError` is the one worth distinguishing: it is recoverable by the traveller — delete
 * a trip, drop a snapshot, export and remove — whereas the others are not. Browsers disagree about
 * how they report it (Safari has used code 22 under a different name, Firefox
 * `NS_ERROR_DOM_QUOTA_REACHED`), so the check covers all three rather than trusting `name`.
 */
export type StorageFailure = "quota_exceeded" | "unavailable" | "unknown";

export function classifyStorageError(error: unknown): StorageFailure {
  if (error instanceof DOMException) {
    if (
      error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
      error.code === 22
    ) {
      return "quota_exceeded";
    }
    // Private browsing in some engines throws on access rather than on write.
    if (error.name === "SecurityError" || error.code === 18) {
      return "unavailable";
    }
  }

  if (error instanceof Error && /quota|storage is full/i.test(error.message)) {
    return "quota_exceeded";
  }

  return "unknown";
}

/** What to tell the traveller, and what they can do about it. */
export const STORAGE_FAILURE_MESSAGES: Record<StorageFailure, string> = {
  quota_exceeded:
    "This browser has run out of room for saved trips, so the change was not saved. Your existing trips are untouched. Export a trip you want to keep, then delete one you do not — or drop a trip's undo history to free space.",
  unavailable:
    "This browser is not allowing sites to save data, so the change was not saved. Private windows often block it. Your existing trips are untouched.",
  unknown:
    "The change could not be saved to this browser's storage. Your existing trips are untouched. Try again, and export anything you cannot afford to lose.",
};

/** Bytes as a short human string. No locale dependence on the unit. */
export function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
