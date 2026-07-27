"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Database, Loader2, RefreshCw, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  offlineReasonFor,
  useOnlineStatus,
} from "@/lib/hooks/use-online-status";
import type { PoolRefreshWorkflowState } from "@/lib/hooks/use-structural-edits";
import type { TripGenerationContext } from "@/lib/schemas";
import {
  describePoolAge,
  refreshUnavailableReason,
  type ReconciliationPolicy,
} from "@/lib/structural-edits";
import { cn } from "@/lib/utils";

/**
 * The trip's place pool: how old it is, and how to look again.
 *
 * ## What the age does and does not claim
 *
 * "Updated 12 days ago" is a fact about a cache. It is **not** a claim that the places have
 * closed or moved — OSM data for a monument may not change in a decade — and every string here
 * says "may be outdated" rather than "is outdated" for that reason. The age exists so a
 * traveller can decide whether re-running a search is worth it, and for nothing else.
 *
 * ## Nothing happens in one click
 *
 * Refreshing can leave stops pointing at records the latest search no longer contains, so the
 * flow is: confirm → search → **see the diff** → choose what happens to missing places →
 * confirm again. Each step is reversible until the last, and the last is one undo away.
 *
 * ## Text and counts, not colour
 *
 * Every number in the diff is stated in words as well as shown, and the two policies are
 * described by what they do rather than by which looks safer.
 */

export function PlacePoolPanel({
  generation,
  now,
  state,
  onBegin,
  onRun,
  onApply,
  onCancel,
  onDismiss,
}: {
  generation: TripGenerationContext | null;
  /** Passed in, never read here — a component reading the clock in render mismatches. */
  now: Date;
  state: PoolRefreshWorkflowState;
  onBegin: () => void;
  onRun: (policy: ReconciliationPolicy) => void;
  onApply: (policy: ReconciliationPolicy) => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const headingId = useId();
  const age = describePoolAge({ generation, now });
  const unavailable = refreshUnavailableReason(generation);

  const online = useOnlineStatus();
  const [policy, setPolicy] = useState<ReconciliationPolicy>(
    "keep-valid-and-flag-missing",
  );

  const retainedCount = generation?.retainedPlaces?.length ?? 0;

  return (
    <section
      aria-labelledby={headingId}
      data-testid="place-pool-panel"
      data-pool-age={age.state}
      data-refresh-status={state.status}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-4 sm:p-5"
    >
      <div className="flex items-start gap-2.5">
        <Database aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
        <div className="min-w-0 flex-1">
          <h3 id={headingId} className="font-display text-base text-forest">
            Available places
          </h3>
          <p
            data-testid="pool-age-label"
            className="mt-1 text-sm leading-relaxed text-ink-muted text-pretty"
          >
            {age.label}
          </p>
          {age.placeCount > 0 ? (
            <p className="mt-0.5 text-xs text-ink-muted">
              <span data-testid="pool-place-count">{age.placeCount}</span> places
              found
              {generation
                ? ` across ${generation.discoverySummary.categoriesRequested.length} categories`
                : ""}
              {generation && generation.discoverySummary.categoriesWithNoResults.length > 0
                ? `, ${generation.discoverySummary.categoriesWithNoResults.length} of which returned nothing`
                : ""}
              .
            </p>
          ) : null}

          {/*
            * Retained places are stated, not hidden. A traveller whose museum is no longer in
            * the search should know it cannot be offered elsewhere in the trip.
            */}
          {retainedCount > 0 ? (
            <p
              data-testid="retained-place-note"
              className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-sand/60 p-2 text-xs leading-relaxed text-ink"
            >
              <TriangleAlert
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-terracotta"
              />
              <span>
                {retainedCount} place{retainedCount === 1 ? "" : "s"} in this trip{" "}
                {retainedCount === 1 ? "was" : "were"} not found by the latest search.{" "}
                {retainedCount === 1 ? "It is" : "They are"} kept exactly as{" "}
                {retainedCount === 1 ? "it was" : "they were"}, but can no longer be
                offered as alternatives elsewhere. That often means a mapper retagged{" "}
                {retainedCount === 1 ? "it" : "them"} rather than that{" "}
                {retainedCount === 1 ? "it has" : "they have"} closed.
              </span>
            </p>
          ) : null}
        </div>
      </div>

      {!online ? (
        <p
          data-testid="refresh-offline"
          className="rounded-xl bg-sand/60 px-3 py-2 text-xs leading-relaxed text-ink-muted"
        >
          {offlineReasonFor("refresh-pool")}
        </p>
      ) : unavailable ? (
        <p
          data-testid="refresh-unavailable"
          className="rounded-xl bg-sand/60 px-3 py-2 text-xs leading-relaxed text-ink-muted"
        >
          {unavailable}
        </p>
      ) : state.status === "idle" || state.status === "error" || state.status === "conflict" ? (
        <div className="flex flex-col gap-2">
          <div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              data-testid="refresh-pool"
              onClick={onBegin}
            >
              <RefreshCw aria-hidden className="size-3.5" />
              Refresh available places
            </Button>
          </div>
          {state.status === "error" || state.status === "conflict" ? (
            <p
              role="alert"
              data-testid="refresh-error"
              className="rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3 py-2 text-xs leading-relaxed text-ink"
            >
              {state.message}
            </p>
          ) : null}
        </div>
      ) : null}

      {state.status === "confirming" ? (
        <ConfirmRefresh
          onCancel={onCancel}
          onConfirm={() => onRun(policy)}
        />
      ) : null}

      {state.status === "refreshing" ? (
        <p
          role="status"
          data-testid="refresh-running"
          className="flex items-center gap-2 text-xs text-ink-muted"
        >
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Searching OpenStreetMap again…
          <button
            type="button"
            onClick={onCancel}
            className="underline underline-offset-2"
          >
            Cancel
          </button>
        </p>
      ) : null}

      {state.status === "preview" ? (
        <RefreshPreview
          state={state}
          policy={policy}
          onPolicyChange={setPolicy}
          onApply={() => onApply(policy)}
          onCancel={onCancel}
        />
      ) : null}

      {state.status === "applying" ? (
        <p role="status" className="flex items-center gap-2 text-xs text-ink-muted">
          <Loader2 aria-hidden className="size-3.5 animate-spin" />
          Applying…
        </p>
      ) : null}

      {state.status === "applied" ? (
        <div
          role="status"
          data-testid="refresh-applied"
          className="flex flex-col gap-1.5 rounded-xl bg-sand/60 px-3 py-2.5 text-xs"
        >
          <p className="font-medium text-forest">Places refreshed.</p>
          {state.warnings.map((warning, index) => (
            <p key={`${warning.code}-${index}`} className="text-ink-muted">
              {warning.message}
            </p>
          ))}
          <button
            type="button"
            onClick={onDismiss}
            className="w-fit underline underline-offset-2"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </section>
  );
}

/**
 * Step one: say what a refresh can do before doing it.
 *
 * Not a generic "are you sure?". The consequences named here are the ones that are hard to
 * discover afterwards: alternatives can appear *and* disappear, and the itinerary will not be
 * rewritten without a further choice.
 */
function ConfirmRefresh({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => confirmRef.current?.focus(), []);

  return (
    <div
      data-testid="refresh-confirm"
      className="flex flex-col gap-2 rounded-xl border border-line bg-sand/40 p-3 text-xs leading-relaxed text-ink"
    >
      <p>
        This searches OpenStreetMap again around the same destination and radius. It can
        add alternatives that have been mapped since, and it can remove ones that are no
        longer there.
      </p>
      <p className="text-ink-muted">
        Your itinerary is <strong>not</strong> rewritten. If a place your trip uses is
        missing from the new search you will be shown exactly which, and you choose what
        happens to it.
      </p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          ref={confirmRef}
          data-testid="refresh-confirm-run"
          onClick={onConfirm}
        >
          Search again
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/**
 * Step two: the diff, then the choice.
 *
 * Everything is a count with a sentence beside it. The two policies are radio buttons described
 * by their effect, because "keep" and "replace" mean nothing without saying what is kept or
 * replaced — and the counts differ between them, which is the information the traveller needs.
 */
function RefreshPreview({
  state,
  policy,
  onPolicyChange,
  onApply,
  onCancel,
}: {
  state: Extract<PoolRefreshWorkflowState, { status: "preview" }>;
  policy: ReconciliationPolicy;
  onPolicyChange: (policy: ReconciliationPolicy) => void;
  onApply: () => void;
  onCancel: () => void;
}) {
  const { changes } = state;
  const selected =
    state.previews.find((preview) => preview.policy === policy) ?? state.previews[0];

  return (
    <div
      /**
       * A live region, because the search takes seconds and its result is a screenful of new content
       * plus new decision buttons. Without this, a screen-reader user who looked away got no signal
       * that the long-running action had finished at all.
       */
      role="status"
      data-testid="refresh-preview"
      className="flex flex-col gap-3 rounded-xl border border-line bg-sand/40 p-3 text-xs leading-relaxed"
    >
      {state.partial ? (
        <p
          data-testid="refresh-partial"
          className="flex items-start gap-1.5 rounded-lg bg-terracotta/10 p-2 text-ink"
        >
          <TriangleAlert
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-terracotta"
          />
          <span>
            Part of this search did not complete, so some places are missing from the
            result rather than gone from the map. Applying it now would treat them as
            missing — waiting and trying again is usually better.
          </span>
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-ink-muted">
        <Stat label="Places before" value={changes.previousCount} />
        <Stat label="Places now" value={changes.newCount} testId="pool-diff-new" />
        <Stat label="Added" value={changes.addedPlaceIds.length} testId="pool-diff-added" />
        <Stat
          label="No longer found"
          value={changes.removedPlaceIds.length}
          testId="pool-diff-removed"
        />
        <Stat
          label="Records updated"
          value={changes.changedCanonicalRecords.length}
          testId="pool-diff-changed"
        />
        <Stat
          label="Used by your trip and missing"
          value={changes.missingUsedPlaceIds.length}
          testId="pool-diff-missing-used"
        />
      </dl>

      {changes.missingUsedPlaceIds.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium text-ink">
            {changes.missingUsedPlaceIds.length} place
            {changes.missingUsedPlaceIds.length === 1 ? "" : "s"} your trip uses{" "}
            {changes.missingUsedPlaceIds.length === 1 ? "is" : "are"} not in the new
            search
          </legend>

          {state.previews.map((preview) => (
            <label
              key={preview.policy}
              className={cn(
                "flex cursor-pointer gap-2 rounded-lg border p-2",
                preview.policy === policy
                  ? "border-forest-soft/60 bg-cream-raised"
                  : "border-line",
              )}
            >
              <input
                type="radio"
                name="reconciliation-policy"
                className="mt-0.5"
                data-testid="reconciliation-policy"
                data-policy={preview.policy}
                checked={preview.policy === policy}
                onChange={() => onPolicyChange(preview.policy)}
              />
              <span className="min-w-0">
                <span className="block font-medium text-ink">
                  {preview.policy === "keep-valid-and-flag-missing"
                    ? "Keep my stops exactly as they are"
                    : "Turn those stops into open slots"}
                </span>
                <span className="block text-ink-muted">
                  {preview.policy === "keep-valid-and-flag-missing" ? (
                    <>
                      {preview.retainedItemIds.length} stop
                      {preview.retainedItemIds.length === 1 ? "" : "s"} kept and flagged.
                      Those places can no longer be offered as alternatives elsewhere in
                      the trip. No travel times are cleared for them.
                    </>
                  ) : (
                    <>
                      {preview.unavailableItemIds.length} stop
                      {preview.unavailableItemIds.length === 1 ? "" : "s"} become open
                      slots, their map markers disappear, and{" "}
                      {preview.invalidatedLegIds.length} travel time
                      {preview.invalidatedLegIds.length === 1 ? "" : "s"} are cleared.
                    </>
                  )}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="text-ink-muted">
          Every place your trip uses is still in the new search, so your itinerary is
          unaffected.
        </p>
      )}

      {selected && selected.removedBackupIds.length > 0 ? (
        <p className="text-ink-muted">
          {selected.removedBackupIds.length} backup
          {selected.removedBackupIds.length === 1 ? "" : "s"} will be removed, because{" "}
          {selected.removedBackupIds.length === 1 ? "its place is" : "their places are"}{" "}
          no longer in the search.
        </p>
      ) : null}

      {selected?.accommodationMissing ? (
        <p data-testid="refresh-accommodation-missing" className="text-ink">
          {policy === "keep-valid-and-flag-missing"
            ? "Your recommended place to stay is kept and flagged."
            : "Your recommended place to stay will be removed from this trip."}
        </p>
      ) : null}

      {state.warnings.map((warning, index) => (
        <p key={`${warning.code}-${index}`} className="text-ink-muted">
          {warning.message}
        </p>
      ))}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          data-testid="refresh-apply"
          onClick={onApply}
        >
          Use these places
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Discard this search
        </Button>
      </div>
      <p className="text-ink-muted">
        Nothing has been saved yet. Discarding leaves your trip exactly as it is.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt>{label}</dt>
      <dd
        className="font-medium tabular-nums text-ink"
        {...(testId ? { "data-testid": testId } : {})}
      >
        {value}
      </dd>
    </div>
  );
}
