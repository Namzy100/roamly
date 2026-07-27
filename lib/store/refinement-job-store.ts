"use client";

import { create } from "zustand";

import type {
  RefinementStage,
  RefinementSummary,
} from "@/lib/refinement/types";
import type { RefinementActionType } from "@/lib/refinement/commands";

/**
 * Transient state for a refinement in flight — deliberately **not** persisted.
 *
 * Same reasoning as `routing-job-store`: a saved trip is a record of a trip, not of a
 * browsing session. A persisted "running" flag would greet a traveller who closed the
 * tab mid-request with a spinner no request is behind.
 *
 * Keyed by trip id, so two trips in two tabs are two independent jobs.
 *
 * ## Why the action is part of the state
 *
 * The UI has to disable *conflicting* actions rather than all of them: while a stop is
 * being replaced, replacing a different stop must not start, but neither should the
 * whole panel go dead. Knowing which action is running is what makes that possible, and
 * it is also what lets the progress line say "Rebuilding the affected schedule" for a
 * day adjustment and "Recalculating route" for a retry.
 */

export type RefinementJobState =
  | { status: "idle" }
  | {
      status: "running";
      action: RefinementActionType;
      stage: RefinementStage | null;
      startedAt: string;
      /** Present for a per-item action, so that card can show its own spinner. */
      targetId?: string;
    }
  | {
      status: "success";
      action: RefinementActionType;
      summary: RefinementSummary;
      /**
       * A sentence about what changed, for the deterministic actions (Phase 6B).
       *
       * Those actions have no model behind them and no warnings to show, but they do have
       * something specific to say — "moved to 12:45, inside its published hours of
       * 10:00–18:00" is more useful than a generic "done", and the summary counts alone
       * cannot express it.
       */
      message?: string;
      /** Present for a per-item action, so that card can confirm its own change. */
      targetId?: string;
    }
  | {
      status: "partial";
      action: RefinementActionType;
      summary: RefinementSummary;
      warnings: { code: string; message: string }[];
    }
  | { status: "error"; action: RefinementActionType; message: string }
  /** The saved trip moved while we were working. The change is discarded. */
  | { status: "conflict"; action: RefinementActionType; message: string };

type RefinementJobStore = {
  jobs: Record<string, RefinementJobState>;
  setJob: (tripId: string, state: RefinementJobState) => void;
  resetJob: (tripId: string) => void;
};

export const useRefinementJobStore = create<RefinementJobStore>()((set) => ({
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

const IDLE: RefinementJobState = { status: "idle" };

export function useRefinementJob(tripId: string): RefinementJobState {
  return useRefinementJobStore((state) => state.jobs[tripId] ?? IDLE);
}

/** Re-exported so components import one module for the job and its labels. */
export type { RefinementActionType, RefinementStage, RefinementSummary };
