"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  RefreshPoolResponseSchema,
  type RefreshPoolResponse,
} from "@/lib/api/refresh-pool-contract";
import type { StructuralEditCommand } from "@/lib/refinement/commands";
import {
  applyPoolRefresh,
  prepareStructuralCommand,
  verifyStructuralResult,
  type PlacePoolChangeSummary,
  type PreparedStructuralEdit,
  type ReconciliationPolicy,
  type ReconciliationPreview,
  type StructuralEditError,
  type StructuralEditSummary,
  type StructuralEditWarning,
} from "@/lib/structural-edits";
import type { DiscoverySummary, VerifiedPlacePool } from "@/lib/schemas";
import {
  describeSaveFailure,
  useTripRecord,
  useTripStore,
} from "@/lib/store/trip-store";

/**
 * Structural edits and pool refresh, from the browser's side.
 *
 * ## One entry point, not one callback per command
 *
 * Phase 6C had two structural edits and this hook grew a bespoke callback for each. Phase 8 has
 * nine commands and three ways to issue them — a card control, a drag, and a confirmed assistant
 * proposal — so nine callbacks would become twenty-seven hand-written paths, and the ones that
 * would drift are the ones written last: a drag handler that forgets to capture the revision, or a
 * proposal path that skips the membership re-check.
 *
 * So there is exactly one: `run(command)`. It captures the revision, prepares the edit through
 * `applyStructuralCommand`, and saves once under that revision. A new control cannot acquire its
 * own semantics — it can only build a command.
 *
 * ## The same transaction as everything else
 *
 * Read the record and **capture its revision**, compute in memory, save once under that revision.
 * The structural edits never leave the browser, and the refresh crosses a network only to *ask a
 * question* — the answer is applied locally. Either way a failure, a cancel or a conflict writes
 * nothing, and the saved trip is not restored afterwards but never touched.
 *
 * ## Why the refresh has two steps
 *
 * A refresh can strand a stop the itinerary is built on, and which of two policies is right
 * depends on what the traveller is willing to lose. Applying one and letting them undo would make
 * the destructive path the default; showing the diff first makes the decision theirs before
 * anything is written. The response carries a preview for *both* policies, so changing their mind
 * at the confirmation step costs nothing extra.
 *
 * ## Workflow state lives here, not in the plan
 *
 * A half-finished refresh is a fact about this browsing session. Persisting it would greet someone
 * who closed the tab with a preview no search is behind.
 */

export type StructuralWorkflowState =
  | { status: "idle" }
  | { status: "saving" }
  | {
      status: "success";
      summary: StructuralEditSummary;
      warnings: StructuralEditWarning[];
    }
  | { status: "error"; message: string }
  | { status: "conflict"; message: string };

/**
 * What one `run` did, returned to the caller that asked for it.
 *
 * Returned *as well as* mirrored into `edit`, because the two answer different questions. The state
 * is what the panel renders; this is what the caller acts on — a dialog that should close, a focus
 * that should move, an optimistic control that should settle. Reading an outcome out of a state
 * transition means waiting a render to find out what happened, which is how a dialog ends up
 * closing on the *previous* edit's success.
 *
 * Four arms rather than success-or-failure, because the advice differs. `refused` means the edit
 * itself does not hold and the message says why — that is actionable. `conflict` means the edit was
 * fine and the record moved underneath it, so the answer is to reload. `unavailable` means nothing
 * was even attempted.
 */
export type StructuralEditRunResult =
  | {
      status: "saved";
      summary: StructuralEditSummary;
      warnings: StructuralEditWarning[];
      revision: number;
    }
  | { status: "refused"; message: string; errors: StructuralEditError[] }
  | { status: "conflict"; message: string }
  | { status: "unavailable"; message: string };

export type PoolRefreshWorkflowState =
  | { status: "idle" }
  /** The traveller has asked; the consequences are being explained. */
  | { status: "confirming" }
  | { status: "refreshing" }
  | {
      status: "preview";
      pool: VerifiedPlacePool;
      discoverySummary: DiscoverySummary;
      changes: PlacePoolChangeSummary;
      previews: ReconciliationPreview[];
      partial: boolean;
      warnings: { code: string; message: string }[];
      expectedRevision: number;
    }
  | { status: "applying" }
  | {
      status: "applied";
      summary: StructuralEditSummary;
      warnings: StructuralEditWarning[];
    }
  | { status: "error"; message: string }
  | { status: "conflict"; message: string };

/**
 * A trip with no generation context has no pool, so no structural edit can be verified against one.
 *
 * Phrased as a fact about the trip rather than as a failure, because it is one: the fixed sample and
 * anything saved before generation existed are in this state permanently, and no retry helps.
 */
const NO_CONTEXT = {
  status: "unavailable",
  message: "This trip has no saved place search, so it cannot be edited.",
} as const satisfies StructuralEditRunResult;

/**
 * A pool refresh is mid-flight.
 *
 * Refused rather than queued: the refresh will write under the revision it captured, and an edit
 * landing in between would turn that write into a conflict — reporting a failure for something the
 * traveller did nothing wrong in.
 */
const BUSY = {
  status: "unavailable",
  message: "Another change is still finishing. Try again in a moment.",
} as const satisfies StructuralEditRunResult;

export function useStructuralEdits(tripId: string) {
  /**
   * Subscribed for `revision`, which callers render.
   *
   * Deliberately *not* what `run` reads — see the fresh read inside it.
   */
  const record = useTripRecord(tripId);
  const applyRefinement = useTripStore((state) => state.applyRefinement);

  const [edit, setEdit] = useState<StructuralWorkflowState>({ status: "idle" });
  const [refresh, setRefresh] = useState<PoolRefreshWorkflowState>({
    status: "idle",
  });

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  /* -- saving a locally-computed result ------------------------------------- */

  /**
   * The one guarded write every structural path goes through.
   *
   * Takes an already-verified edit, so the decision about whether it *may* be stored was made in
   * `lib/structural-edits/prepare.ts` where it is testable. All that is left here is the write and
   * what to call the outcome.
   */
  const commit = useCallback(
    (
      prepared: PreparedStructuralEdit,
      expectedRevision: number,
    ): StructuralEditRunResult => {
      if (prepared.status === "refused") {
        return {
          status: "refused",
          message: prepared.message,
          errors: prepared.errors,
        };
      }

      const saved = applyRefinement({
        tripId,
        expectedRevision,
        plan: prepared.plan,
        generation: prepared.generationContext,
        action: prepared.label,
        /*
         * Read from what the applier *did*, not from the command that asked for it.
         *
         * The kind decides whether the generation context is stored alongside the plan in the
         * history entry, and a pool refresh is the one path here that changes it. Deriving that
         * from `summary.action` keeps the two in step: a new applier gets the right answer by
         * being honest about its own action rather than by remembering to update a second list.
         */
        kind:
          prepared.summary.action === "refresh-place-pool"
            ? "pool-refresh"
            : "structural-edit",
      });

      if (!saved.ok) {
        return { status: "conflict", message: describeSaveFailure(saved) };
      }

      return {
        status: "saved",
        summary: { ...prepared.summary, revisionAfter: saved.revision },
        warnings: prepared.warnings,
        revision: saved.revision,
      };
    },
    [applyRefinement, tripId],
  );

  /* -- the single execution path -------------------------------------------- */

  /**
   * One command in, one outcome out.
   *
   * ## Why the record is read fresh rather than from the render
   *
   * `useTripRecord` gives the record as of the last render, and two `run` calls in the same tick
   * would both capture the same revision — making the second a conflict over an edit that had
   * already succeeded. Reading `getState()` at call time means sequential edits each see the
   * previous one's revision, so `await run(a); await run(b)` does what it reads like. The guard
   * still protects against the case it exists for: another tab.
   *
   * A stable identity falls out of that, which is what makes this safe to hand to a memoised child.
   *
   * ## Async, for a computation that is synchronous today
   *
   * Every structural command is arithmetic over data the browser already holds. The promise is
   * about the *call site*: a control awaits the outcome to decide whether to close, and that should
   * not have to change if an edit ever needs to ask something first.
   */
  const run = useCallback(
    async (command: StructuralEditCommand): Promise<StructuralEditRunResult> => {
      if (inFlight.current) return BUSY;

      const current = useTripStore.getState().records[tripId];
      if (!current?.generation) return NO_CONTEXT;

      setEdit({ status: "saving" });

      const prepared = prepareStructuralCommand({
        plan: current.plan,
        generation: current.generation,
        revisionBefore: current.revision,
        timezone: current.generation.destinationTimezone?.timezone ?? null,
        command,
      });

      const outcome = commit(prepared, current.revision);
      setEdit(editStateFor(outcome));
      return outcome;
    },
    [commit, tripId],
  );

  /**
   * What an edit *would* do, without doing it.
   *
   * The same function `run` commits, stopped one step short — so what a preview shows and what a
   * save stores cannot disagree. Nothing is written and no state moves, which is what lets a time
   * editor re-derive on every keystroke.
   */
  const preview = useCallback(
    (command: StructuralEditCommand): PreparedStructuralEdit => {
      const current = useTripStore.getState().records[tripId];

      if (!current?.generation) {
        return {
          status: "refused",
          errors: [
            { code: "generation_context_missing", message: NO_CONTEXT.message },
          ],
          message: NO_CONTEXT.message,
        };
      }

      return prepareStructuralCommand({
        plan: current.plan,
        generation: current.generation,
        revisionBefore: current.revision,
        timezone: current.generation.destinationTimezone?.timezone ?? null,
        command,
      });
    },
    [tripId],
  );

  const dismissEdit = useCallback(() => setEdit({ status: "idle" }), []);

  /* -- pool refresh, step one: ask ------------------------------------------ */

  const beginRefresh = useCallback(
    () => setRefresh({ status: "confirming" }),
    [],
  );

  const cancelRefresh = useCallback(() => {
    abortRef.current?.abort();
    setRefresh({ status: "idle" });
  }, []);

  /**
   * Step two: run the search.
   *
   * Nothing is written. A cancel here, a timeout, or a provider failure all leave the trip
   * exactly as it was — the only cost is one Overpass search that the traveller asked for.
   */
  const runRefresh = useCallback(
    async (options: { policy: ReconciliationPolicy }) => {
      const current = useTripStore.getState().records[tripId];
      if (!current?.generation || inFlight.current) return;

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      const requestId = nanoid(12);
      setRefresh({ status: "refreshing" });

      try {
        const response = await fetch("/api/trips/refresh-pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan: current.plan,
            generation: current.generation,
            reconciliation: options.policy,
            expectedRevision: current.revision,
            requestId,
          }),
          signal: controller.signal,
        });

        const json: unknown = await response.json();

        if (!response.ok) {
          setRefresh({ status: "error", message: readApiError(json) });
          return;
        }

        const parsed = RefreshPoolResponseSchema.safeParse(json);
        if (!parsed.success) {
          setRefresh({
            status: "error",
            message:
              "The refreshed place search came back in a form we could not verify, so nothing was changed.",
          });
          return;
        }

        if (parsed.data.status === "failed") {
          setRefresh({ status: "error", message: parsed.data.userMessage });
          return;
        }

        setRefresh(previewFrom(parsed.data));
      } catch (error) {
        if (controller.signal.aborted) {
          // Nothing was written, so there is nothing to undo — the trip stands.
          setRefresh({ status: "idle" });
          return;
        }
        setRefresh({
          status: "error",
          message:
            error instanceof Error
              ? "Could not reach the place search. Your trip is unchanged."
              : "Something went wrong. Your trip is unchanged.",
        });
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }
    },
    [tripId],
  );

  /**
   * Step three: apply the policy the traveller chose.
   *
   * Pure and local. The reconciliation that runs here is the same function the preview was
   * computed from, so what the dialog showed is what happens.
   *
   * Not a `StructuralEditCommand`, and so not a `run`: a refresh needs a provider, which is exactly
   * what the command vocabulary excludes. It shares the two things that matter — the same
   * verification gate and the same guarded write.
   */
  const applyRefresh = useCallback(
    (policy: ReconciliationPolicy) => {
      const current = useTripStore.getState().records[tripId];
      if (!current?.generation) return;
      if (refresh.status !== "preview") return;

      /**
       * The revision is re-read, not taken from the response.
       *
       * The search took seconds and another tab may have moved the record. Using the echoed
       * token would guard against nothing.
       */
      if (current.revision !== refresh.expectedRevision) {
        setRefresh({
          status: "conflict",
          message:
            "This trip changed while the search was running, so the refresh was discarded. Reload and try again.",
        });
        return;
      }

      setRefresh({ status: "applying" });

      const prepared = verifyStructuralResult(
        applyPoolRefresh({
          plan: current.plan,
          generation: current.generation,
          revisionBefore: current.revision,
          timezone: current.generation.destinationTimezone?.timezone ?? null,
          nextPool: refresh.pool,
          changes: refresh.changes,
          discoverySummary: refresh.discoverySummary,
          policy,
          now: new Date().toISOString(),
        }),
      );

      const outcome = commit(prepared, current.revision);

      if (outcome.status === "saved") {
        setRefresh({
          status: "applied",
          summary: outcome.summary,
          warnings: outcome.warnings,
        });
        return;
      }

      setRefresh(
        outcome.status === "conflict"
          ? { status: "conflict", message: outcome.message }
          : { status: "error", message: outcome.message },
      );
    },
    [commit, refresh, tripId],
  );

  const dismissRefresh = useCallback(() => setRefresh({ status: "idle" }), []);

  return {
    edit,
    refresh,
    /** The single execution path. Every control builds a command and calls this. */
    run,
    preview,
    dismissEdit,
    beginRefresh,
    runRefresh,
    applyRefresh,
    cancelRefresh,
    dismissRefresh,
    isBusy:
      edit.status === "saving" ||
      refresh.status === "refreshing" ||
      refresh.status === "applying",
    revision: record?.revision ?? null,
  };
}

/**
 * The outcome, as the panel renders it.
 *
 * `refused` and `unavailable` both read as an error to the interface — there is one place for a
 * sentence explaining why nothing happened — while staying distinct to the caller, which may want
 * to keep a dialog open for one and not for the other.
 */
function editStateFor(
  outcome: StructuralEditRunResult,
): StructuralWorkflowState {
  switch (outcome.status) {
    case "saved":
      return {
        status: "success",
        summary: outcome.summary,
        warnings: outcome.warnings,
      };
    case "conflict":
      return { status: "conflict", message: outcome.message };
    case "refused":
    case "unavailable":
      return { status: "error", message: outcome.message };
  }
}

function previewFrom(
  response: Extract<RefreshPoolResponse, { status: "ok" }>,
): PoolRefreshWorkflowState {
  return {
    status: "preview",
    pool: response.pool,
    discoverySummary: response.discoverySummary,
    changes: response.changes,
    previews: response.previews as ReconciliationPreview[],
    partial: response.partial,
    warnings: response.warnings.map((warning) => ({
      code: warning.code,
      message: warning.message,
    })),
    expectedRevision: response.expectedRevision,
  };
}

function readApiError(json: unknown): string {
  if (
    json !== null &&
    typeof json === "object" &&
    "error" in json &&
    typeof (json as { error?: { message?: unknown } }).error?.message === "string"
  ) {
    return (json as { error: { message: string } }).error.message;
  }
  return "That refresh failed. Your trip is unchanged.";
}
