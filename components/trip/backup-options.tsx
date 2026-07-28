"use client";

import { CalendarPlus, LifeBuoy, Loader2, Repeat } from "lucide-react";

import { formatMoney } from "@/lib/format";
import { ITEM_KIND_LABELS, type BackupOption, type Currency } from "@/lib/schemas";

/**
 * Swap-ins for the selected day. Shown alongside the itinerary rather than
 * buried, because the moment they matter is the moment a place turns out to be
 * closed and the traveller is standing outside it.
 */
export function BackupOptions({
  backups,
  currency,
  dayNumberOf,
  onReplace,
  onPromote,
  canPromote = false,
  busyBackupId = null,
  canReplace = false,
}: {
  backups: BackupOption[];
  currency: Currency;
  /**
   * Which day a backup belongs to.
   *
   * The All Days view flattens every day's backups into one list, and a replacement
   * command needs the day — so the mapping is supplied rather than guessed from
   * position.
   */
  dayNumberOf?: (backupId: string) => number | null;
  onReplace?: (input: { dayNumber: number; backupId: string }) => void;
  /**
   * Promoting a backup into the itinerary (Phase 6C).
   *
   * Separate from `onReplace` and separately gated: replacing a backup asks a model for a
   * different fallback, while promoting is pure arithmetic over the trip's own pool. So a trip
   * with no configured planner can still promote — the two controls do not share a condition.
   */
  onPromote?: (input: { dayNumber: number; backupId: string }) => void;
  canPromote?: boolean;
  busyBackupId?: string | null;
  canReplace?: boolean;
}) {
  if (backups.length === 0) return null;

  return (
    <section
      aria-labelledby="backups-heading"
      className="flex flex-col gap-3 rounded-2xl border border-dashed border-line bg-sand/30 p-5"
    >
      <h3
        id="backups-heading"
        className="flex items-center gap-2 font-display text-lg text-forest"
      >
        <LifeBuoy aria-hidden className="size-4 text-terracotta" />
        If something falls through
      </h3>

      <ul className="flex flex-col gap-3">
        {backups.map((backup) => (
          <li
            key={backup.id}
            className="flex flex-col gap-1.5 rounded-xl border border-line bg-cream-raised p-3.5"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-ink">{backup.title}</p>
              <span className="shrink-0 text-sm font-medium text-forest">
                {backup.estimatedCost === 0
                  ? "Free"
                  : formatMoney(backup.estimatedCost, currency)}
              </span>
            </div>

            <p className="text-xs leading-relaxed text-ink-muted text-pretty">
              {backup.reason}
            </p>

            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-ink-muted">
              <span className="rounded-full bg-sand px-2 py-0.5 font-medium text-forest">
                {ITEM_KIND_LABELS[backup.kind]}
              </span>
              <span>{backup.place.name}</span>
              {/*
                * No rating, for the reason set out in `itinerary-item-card.tsx`: mock-only, so present on the demo trip and
                * absent from every real one. A fallback is the last place a ranking signal belongs anyway — a backup is
                * chosen because the first choice fell through, not because it scored well.
                */}

              {canReplace && onReplace ? (
                <button
                  type="button"
                  onClick={() => {
                    const dayNumber = dayNumberOf?.(backup.id) ?? null;
                    if (dayNumber === null) return;
                    onReplace({ dayNumber, backupId: backup.id });
                  }}
                  disabled={busyBackupId !== null}
                  data-testid="replace-backup"
                  data-backup-id={backup.id}
                  className="ml-auto inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 font-medium text-forest transition-colors hover:border-forest-soft/60 hover:bg-cream-raised disabled:opacity-50"
                >
                  {busyBackupId === backup.id ? (
                    <Loader2 aria-hidden className="size-3 animate-spin" />
                  ) : (
                    <Repeat aria-hidden className="size-3" />
                  )}
                  Replace
                </button>
              ) : null}
            </p>

            {canPromote && onPromote ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => {
                    const dayNumber = dayNumberOf?.(backup.id) ?? null;
                    if (dayNumber === null) return;
                    onPromote({ dayNumber, backupId: backup.id });
                  }}
                  disabled={busyBackupId !== null}
                  data-testid="promote-backup"
                  data-backup-id={backup.id}
                  className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[0.6875rem] font-medium text-forest transition-colors hover:border-forest-soft/60 hover:bg-cream-raised disabled:opacity-50"
                >
                  <CalendarPlus aria-hidden className="size-3" />
                  Add to itinerary
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
