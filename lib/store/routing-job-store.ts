"use client";

import { create } from "zustand";

import type { RoutingEnrichmentSummary } from "@/lib/schemas";

/**
 * Transient state for the "calculate real routes" action — deliberately **not**
 * persisted.
 *
 * A saved trip is a record of a trip, not of a browsing session. Persisting
 * `running`, a retry counter or a provider error message would mean a traveller
 * who closed the tab mid-request reopened it to find a spinner that no request
 * was behind, and a stored plan carrying an error string from three weeks ago.
 *
 * So: the plan is persisted, the *job* is not. Nothing in this store survives a
 * reload, and nothing in it reaches `TripPlan`.
 */

export type RoutingJobState =
  | { status: "idle" }
  | { status: "running"; startedAt: string }
  | { status: "success"; summary: RoutingEnrichmentSummary }
  | { status: "partial"; summary: RoutingEnrichmentSummary }
  | { status: "error"; message: string }
  /** The saved trip moved while we were routing. The work is discarded. */
  | { status: "conflict"; message: string };

type RoutingJobStore = {
  /** Keyed by trip id: two trips open in two tabs are two independent jobs. */
  jobs: Record<string, RoutingJobState>;
  setJob: (tripId: string, state: RoutingJobState) => void;
  resetJob: (tripId: string) => void;
};

export const useRoutingJobStore = create<RoutingJobStore>()((set) => ({
  jobs: {},

  setJob: (tripId, state) =>
    set((current) => ({ jobs: { ...current.jobs, [tripId]: state } })),

  resetJob: (tripId) =>
    set((current) => {
      const next = { ...current.jobs };
      delete next[tripId];
      return { jobs: next };
    }),
}));

const IDLE: RoutingJobState = { status: "idle" };

export function useRoutingJob(tripId: string): RoutingJobState {
  return useRoutingJobStore((state) => state.jobs[tripId] ?? IDLE);
}
