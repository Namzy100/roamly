"use client";

import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  AiStatusResponseSchema,
  GenerateTripResponseSchema,
  SSE_EVENT,
  type AiProviderPreferenceInput,
  type AiStatusResponse,
  type GenerateTripResponse,
} from "@/lib/api/generate-contract";
import {
  GeocodeResponseSchema,
  type GeocodeResponse,
} from "@/lib/api/places-contract";
import type { GenerationStage } from "@/lib/generate/types";
import type {
  GeocodedDestinationRecord,
  GenerationWarning,
  TripRequest,
} from "@/lib/schemas";
import { useTripStore } from "@/lib/store/trip-store";

/**
 * The generation workflow, as the browser sees it.
 *
 * ## Why geocoding is a separate, visible step
 *
 * "Lisbon" is two cities, and one of them is in Ohio. The provider layer refuses to
 * pick — `geocodeDestination` deliberately exports no "best match" helper — because
 * choosing is a product decision with the traveller sitting right there. So the flow
 * is: resolve candidates, let them choose, and only then generate. Everything
 * downstream can then guarantee that no coordinate in the finished plan came from a
 * model, because the one that matters was chosen by a person from a geocoder's list.
 *
 * ## The transaction
 *
 * Identical in shape to `use-trip-routing`, and for the same reason — a multi-second
 * operation against a shared service:
 *
 *  1. nothing is written until the whole result has arrived and parsed
 *  2. the plan and its pool are saved in **one** store call, at revision 1
 *  3. a cancelled or failed run writes nothing at all
 *
 * ## No automatic requests
 *
 * Nothing fires on mount except the provider-status read, which touches no provider
 * and exists solely so the interface can avoid offering a model that is not there.
 * Generation is always an explicit click. The in-flight guard is a ref rather than
 * derived state because React has not re-rendered when a second click lands in the
 * same tick, so a `disabled` attribute alone would let a double-click through — the
 * same trap the routing hook documents.
 */

export type GenerationPhase =
  | { status: "idle" }
  | { status: "geocoding" }
  | {
      status: "choosing";
      candidates: GeocodedDestinationRecord[];
      /** Pre-selected when the geocoder returned exactly one match. */
      selected: GeocodedDestinationRecord | null;
    }
  | { status: "generating"; stage: GenerationStage; provider: string }
  | { status: "done"; tripId: string; warnings: GenerationWarning[] }
  | { status: "refused"; message: string }
  | { status: "error"; message: string; retryable: boolean };

export function useTripGeneration() {
  const saveGeneratedTrip = useTripStore((state) => state.saveGeneratedTrip);

  const [phase, setPhase] = useState<GenerationPhase>({ status: "idle" });
  const [availability, setAvailability] = useState<AiStatusResponse | null>(null);

  const inFlight = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** The request the traveller filled in, held between the two steps. */
  const requestRef = useRef<TripRequest | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/ai/status", { signal: controller.signal })
      .then((response) => response.json())
      .then((json: unknown) => {
        const parsed = AiStatusResponseSchema.safeParse(json);
        if (parsed.success) setAvailability(parsed.data);
      })
      .catch(() => {
        /**
         * A failed status read leaves `availability` null, and the panel treats
         * null as "not yet known" rather than as "no model". The demo planner is
         * always offered regardless, so the workflow is never blocked by this.
         */
      });

    return () => controller.abort();
  }, []);

  // Abort in flight work if the page unmounts, so a navigation away does not leave
  // a generation running against a provider for a result nobody will read.
  useEffect(() => () => abortRef.current?.abort(), []);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    requestRef.current = null;
    setPhase({ status: "idle" });
  }, []);

  /** Step one: resolve the destination string to candidates the traveller picks from. */
  const resolveDestination = useCallback(async (request: TripRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    requestRef.current = request;
    setPhase({ status: "geocoding" });

    try {
      const response = await fetch("/api/places/geocode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destination: request.destination }),
        signal: controller.signal,
      });

      const json: unknown = await response.json();

      if (!response.ok) {
        setPhase({ status: "error", message: readApiError(json), retryable: true });
        return;
      }

      const parsed = GeocodeResponseSchema.safeParse(json);
      if (!parsed.success) {
        setPhase({
          status: "error",
          message: "The destination search returned something we could not read.",
          retryable: true,
        });
        return;
      }

      const candidates = toCandidates(parsed.data);
      if (candidates.length === 0) {
        setPhase({
          status: "error",
          message: `OpenStreetMap has no place called “${request.destination}”. Try a nearby town or city, or check the spelling.`,
          retryable: true,
        });
        return;
      }

      setPhase({
        status: "choosing",
        candidates,
        // One unambiguous match is pre-selected, and still shown — the traveller
        // should be able to see which place we resolved before a trip is built
        // around it.
        selected: candidates.length === 1 ? candidates[0] : null,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        setPhase({ status: "idle" });
        return;
      }
      setPhase({
        status: "error",
        message:
          error instanceof Error
            ? "Could not reach the destination search. Please try again."
            : "Something went wrong looking up that destination.",
        retryable: true,
      });
    } finally {
      inFlight.current = false;
      abortRef.current = null;
    }
  }, []);

  const selectDestination = useCallback(
    (candidate: GeocodedDestinationRecord) => {
      setPhase((current) =>
        current.status === "choosing"
          ? { ...current, selected: candidate }
          : current,
      );
    },
    [],
  );

  /** Step two: generate, validate, and save once. */
  const generate = useCallback(
    async (input: {
      destination: GeocodedDestinationRecord;
      providerPreference: AiProviderPreferenceInput;
    }) => {
      const request = requestRef.current;
      if (!request || inFlight.current) return;

      inFlight.current = true;
      const controller = new AbortController();
      abortRef.current = controller;

      const requestId = nanoid(12);
      const providerLabel =
        input.providerPreference === "deterministic"
          ? "Demo Planner"
          : (availability?.providerLabel ?? "AI planner");

      setPhase({
        status: "generating",
        stage: "understanding",
        provider: providerLabel,
      });

      try {
        const response = await fetch("/api/trips/generate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            // Progress events. The route serves plain JSON without this, which is
            // what keeps `curl` and the test suite on the same code path.
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            request,
            destination: input.destination,
            providerPreference: input.providerPreference,
            requestId,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const json: unknown = await response.json().catch(() => null);
          setPhase({
            status: "error",
            message: readApiError(json),
            retryable: response.status !== 400,
          });
          return;
        }

        const result = await readGenerationStream({
          response,
          requestId,
          onStage: (stage) =>
            setPhase({ status: "generating", stage, provider: providerLabel }),
        });

        if (!result) {
          setPhase({
            status: "error",
            message: "Trip generation ended without a result. Please try again.",
            retryable: true,
          });
          return;
        }

        applyResult(result);
      } catch (error) {
        if (controller.signal.aborted) {
          /**
           * A cancelled generation returns the traveller to the destination step
           * with **nothing saved**. There is no partial trip to clean up, because
           * the server persisted nothing and the store was never called.
           */
          setPhase({ status: "idle" });
          return;
        }
        setPhase({
          status: "error",
          message:
            error instanceof Error
              ? "Could not reach the trip planner. Please try again."
              : "Something went wrong generating this trip.",
          retryable: true,
        });
      } finally {
        inFlight.current = false;
        abortRef.current = null;
      }

      function applyResult(result: GenerateTripResponse) {
        // A response belonging to a superseded request is discarded rather than
        // applied — otherwise a slow first attempt could overwrite a fast second.
        if (result.requestId !== requestId) return;

        if (result.status === "refused") {
          setPhase({ status: "refused", message: result.userMessage });
          return;
        }
        if (result.status === "unavailable" || result.status === "failed") {
          setPhase({
            status: "error",
            message: result.userMessage,
            retryable:
              result.status === "unavailable" &&
              result.reason !== "not_configured",
          });
          return;
        }

        // One atomic write, at revision 1, carrying the plan and its exact pool.
        const saved = saveGeneratedTrip({
          tripId: result.plan.id,
          request: request!,
          plan: result.plan,
          generation: result.generation,
        });

        if (!saved.ok) {
          setPhase({
            status: "error",
            message:
              "The generated trip could not be saved in this browser, so it was discarded.",
            retryable: true,
          });
          return;
        }

        setPhase({
          status: "done",
          tripId: result.plan.id,
          warnings: result.warnings,
        });
      }
    },
    [availability, saveGeneratedTrip],
  );

  return {
    phase,
    availability,
    resolveDestination,
    selectDestination,
    generate,
    cancel,
    reset,
  };
}

/* -------------------------------------------------------------------------- */

/**
 * Reads the server-sent stream: progress events, then one result.
 *
 * A deliberately small parser rather than `EventSource`, which cannot issue a POST
 * and cannot send a JSON body. The framing is the SSE minimum — `event:` and `data:`
 * lines, blank line terminated — and anything unrecognised is skipped rather than
 * treated as an error, so a future comment or heartbeat line cannot break a client.
 *
 * The result is buffered and validated in full before it is returned. There is no
 * point at which a partially parsed plan exists in the browser.
 */
async function readGenerationStream(context: {
  response: Response;
  requestId: string;
  onStage: (stage: GenerationStage) => void;
}): Promise<GenerateTripResponse | null> {
  const contentType = context.response.headers.get("content-type") ?? "";

  // The route falls back to plain JSON if it cannot stream. Handling both here
  // means the caller never has to care which it got.
  if (!contentType.includes("text/event-stream")) {
    const json: unknown = await context.response.json();
    const parsed = GenerateTripResponseSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  const reader = context.response.body?.getReader();
  if (!reader) return null;

  const decoder = new TextDecoder();
  let buffer = "";
  let result: GenerateTripResponse | null = null;

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
        const validated = GenerateTripResponseSchema.safeParse(parsed.data);
        if (validated.success) result = validated.data;
      }
    }
  }

  return result;
}

function parseFrame(
  frame: string,
): { event: string; data: unknown } | null {
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

function readStage(data: unknown): GenerationStage | null {
  if (data === null || typeof data !== "object") return null;
  const stage = (data as { stage?: unknown }).stage;
  return typeof stage === "string" ? (stage as GenerationStage) : null;
}

/**
 * The geocode response's candidates, in the stored record's shape.
 *
 * Both are validated forms of the same thing — `GeocodeResponseSchema` reuses
 * `GeocodedDestinationSchema` — so this is a type narrowing rather than a
 * conversion. It exists to make that explicit at the one place the two contracts
 * meet.
 */
function toCandidates(response: GeocodeResponse): GeocodedDestinationRecord[] {
  return response.candidates;
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
  return "That request failed. Please try again.";
}
