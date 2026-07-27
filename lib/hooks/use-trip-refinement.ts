"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef } from "react";

import {
  RefineTripResponseSchema,
  type RefineTripResponse,
} from "@/lib/api/refine-contract";
import { SSE_EVENT } from "@/lib/api/generate-contract";
import {
  TripRoutingResponseSchema,
} from "@/lib/api/trip-routing-contract";
import { derivePlanPlacePool, planRoutingPolicy } from "@/lib/plan";
import { REFINEMENT_ACTION_LABELS } from "@/lib/refinement/commands";
import type {
  AiRefinementCommand,
  TripRefinementCommand,
} from "@/lib/refinement/commands";
import { selectRetryLegs } from "@/lib/refinement/invalidate-routes";
import {
  applyHoursAdjustTime,
  applyHoursMarkUnavailable,
  applyHoursReplacePlace,
} from "@/lib/refinement/resolve-hours";
import {
  costProfileProvenance,
  reestimatePlanCosts,
} from "@/lib/refinement/reestimate";
import type {
  RefinementStage,
  RefinementSummary,
} from "@/lib/refinement/types";
import type { RefinementActionType } from "@/lib/refinement/commands";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";
import {
  useRefinementJob,
  useRefinementJobStore,
} from "@/lib/store/refinement-job-store";
import {
  describeSaveFailure,
  useTripRecord,
  useTripStore,
} from "@/lib/store/trip-store";

/**
 * The refinement workflow, from the browser's side.
 *
 * ## The transaction, and where each action goes
 *
 * The four AI actions go to `POST /api/trips/refine`; `retry-routes` goes to
 * `POST /api/trips/route` with `retryLegIds`. That split is not an implementation
 * detail leaking — it is the boundary: one needs a planner, the other needs the
 * routing provider, and they have different duration budgets and different failure
 * vocabularies. A traveller sees one "Refine" surface; the requests are honest about
 * which service they are asking.
 *
 * Both follow the same three steps, identical to routing and generation:
 *
 *  1. read the record and **capture its revision**
 *  2. send it away; nothing is written while the request is in flight
 *  3. save under that revision — the store refuses if it moved
 *
 * A cancelled, refused or rejected refinement therefore writes nothing at all, and the
 * saved trip is not restored but *never changed*.
 *
 * ## Which legs a retry asks for
 *
 * Computed in the browser by `selectRetryLegs`, from the plan the traveller is looking
 * at — so "retry the failures" means the failures they can see. The server filters the
 * ids against the plan's expected set again, because a browser's plan is a few seconds
 * old and an id that no longer describes an adjacency must not become a request.
 *
 * ## No automatic requests
 *
 * Nothing fires on mount or on render. The in-flight guard is a ref rather than derived
 * state for the reason the other hooks document: React has not re-rendered when a second
 * click lands in the same tick, so `disabled` alone would let a double-click through.
 */
export function useTripRefinement(tripId: string) {
  const record = useTripRecord(tripId);
  const applyRefinement = useTripStore((state) => state.applyRefinement);
  const undoStep = useTripStore((state) => state.undo);
  const redoStep = useTripStore((state) => state.redo);
  const saveEnrichedPlan = useTripStore((state) => state.saveEnrichedPlan);
  const setJob = useRefinementJobStore((state) => state.setJob);
  const resetJob = useRefinementJobStore((state) => state.resetJob);
  const job = useRefinementJob(tripId);

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);

  const dismiss = useCallback(() => resetJob(tripId), [resetJob, tripId]);

  /* -- the four AI actions --------------------------------------------------- */

  const refine = useCallback(
    async (command: AiRefinementCommand, options: { targetId?: string } = {}) => {
      if (inFlight.current) return;

      const current = record;
      if (!current) return;

      /**
       * A refinement needs the retained pool, so a trip without a generation context
       * cannot be refined. That is the sample trip and anything saved before Phase 5B
       * — the derived pool would be the plan vouching for itself, which is exactly the
       * check this phase must not weaken.
       */
      if (!current.generation) {
        setJob(tripId, {
          status: "error",
          action: command.type,
          message:
            "This trip has no saved place search behind it, so its stops cannot be verified against one. Only trips generated since place discovery was added can be refined.",
        });
        return;
      }

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      // Captured *before* the await. A value read afterwards would compare the record
      // to itself and guard nothing.
      const expectedRevision = current.revision;
      const requestId = nanoid(12);

      setJob(tripId, {
        status: "running",
        action: command.type,
        stage: null,
        startedAt: new Date().toISOString(),
        ...(options.targetId ? { targetId: options.targetId } : {}),
      });

      try {
        const response = await fetch("/api/trips/refine", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            plan: current.plan,
            generation: current.generation,
            command,
            providerPreference: "auto",
            expectedRevision,
            requestId,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const json: unknown = await response.json().catch(() => null);
          setJob(tripId, {
            status: "error",
            action: command.type,
            message: readApiError(json),
          });
          return;
        }

        const result = await readRefinementStream({
          response,
          onStage: (stage) =>
            setJob(tripId, {
              status: "running",
              action: command.type,
              stage,
              startedAt: new Date().toISOString(),
              ...(options.targetId ? { targetId: options.targetId } : {}),
            }),
        });

        if (!result || result.requestId !== requestId) {
          setJob(tripId, {
            status: "error",
            action: command.type,
            message: "That change ended without a result. Your trip is unchanged.",
          });
          return;
        }

        if (result.status === "refused") {
          setJob(tripId, {
            status: "error",
            action: command.type,
            message: result.userMessage,
          });
          return;
        }
        if (result.status === "unavailable" || result.status === "failed") {
          setJob(tripId, {
            status: "error",
            action: command.type,
            message: result.userMessage,
          });
          return;
        }

        // One guarded write, capturing the previous plan as the undo snapshot.
        const saved = applyRefinement({
          tripId,
          expectedRevision: result.expectedRevision,
          plan: result.plan,
          generation: result.generationContext,
          action: REFINEMENT_ACTION_LABELS[command.type],
          /* A planner refinement can replace the pool, so its entry carries the context. */
          kind: "refinement",
        });

        if (!saved.ok) {
          setJob(tripId, {
            status: "conflict",
            action: command.type,
            message: describeSaveFailure(saved),
          });
          return;
        }

        const summary = { ...result.summary, revisionAfter: saved.revision };
        setJob(
          tripId,
          result.warnings.length === 0
            ? { status: "success", action: command.type, summary }
            : {
                status: "partial",
                action: command.type,
                summary,
                warnings: result.warnings,
              },
        );
      } catch (error) {
        if (controller.signal.aborted) {
          // Nothing was written, so there is nothing to undo — the trip stands.
          resetJob(tripId);
          return;
        }
        setJob(tripId, {
          status: "error",
          action: command.type,
          message:
            error instanceof Error
              ? "Could not reach the planner. Your trip is unchanged."
              : "Something went wrong. Your trip is unchanged.",
        });
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }
    },
    [applyRefinement, record, resetJob, setJob, tripId],
  );

  /* -- targeted route retry (no planner involved) --------------------------- */

  const retryRoutes = useCallback(
    async (
      command: Extract<TripRefinementCommand, { type: "retry-routes" }>,
    ) => {
      if (inFlight.current) return;

      const current = record;
      if (!current) return;

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      const expectedRevision = current.revision;
      const policy =
        current.generation?.routingPolicy ??
        current.plan.routing?.policy ??
        planRoutingPolicy();

      /**
       * Which legs to ask about, decided from the plan on screen.
       *
       * An empty selection is a real outcome, not an error: "retry the failures" on a
       * trip with no failures has nothing to do, and issuing a whole-trip reroute
       * instead would be the opposite of what was asked.
       */
      const selection = selectRetryLegs({
        plan: current.plan,
        policy,
        scope: command.scope,
        ...(command.dayNumber !== undefined ? { dayNumber: command.dayNumber } : {}),
        ...(command.legIds ? { legIds: command.legIds } : {}),
      });

      if (selection.legIds.length === 0) {
        inFlight.current = false;
        abortRef.current = null;
        setJob(tripId, {
          status: "error",
          action: "retry-routes",
          message:
            command.scope === "unavailable-only"
              ? "There are no unavailable routes to retry on this trip."
              : "This trip has no routes to calculate yet.",
        });
        return;
      }

      setJob(tripId, {
        status: "running",
        action: "retry-routes",
        stage: null,
        startedAt: new Date().toISOString(),
        ...(command.legIds?.length === 1 ? { targetId: command.legIds[0] } : {}),
      });

      try {
        const placePool =
          current.generation?.placePool ?? derivePlanPlacePool(current.plan);

        const response = await fetch("/api/trips/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan: current.plan,
            placePool,
            policy,
            expectedRevision,
            // The narrowing that makes this a retry rather than a reroute.
            retryLegIds: selection.legIds,
          }),
          signal: controller.signal,
        });

        const json: unknown = await response.json();

        if (!response.ok) {
          setJob(tripId, {
            status: "error",
            action: "retry-routes",
            message: readApiError(json),
          });
          return;
        }

        const parsed = TripRoutingResponseSchema.safeParse(json);
        if (!parsed.success || parsed.data.status === "failed") {
          setJob(tripId, {
            status: "error",
            action: "retry-routes",
            message:
              "Routing produced a result we could not verify, so nothing was saved.",
          });
          return;
        }

        /**
         * `saveEnrichedPlan`, not `applyRefinement`: a route calculation adds provider
         * facts and does not consume the undo slot. See `trip-record.ts`.
         */
        const saved = saveEnrichedPlan({
          tripId,
          expectedRevision: parsed.data.expectedRevision,
          plan: parsed.data.plan,
        });

        if (!saved.ok) {
          setJob(tripId, {
            status: "conflict",
            action: "retry-routes",
            message: describeSaveFailure(saved),
          });
          return;
        }

        setJob(tripId, {
          status: "success",
          action: "retry-routes",
          summary: {
            action: "retry-routes",
            changedItemIds: [],
            addedItemIds: [],
            removedItemIds: [],
            preservedItemIds: [],
            invalidatedLegIds: [],
            affectedDays:
              command.dayNumber !== undefined ? [command.dayNumber] : [],
            previousEstimatedTotal: current.plan.budget.total,
            newEstimatedTotal: parsed.data.plan.budget.total,
            revisionBefore: expectedRevision,
            revisionAfter: saved.revision,
          },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          resetJob(tripId);
          return;
        }
        setJob(tripId, {
          status: "error",
          action: "retry-routes",
          message:
            error instanceof Error
              ? "Could not reach the routing service. Your trip is unchanged."
              : "Something went wrong calculating routes.",
        });
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }
    },
    [record, resetJob, saveEnrichedPlan, setJob, tripId],
  );

  /* -- the deterministic actions (no request at all) ------------------------ */

  /**
   * Applies a locally-computed plan under the same three-step transaction.
   *
   * No `fetch`, no stream, no provider — but the *same* guarded write, the same undo
   * snapshot and the same conflict handling as a refinement that crossed a network. That
   * matters: "it was computed locally" is not a reason for a change to be less careful
   * about the record moving underneath it, and a second tab can still have moved it.
   */
  const applyLocal = useCallback(
    (input: {
      action: RefinementActionType;
      outcome:
        | { ok: true; plan: TripPlan; message: string }
        | { ok: false; error: { message: string } };
      generation?: TripGenerationContext;
      targetId?: string;
      summary?: Partial<RefinementSummary>;
    }) => {
      if (inFlight.current) return;

      const current = record;
      if (!current) return;

      if (!input.outcome.ok) {
        setJob(tripId, {
          status: "error",
          action: input.action,
          message: input.outcome.error.message,
        });
        return;
      }

      const expectedRevision = current.revision;

      const saved = applyRefinement({
        tripId,
        expectedRevision,
        plan: input.outcome.plan,
        // Unchanged unless the action has provenance to record.
        generation: input.generation ?? current.generation!,
        action: REFINEMENT_ACTION_LABELS[input.action],
        /*
         * `refinement` rather than `structural-edit`, even for the deterministic repairs that come
         * through here: `input.generation` may carry new provenance, and an entry that omitted the
         * context could not put that back.
         */
        kind: "refinement",
      });

      if (!saved.ok) {
        setJob(tripId, {
          status: "conflict",
          action: input.action,
          message: describeSaveFailure(saved),
        });
        return;
      }

      setJob(tripId, {
        status: "success",
        action: input.action,
        ...(input.targetId ? { targetId: input.targetId } : {}),
        message: input.outcome.message,
        summary: {
          action: input.action,
          changedItemIds: [],
          addedItemIds: [],
          removedItemIds: [],
          preservedItemIds: [],
          invalidatedLegIds: [],
          affectedDays: [],
          previousEstimatedTotal: current.plan.budget.total,
          newEstimatedTotal: input.outcome.plan.budget.total,
          revisionBefore: expectedRevision,
          revisionAfter: saved.revision,
          ...input.summary,
        },
      });
    },
    [applyRefinement, record, setJob, tripId],
  );

  /** One of the three repairs for a stop the published hours contradict. */
  const resolveHoursConflict = useCallback(
    (input: {
      dayNumber: number;
      itemId: string;
      resolution:
        | { kind: "adjust-time" }
        | { kind: "replace-place"; placeId: string }
        | { kind: "mark-unavailable" };
    }) => {
      const current = record;
      if (!current) return;

      const timezone = current.generation?.destinationTimezone?.timezone ?? null;

      const outcome =
        input.resolution.kind === "adjust-time"
          ? applyHoursAdjustTime({
              plan: current.plan,
              dayNumber: input.dayNumber,
              itemId: input.itemId,
              timezone,
            })
          : input.resolution.kind === "replace-place"
            ? applyHoursReplacePlace({
                plan: current.plan,
                generation: current.generation ?? null,
                dayNumber: input.dayNumber,
                itemId: input.itemId,
                placeId: input.resolution.placeId,
              })
            : applyHoursMarkUnavailable({
                plan: current.plan,
                dayNumber: input.dayNumber,
                itemId: input.itemId,
              });

      applyLocal({
        action: "resolve-hours-conflict",
        targetId: input.itemId,
        outcome,
        summary: {
          changedItemIds: [input.itemId],
          affectedDays: [input.dayNumber],
        },
      });
    },
    [applyLocal, record],
  );

  /**
   * Recompute every cost estimate against the destination's current profile.
   *
   * The one deterministic action that *does* update the generation context, because the
   * figures it writes were produced by a profile whose id and version the trip should
   * record — otherwise a later comparison would have nothing to compare against.
   */
  const recalculateEstimates = useCallback(() => {
    const current = record;
    if (!current) return;

    const outcome = reestimatePlanCosts({
      plan: current.plan,
      generation: current.generation ?? null,
    });

    applyLocal({
      action: "recalculate-estimates",
      outcome,
      ...(outcome.ok && current.generation
        ? {
            generation: {
              ...current.generation,
              costProfile: costProfileProvenance(outcome.profile),
            },
          }
        : {}),
      ...(outcome.ok
        ? { summary: { changedItemIds: outcome.changedItemIds } }
        : {}),
    });
  }, [applyLocal, record]);

  /* -- undo (no request at all) --------------------------------------------- */

  const undo = useCallback(() => {
    const current = record;
    if (!current || inFlight.current) return;

    const outcome = undoStep({
      tripId,
      expectedRevision: current.revision,
    });

    if (outcome.ok) {
      resetJob(tripId);
      return;
    }

    setJob(tripId, {
      status: "conflict" in outcome ? "conflict" : "error",
      action: "regenerate-trip",
      message:
        "conflict" in outcome
          ? "This trip changed in another tab, so it was not put back. Reload and try again."
          : "There is no earlier version of this trip to go back to.",
    });
  }, [record, resetJob, setJob, tripId, undoStep]);

  /**
   * Forward again, through the same guard.
   *
   * A near-copy of `undo` rather than a shared helper taking a direction: the two differ in the
   * store action and in one sentence of failure text, and a shared version would spend more lines
   * threading that difference through than the duplication costs.
   */
  const redo = useCallback(() => {
    const current = record;
    if (!current || inFlight.current) return;

    const outcome = redoStep({
      tripId,
      expectedRevision: current.revision,
    });

    if (outcome.ok) {
      resetJob(tripId);
      return;
    }

    setJob(tripId, {
      status: "conflict" in outcome ? "conflict" : "error",
      action: "regenerate-trip",
      message:
        "conflict" in outcome
          ? "This trip changed in another tab, so it was not moved forward. Reload and try again."
          : "There is no later version of this trip to go forward to.",
    });
  }, [record, redoStep, resetJob, setJob, tripId]);

  return {
    job,
    refine,
    retryRoutes,
    resolveHoursConflict,
    recalculateEstimates,
    undo,
    redo,
    cancel,
    dismiss,
    isRunning: job.status === "running",
    revision: record?.revision ?? null,
    canRefine: record?.generation != null,
    /**
     * Actual depth, never the maximum.
     *
     * Both history bounds are real — a long routed trip reaches the byte budget well before twenty
     * entries — so a control promising twenty would run out earlier than it said. The panel is
     * given the counts and the labels and states what is genuinely there.
     */
    undoableAction: record?.history.past.at(-1)?.label ?? null,
    redoableAction: record?.history.future[0]?.label ?? null,
    undoDepth: record?.history.past.length ?? 0,
    redoDepth: record?.history.future.length ?? 0,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Reads the refinement stream: progress events, then one result.
 *
 * The same minimal SSE framing the generation hook parses, and the same rule — the
 * result is validated in full before it is returned, so no partially parsed plan ever
 * exists in the browser. A non-streaming response is handled too, because the route
 * serves JSON when the client does not ask for a stream.
 */
async function readRefinementStream(context: {
  response: Response;
  onStage: (stage: RefinementStage) => void;
}): Promise<RefineTripResponse | null> {
  const contentType = context.response.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    const json: unknown = await context.response.json();
    const parsed = RefineTripResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  const reader = context.response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let buffer = "";
  let result: RefineTripResponse | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      const parsed = parseFrame(frame);
      if (!parsed) continue;

      if (parsed.event === SSE_EVENT.progress) {
        const stage = readStage(parsed.data);
        if (stage) context.onStage(stage);
        continue;
      }
      if (parsed.event === SSE_EVENT.result) {
        const validated = RefineTripResponseSchema.safeParse(parsed.data);
        if (validated.success) result = validated.data;
      }
    }
  }

  return result;
}

function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "message";
  const dataLines: string[] = [];

  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }

  if (dataLines.length === 0) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) as unknown };
  } catch {
    return null;
  }
}

function readStage(data: unknown): RefinementStage | null {
  if (data === null || typeof data !== "object") return null;
  const stage = (data as { stage?: unknown }).stage;
  return typeof stage === "string" ? (stage as RefinementStage) : null;
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
  return "That change failed. Your trip is unchanged.";
}
