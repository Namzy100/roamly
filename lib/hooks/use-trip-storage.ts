"use client";

import { nanoid } from "nanoid";
import { useCallback, useMemo, useState } from "react";

import {
  MAX_IMPORT_BYTES,
  exportFileName,
  exportTrip,
  parseImportedTrip,
  serialiseTrip,
  type PortableTrip,
} from "@/lib/store/portable-trip";
import {
  measureTripStorage,
  readBrowserEstimate,
  type BrowserStorageEstimate,
  type StorageReport,
} from "@/lib/store/storage-usage";
import { describeSaveFailure, useTripStore } from "@/lib/store/trip-store";

/**
 * The storage panel's workflow, kept out of the component.
 *
 * ## Measured on demand, never on render
 *
 * `measureTripStorage` serialises every record — hundreds of kilobytes of string work. It is behind
 * a `useMemo` keyed on the records map, so it runs when the trips actually change and not when a
 * hover moves. The browser's own estimate is fetched only when the panel asks, because it is async
 * and because a value nobody is looking at is a value not worth having.
 *
 * ## Import is two decisions, not one
 *
 * Reading the file and *committing* it are separate steps. A file that parses is held as a pending
 * import until the traveller chooses "new copy" or "replace" — and replacing needs a second
 * confirmation, because it overwrites a trip they still have.
 */

export type ImportState =
  | { status: "idle" }
  | { status: "reading" }
  /** Parsed and validated; waiting for the traveller to choose what to do with it. */
  | { status: "ready"; trip: PortableTrip; collidesWithTripId: string | null }
  | { status: "error"; message: string }
  | { status: "imported"; tripId: string; message: string };

export function useTripStorage() {
  const records = useTripStore((state) => state.records);
  const removeTrip = useTripStore((state) => state.removeTrip);
  const clearAll = useTripStore((state) => state.clearAll);
  const dropHistory = useTripStore((state) => state.dropHistory);
  const importTripAsCopy = useTripStore((state) => state.importTripAsCopy);
  const replaceTripFromImport = useTripStore((state) => state.replaceTripFromImport);

  const [estimate, setEstimate] = useState<BrowserStorageEstimate | null>(null);
  const [importState, setImportState] = useState<ImportState>({ status: "idle" });

  /** Keyed on the records map: recomputed when trips change, not when the panel rerenders. */
  const report: StorageReport = useMemo(
    () => measureTripStorage(records),
    [records],
  );

  const refreshEstimate = useCallback(async () => {
    setEstimate(await readBrowserEstimate());
  }, []);

  /**
   * Writes the file through an object URL and revokes it immediately.
   *
   * A data: URL would be simpler and would also embed a whole trip in the DOM. The anchor is created
   * detached and never appended, so nothing about the page changes.
   */
  const exportOne = useCallback(
    (tripId: string) => {
      const record = records[tripId];
      if (!record) return;

      const text = serialiseTrip(exportTrip(record, new Date().toISOString()));
      const url = URL.createObjectURL(
        new Blob([text], { type: "application/json" }),
      );

      try {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = exportFileName(record);
        anchor.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [records],
  );

  const readFile = useCallback(
    async (file: File) => {
      setImportState({ status: "reading" });

      /**
       * `file.size` first — the real byte count, available without reading anything.
       *
       * `parseImportedTrip` also bounds the text, but only after `file.text()` has decoded the whole
       * thing into a string, and it compares UTF-16 code units against a byte constant — so a
       * non-ASCII file can be well over the documented ceiling and still pass. Checking `size`
       * up front is both the accurate figure and the one that avoids the read.
       */
      if (file.size > MAX_IMPORT_BYTES) {
        setImportState({
          status: "error",
          message:
            "That file is far larger than any Roamly trip, so it was not read. Check you selected the right file.",
        });
        return;
      }

      const result = parseImportedTrip(await file.text());
      if (!result.ok) {
        setImportState({ status: "error", message: result.message });
        return;
      }

      const existingId = result.trip.record.plan.id;
      setImportState({
        status: "ready",
        trip: result.trip,
        /**
         * `Object.hasOwn`, not a truthiness check.
         *
         * `records[id]` reads through the prototype chain, so an imported plan whose id is
         * `"__proto__"` would resolve to `Object.prototype` and report a collision that does not
         * exist. Cosmetic rather than dangerous, and a one-word fix.
         *
         * Named rather than resolved silently: replacing is the traveller's decision.
         */
        collidesWithTripId: Object.hasOwn(records, existingId) ? existingId : null,
      });
    },
    [records],
  );

  const commitAsCopy = useCallback(() => {
    if (importState.status !== "ready") return;

    const tripId = nanoid(10);
    const saved = importTripAsCopy({ trip: importState.trip, tripId });

    if (!saved.ok) {
      setImportState({
        status: "error",
        message:
          "storage" in saved
            ? saved.storage.message
            : "That trip did not pass validation, so nothing was imported.",
      });
      return;
    }

    setImportState({
      status: "imported",
      tripId,
      message: "Imported as a new trip. Its planner and places are unchanged.",
    });
  }, [importState, importTripAsCopy]);

  const commitAsReplacement = useCallback(() => {
    if (importState.status !== "ready" || !importState.collidesWithTripId) return;

    const tripId = importState.collidesWithTripId;
    const current = records[tripId];
    if (!current) return;

    const saved = replaceTripFromImport({
      tripId,
      /**
       * Read now, not when the file was opened.
       *
       * `records` is a live selector value, so any write in *this* tab since the import dialog opened —
       * a refinement, a route calculation, an undo — is reflected here. It deliberately does not claim
       * cross-tab awareness: there is no `storage` event listener, so another tab's write is invisible
       * until this one reloads, and the revision guard in the store is what catches that.
       */
      expectedRevision: current.revision,
      trip: importState.trip,
    });

    if (!saved.ok) {
      setImportState({ status: "error", message: describeSaveFailure(saved) });
      return;
    }

    setImportState({
      status: "imported",
      tripId,
      message: "Replaced. The previous version is one undo away.",
    });
  }, [importState, records, replaceTripFromImport]);

  const dismissImport = useCallback(
    () => setImportState({ status: "idle" }),
    [],
  );

  return {
    report,
    estimate,
    refreshEstimate,
    exportOne,
    removeTrip,
    clearAll,
    dropHistory,
    importState,
    readFile,
    commitAsCopy,
    commitAsReplacement,
    dismissImport,
  };
}
