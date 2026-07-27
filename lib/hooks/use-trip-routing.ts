"use client";

import { useCallback, useEffect, useRef } from "react";

import {
  TripRoutingResponseSchema,
  type TripRoutingPolicyInput,
} from "@/lib/api/trip-routing-contract";
import { derivePlanPlacePool } from "@/lib/plan";
import { useRoutingJob, useRoutingJobStore } from "@/lib/store/routing-job-store";
import {
  describeSaveFailure,
  useTripRecord,
  useTripStore,
} from "@/lib/store/trip-store";

/**
 * The "calculate real routes" workflow.
 *
 * ## The transaction, such as it is
 *
 * Routing takes seconds and touches a shared server, so the write is guarded
 * rather than assumed:
 *
 *  1. read the current record and **capture its revision**
 *  2. send the plan to the server, which transforms and returns it
 *  3. save under that revision — the store refuses if it moved
 *
 * Nothing is written until step 3, and step 3 is one atomic replacement. There
 * is no window in which a half-routed plan is saved, and a conflict discards our
 * work rather than overwriting someone else's.
 *
 * ## No automatic requests
 *
 * This hook fires nothing on mount, on render, or on plan change. The provider
 * is a donated demo server and the traveller has to ask. That is also why the
 * in-flight guard is a ref rather than the store's `running` state: React has
 * not re-rendered when a second click lands in the same tick, so a disabled
 * attribute alone would let a double-click through.
 */
export function useTripRouting(tripId: string) {
  const record = useTripRecord(tripId);
  const saveEnrichedPlan = useTripStore((state) => state.saveEnrichedPlan);
  const setJob = useRoutingJobStore((state) => state.setJob);
  const resetJob = useRoutingJobStore((state) => state.resetJob);
  const job = useRoutingJob(tripId);

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Abort an in-flight request if the workspace unmounts, so a navigation away
  // does not leave a request running against the shared server for nothing.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const calculateRoutes = useCallback(
    async (policy?: TripRoutingPolicyInput) => {
      if (inFlight.current) return;

      const current = record;
      if (!current) return;

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      // Captured *before* the await. Comparing against a value read afterwards
      // would compare the record to itself and guard nothing.
      const expectedRevision = current.revision;

      setJob(tripId, { status: "running", startedAt: new Date().toISOString() });

      try {
        /**
         * The real discovery pool when the trip has one.
         *
         * This is the whole point of retaining it. `derivePlanPlacePool` builds a
         * pool from the places the plan already uses — the plan checking itself,
         * which would happily validate a fabricated place. A generated trip carries
         * the actual search result set, so routing is verified against what was
         * genuinely discovered, including the candidates the itinerary did not use.
         *
         * The derived pool is the **legacy fallback**, for the sample trip and for
         * anything saved before generation existed. It still does real work there —
         * it is what catches a routed leg attached to the wrong stop — and it is
         * honest in its own module about not proving provenance.
         */
        const placePool =
          current.generation?.placePool ?? derivePlanPlacePool(current.plan);

        /**
         * An explicit policy wins; otherwise the pace-derived policy recorded at
         * generation time. A trip generated as "relaxed" is routed under relaxed
         * walking thresholds however long afterwards the traveller asks.
         */
        const appliedPolicy = policy ?? current.generation?.routingPolicy;

        const response = await fetch("/api/trips/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            plan: current.plan,
            placePool,
            policy: appliedPolicy,
            expectedRevision,
          }),
          signal: controller.signal,
        });

        const json: unknown = await response.json();

        if (!response.ok) {
          setJob(tripId, { status: "error", message: readApiError(json) });
          return;
        }

        const parsed = TripRoutingResponseSchema.safeParse(json);
        if (!parsed.success) {
          setJob(tripId, {
            status: "error",
            message: "The routing response did not match the expected contract.",
          });
          return;
        }

        if (parsed.data.status === "failed") {
          setJob(tripId, {
            status: "error",
            message:
              "Routing produced a result we could not verify, so nothing was saved.",
          });
          return;
        }

        const saved = saveEnrichedPlan({
          tripId,
          expectedRevision: parsed.data.expectedRevision,
          plan: parsed.data.plan,
        });

        if (!saved.ok) {
          setJob(tripId, {
            status: "conflict",
            message: describeSaveFailure(saved),
          });
          return;
        }

        setJob(tripId, {
          status: parsed.data.status === "complete" ? "success" : "partial",
          summary: parsed.data.summary,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          resetJob(tripId);
          return;
        }
        setJob(tripId, {
          status: "error",
          message:
            error instanceof Error && error.message
              ? "Could not reach the routing service. Please try again."
              : "Something went wrong calculating routes.",
        });
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }
    },
    [record, resetJob, saveEnrichedPlan, setJob, tripId],
  );

  return {
    job,
    calculateRoutes,
    cancel,
    revision: record?.revision ?? null,
    isRunning: job.status === "running",
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
  return "Routing failed. Please try again.";
}
