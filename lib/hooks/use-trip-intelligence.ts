"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  persistableEntries,
  runEnrichmentWorkflow,
  type EnrichmentWorkflowResult,
} from "@/lib/api/enrich-workflow";
import type { EnrichTripPlacesRequest } from "@/lib/api/place-intelligence-contract";
import { selectLandmarkCandidates } from "@/lib/place-intelligence";
import type { SaveTripIntelligenceResult } from "@/lib/store/trip-intelligence";
import { useTripRecord, useTripStore } from "@/lib/store/trip-store";

/**
 * The "look up these landmarks" workflow.
 *
 * ## Nothing happens until somebody asks
 *
 * No request on mount, on render, on trip open, or on plan change. Wikimedia is volunteer-funded infrastructure and
 * enrichment is optional decoration, so the traveller has to press something — the rule `use-trip-routing.ts` follows for
 * the donated routing server, applied here for a stronger reason: routing is fast, and a serial enrichment pass takes
 * the better part of a minute.
 *
 * The in-flight guard is a ref rather than the rendered status, because React has not re-rendered when a second click
 * lands in the same tick and a disabled attribute alone would let it through.
 *
 * ## One action, many requests, one write
 *
 * `runEnrichmentWorkflow` may make up to three bounded HTTP calls — the server stops itself at its budget and reports
 * what it managed. All of them belong to one user action, and the store is written **once**, at the end, from whatever
 * the workflow accumulated.
 *
 * That ordering is the whole design. Saving after each call would leave a trip half-enriched if the second failed, and it
 * would make the number of server calls visible in the traveller's revision history. So:
 *
 *  - an **abort** saves nothing, whatever the earlier calls returned
 *  - a **stale revision** saves nothing, and says the trip changed elsewhere
 *  - a **storage refusal** saves nothing, and says to free some room
 *  - a **partial** result — some places answered, some not — saves once, because those answers are real
 *
 * ## `enrich` and `refresh` differ only in what they ask about
 *
 * `enrich` sends the candidates with no sidecar entry yet; `refresh` sends every candidate. Neither is a different
 * pipeline — the second is the first with the "already known" filter removed, for when a traveller thinks an entry is
 * wrong or stale.
 */

export type TripIntelligenceStatus =
  | "idle"
  | "running"
  | "done"
  | "unchanged"
  | "failed";

export type TripIntelligenceState = {
  status: TripIntelligenceStatus;
  /** How many places came back with facts. Reported after a save, from what was actually written. */
  matched: number;
  /** How many places Roamly still cannot say anything about. */
  unresolved: number;
  /** One sentence for the traveller, or `null`. Never a provider message. */
  message: string | null;
};

const IDLE: TripIntelligenceState = {
  status: "idle",
  matched: 0,
  unresolved: 0,
  message: null,
};

export function useTripIntelligence(tripId: string) {
  const record = useTripRecord(tripId);
  const saveTripIntelligence = useTripStore(
    (state) => state.saveTripIntelligence,
  );
  const clearTripIntelligence = useTripStore(
    (state) => state.clearTripIntelligence,
  );

  const [state, setState] = useState<TripIntelligenceState>(IDLE);

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  /*
   * Abort on unmount, so navigating away does not leave a serial run going against a volunteer service for a trip
   * nobody is looking at.
   */
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const run = useCallback(
    async (mode: "enrich" | "refresh") => {
      if (inFlight.current) return;

      const current = record;
      if (!current) return;

      /*
       * Which places to ask about, decided by the eligibility policy rather than here.
       *
       * `selectLandmarkCandidates` returns eligible places in itinerary-first order, capped at twelve. The route applies
       * both rules again — a bound in one place is a bound somebody can forget.
       */
      const candidates = selectLandmarkCandidates({
        plan: current.plan,
        pool: current.generation?.placePool ?? null,
      }).map((candidate) => candidate.place);

      const known = current.intelligence?.byCanonicalPlaceId ?? {};
      const places =
        mode === "refresh"
          ? candidates
          : candidates.filter((place) => !known[place.placeId]);

      if (places.length === 0) {
        setState({
          status: "unchanged",
          matched: 0,
          unresolved: 0,
          message:
            mode === "enrich" && candidates.length > 0
              ? "Every landmark in this trip has already been looked up."
              : "This trip has no landmarks to look up.",
        });
        return;
      }

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      /* The revision read *before* the first request. The store refuses the write if it moved. */
      const expectedRevision = current.revision;
      setState({ ...IDLE, status: "running" });

      /** The last non-2xx code, so a misconfigured deployment can be reported as itself. */
      let httpFailure: string | null = null;

      try {
        const result = await runEnrichmentWorkflow({
          places,
          expectedRevision,
          requestId: `enrich-${nanoid(12)}`,
          signal: controller.signal,
          post: async (request: EnrichTripPlacesRequest, signal) => {
            const response = await fetch("/api/place-intelligence/enrich", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(request),
              signal,
            });

            if (!response.ok) {
              const body = await response.json().catch(() => null);
              httpFailure = body?.error?.code ?? `http_${response.status}`;
              throw new Error("Enrichment request failed");
            }

            return response.json();
          },
        });

        if (result.stop === "aborted") {
          /* The traveller changed their mind. Nothing is written, even though earlier calls may have answered. */
          setState(IDLE);
          return;
        }

        const entries = persistableEntries(result);

        if (entries.length === 0) {
          setState({
            status: result.stop === "failed" ? "failed" : "unchanged",
            matched: 0,
            unresolved: result.unresolved,
            message: describeStop(result, httpFailure),
          });
          return;
        }

        /* The one write. Everything before this was in memory. */
        const saved = saveTripIntelligence({
          tripId,
          expectedRevision,
          entries,
          fetchedAt: new Date().toISOString(),
        });

        setState(describeSave(saved, result, httpFailure));
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }
    },
    [record, saveTripIntelligence, tripId],
  );

  const enrich = useCallback(() => run("enrich"), [run]);
  const refresh = useCallback(() => run("refresh"), [run]);

  /**
   * Forgets every landmark lookup for this trip.
   *
   * Its own guarded action rather than a mode of `run`, because it makes no provider request and needs no workflow — and
   * because "forget what you found" is a decision a traveller makes for its own reasons, most often after seeing an entry
   * they believe is wrong.
   */
  const clear = useCallback(() => {
    const current = record;
    if (!current || inFlight.current) return;

    const result = clearTripIntelligence({
      tripId,
      expectedRevision: current.revision,
    });

    setState(
      result.status === "saved"
        ? {
            status: "done",
            matched: 0,
            unresolved: 0,
            message: "Landmark details were removed from this trip.",
          }
        : describeSave(result, null, null),
    );
  }, [clearTripIntelligence, record, tripId]);

  return { ...state, enrich, refresh, clear, cancel } as const;
}

/**
 * What to tell the traveller about a run that wrote nothing.
 *
 * Every sentence explains rather than apologises, and none of them names a provider, a host or an HTTP status —
 * `failure` is our own code, produced by our own route.
 */
function describeStop(
  result: EnrichmentWorkflowResult,
  failure: string | null,
): string {
  if (failure === "provider_misconfigured") {
    return "Landmark details are not available on this deployment.";
  }
  if (result.stop === "provider-stopped") {
    return "Wikimedia asked us to slow down, so the lookup stopped. Try again later.";
  }
  if (result.stop === "failed") {
    return "The landmark lookup did not complete, so nothing was changed.";
  }
  return "No landmark details were found for this trip.";
}

/** The result of the one write, as a sentence and a status. */
function describeSave(
  saved: SaveTripIntelligenceResult,
  result: EnrichmentWorkflowResult | null,
  failure: string | null,
): TripIntelligenceState {
  const unresolved = result?.unresolved ?? 0;

  switch (saved.status) {
    case "saved":
      return {
        status: "done",
        matched: saved.matched,
        unresolved,
        message:
          unresolved > 0
            ? `Found details for ${saved.matched} ${plural(saved.matched)}. ${unresolved} could not be looked up — try again later.`
            : `Found details for ${saved.matched} ${plural(saved.matched)}.`,
      };
    case "unchanged":
      return {
        status: "unchanged",
        matched: 0,
        unresolved,
        message: "Nothing new was found, so the trip is unchanged.",
      };
    case "conflict":
      return {
        status: "failed",
        matched: 0,
        unresolved,
        message:
          "This trip changed in another tab, so nothing was saved. Reload and try again.",
      };
    case "missing-trip":
      return {
        status: "failed",
        matched: 0,
        unresolved,
        message:
          "This trip is no longer saved in this browser, so nothing was saved.",
      };
    case "storage-refused":
      return {
        status: "failed",
        matched: 0,
        unresolved,
        message: saved.reason,
      };
    case "invalid":
      return {
        status: "failed",
        matched: 0,
        unresolved,
        message: result
          ? describeStop(result, failure)
          : "The landmark details could not be saved.",
      };
  }
}

function plural(count: number): string {
  return count === 1 ? "place" : "places";
}
