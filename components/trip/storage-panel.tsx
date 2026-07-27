"use client";

import { useRef, useState } from "react";
import {
  Database,
  Download,
  HardDrive,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  formatBytes,
  type TripStorageEntry,
} from "@/lib/store/storage-usage";
import { useTripStorage } from "@/lib/hooks/use-trip-storage";
import { cn } from "@/lib/utils";

/**
 * A trip's history as steps rather than as bytes.
 *
 * Said in three places on this row — the size line, the free button's label, and the confirmation —
 * so it is written once. The count is the *actual* depth: the byte budget means a long trip often
 * holds fewer than twenty, and a control claiming otherwise would overstate what is being given up.
 */
function describeDepth(entry: TripStorageEntry): string {
  const steps = entry.undoDepth + entry.redoDepth;
  return `${steps} undo step${steps === 1 ? "" : "s"}`;
}

/**
 * Where saved trips live, how much room they take, and how to get them out.
 *
 * ## Two numbers, never divided by each other
 *
 * "Roamly's trips" is measured exactly, by serialising them. "This browser" comes from
 * `navigator.storage.estimate()`, covers the whole origin, and is an estimate the spec allows
 * browsers to fuzz. They are shown side by side and never as a percentage: dividing an exact figure
 * by a fuzzed one produces a number that is wrong in two directions at once, and a progress bar
 * would imply a precision nobody has.
 *
 * When the browser declines to answer, the panel says the quota is unknown rather than assuming 5 MB.
 *
 * ## Export is the answer to the failure this app can actually have
 *
 * Trips exist in one browser. Clearing site data, a full quota, a new laptop — each loses them, and
 * none is recoverable by us. So export is offered prominently and beside the delete controls, where
 * it is needed.
 */

export function StoragePanel({ className }: { className?: string }) {
  const storage = useTripStorage();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const [confirmingSnapshot, setConfirmingSnapshot] = useState<string | null>(null);

  const { report, estimate } = storage;

  return (
    <section
      aria-labelledby="storage-heading"
      data-testid="storage-panel"
      data-trip-count={report.tripCount}
      className={cn(
        "flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex items-start gap-2.5">
        <HardDrive aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <h3 id="storage-heading" className="font-display text-base text-forest">
            Saved trips and storage
          </h3>
          <p className="mt-1 text-sm leading-relaxed text-ink-muted text-pretty">
            Your trips are saved in this browser only — there is no account and no server. Export
            anything you cannot afford to lose.
          </p>
        </div>
      </div>

      {/* -- the two figures, side by side --------------------------------- */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl bg-sand/50 p-3 text-xs text-ink-muted">
        <div className="flex items-baseline justify-between gap-2">
          <dt>Trips saved</dt>
          <dd data-testid="storage-trip-count" className="font-medium tabular-nums text-ink">
            {report.tripCount}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt>Roamly&rsquo;s trips</dt>
          <dd data-testid="storage-app-bytes" className="font-medium tabular-nums text-ink">
            {formatBytes(report.appBytes)}
          </dd>
        </div>

        {estimate === null ? (
          <div className="col-span-2">
            <button
              type="button"
              data-testid="storage-check-browser"
              onClick={() => void storage.refreshEstimate()}
              className="underline underline-offset-2"
            >
              Ask this browser how much room it has
            </button>
          </div>
        ) : estimate.status === "unavailable" ? (
          <p data-testid="storage-quota-unknown" className="col-span-2">
            This browser does not report how much room it allows, so there is no reliable figure to
            show. It varies by browser and by how much disk is free.
          </p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <dt>This browser reports using</dt>
              <dd className="font-medium tabular-nums text-ink">
                {estimate.usageBytes === null
                  ? "not reported"
                  : formatBytes(estimate.usageBytes)}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt>and allowing</dt>
              <dd
                data-testid="storage-quota"
                className="font-medium tabular-nums text-ink"
              >
                {estimate.quotaBytes === null
                  ? "not reported"
                  : formatBytes(estimate.quotaBytes)}
              </dd>
            </div>
            <p className="col-span-2 text-[0.6875rem]">
              Both are the browser&rsquo;s own estimates for this whole site, not just Roamly, and
              browsers deliberately round them.
            </p>
          </>
        )}
      </dl>

      {/* -- per-trip listing ---------------------------------------------- */}
      {report.tripCount === 0 ? (
        <p className="text-xs text-ink-muted">
          No trips saved in this browser yet.
        </p>
      ) : (
        <ul data-testid="storage-trip-list" className="flex flex-col gap-2">
          {report.entries.map((entry) => (
            <li
              key={entry.tripId}
              data-testid="storage-trip"
              data-trip-id={entry.tripId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-line bg-cream px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1">
                <span className="block font-medium text-ink">{entry.destination}</span>
                <span className="block text-ink-muted">
                  {formatBytes(entry.bytes)} · revision {entry.revision} · updated{" "}
                  {entry.updatedAt.slice(0, 10)}
                  {/*
                    * The depth, not just the bytes.
                    *
                    * "48 KB of undo history" is a number to weigh against nothing. The steps are
                    * what the traveller is being asked to give up, so both are said.
                    */}
                  {entry.historyBytes > 0
                    ? ` · ${formatBytes(entry.historyBytes)} of that is ${describeDepth(entry)}`
                    : ""}
                </span>
              </span>

              {/*
                * `aria-live` on the row's action group.
                *
                * The confirm-then-act buttons swap their own label in place ("Free 14 KB" → "Drop it —
                * undo will be lost"). React reuses the DOM node, so focus is correctly preserved — but
                * nothing told a screen-reader user the key under their finger now means something else.
                */}
              <span aria-live="polite" className="flex flex-wrap gap-1.5">
                <button
                  type="button"
                  data-testid="storage-export"
                  data-trip-id={entry.tripId}
                  aria-label={`Export the trip to ${entry.destination} as JSON`}
                  onClick={() => storage.exportOne(entry.tripId)}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 font-medium text-forest transition-colors hover:bg-sand/60"
                >
                  <Download aria-hidden className="size-3" />
                  Export
                </button>

                {entry.historyBytes > 0 ? (
                  confirmingSnapshot === entry.tripId ? (
                    <button
                      type="button"
                      data-testid="storage-drop-history-confirm"
                      data-trip-id={entry.tripId}
                      onClick={() => {
                        storage.dropHistory(entry.tripId);
                        setConfirmingSnapshot(null);
                      }}
                      className="rounded-full border border-terracotta/40 bg-terracotta/10 px-2 py-1 font-medium text-terracotta-ink"
                    >
                      Drop it — {describeDepth(entry)} will be lost
                    </button>
                  ) : (
                    <button
                      type="button"
                      data-testid="storage-drop-history"
                      data-trip-id={entry.tripId}
                      aria-label={`Free ${formatBytes(entry.historyBytes)} by dropping ${describeDepth(entry)} for ${entry.destination}`}
                      onClick={() => setConfirmingSnapshot(entry.tripId)}
                      className="rounded-full border border-line px-2 py-1 font-medium text-forest transition-colors hover:bg-sand/60"
                    >
                      Free {formatBytes(entry.historyBytes)}
                    </button>
                  )
                ) : null}

                <button
                  type="button"
                  data-testid="storage-delete"
                  data-trip-id={entry.tripId}
                  aria-label={`Delete the trip to ${entry.destination}`}
                  onClick={() => storage.removeTrip(entry.tripId)}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-1 font-medium text-ink-muted transition-colors hover:border-destructive/40 hover:text-destructive"
                >
                  <Trash2 aria-hidden className="size-3" />
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* -- import -------------------------------------------------------- */}
      <div className="flex flex-col gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            data-testid="storage-import-input"
            /**
             * Out of the tab order, and hidden from assistive technology.
             *
             * `sr-only` clips it visually but leaves it focusable, so a keyboard user landed on a
             * control with no visible focus ring anywhere on screen and a screen reader announced a
             * bare, unlabelled file input. The labelled `Button` beside it *is* the control — it opens
             * this picker — so this element is an implementation detail and is marked as one.
             */
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              // Reset first, so re-choosing the same file fires a change event again.
              event.target.value = "";
              if (file) void storage.readFile(file);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            data-testid="storage-import"
            onClick={() => fileRef.current?.click()}
          >
            <Upload aria-hidden className="size-3.5" />
            Import a trip from JSON
          </Button>

          {report.tripCount > 0 ? (
            confirmingClear ? (
              <Button
                type="button"
                size="sm"
                variant="destructive"
                data-testid="storage-clear-confirm"
                onClick={() => {
                  storage.clearAll();
                  setConfirmingClear(false);
                }}
              >
                Delete all {report.tripCount} trips
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                data-testid="storage-clear"
                onClick={() => setConfirmingClear(true)}
              >
                Clear all saved trips
              </Button>
            )
          ) : null}
        </div>

        <ImportOutcome storage={storage} />
      </div>
    </section>
  );
}

/**
 * What happened to the file, and what remains to be decided.
 *
 * A parsed file is deliberately *not* saved yet: "new copy" and "replace" are different outcomes and
 * only one of them is destructive, so the traveller picks.
 */
function ImportOutcome({
  storage,
}: {
  storage: ReturnType<typeof useTripStorage>;
}) {
  const state = storage.importState;
  if (state.status === "idle") return null;

  if (state.status === "reading") {
    return <p className="text-xs text-ink-muted">Reading that file…</p>;
  }

  if (state.status === "error") {
    return (
      <p
        role="alert"
        data-testid="storage-import-error"
        className="flex items-start gap-1.5 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-relaxed text-ink"
      >
        <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <span className="flex-1">{state.message}</span>
        <button
          type="button"
          onClick={storage.dismissImport}
          className="shrink-0 underline underline-offset-2"
        >
          Dismiss
        </button>
      </p>
    );
  }

  if (state.status === "imported") {
    return (
      <p
        role="status"
        data-testid="storage-import-done"
        className="rounded-xl bg-sand/60 px-3 py-2 text-xs text-ink"
      >
        {state.message}{" "}
        <button
          type="button"
          onClick={storage.dismissImport}
          className="underline underline-offset-2"
        >
          Dismiss
        </button>
      </p>
    );
  }

  return (
    <div
      /* New decision buttons appeared; a screen-reader user is told rather than left to notice. */
      role="status"
      data-testid="storage-import-ready"
      className="flex flex-col gap-2 rounded-xl border border-line bg-sand/40 p-3 text-xs leading-relaxed"
    >
      <p className="text-ink">
        <Database aria-hidden className="mr-1 inline size-3" />
        That file is a valid Roamly trip to{" "}
        <strong>{state.trip.record.plan.destination.city}</strong>, verified against the place search
        it was built from. Nothing has been saved yet.
      </p>

      {state.collidesWithTripId ? (
        <p data-testid="storage-import-collision" className="text-ink-muted">
          You already have this trip saved. Importing as a copy keeps both; replacing overwrites the
          one you have — and leaves it one undo away.
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-0.5">
        <Button
          type="button"
          size="sm"
          data-testid="storage-import-copy"
          onClick={storage.commitAsCopy}
        >
          Import as a new copy
        </Button>
        {state.collidesWithTripId ? (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            data-testid="storage-import-replace"
            onClick={storage.commitAsReplacement}
          >
            Replace the trip I have
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={storage.dismissImport}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
