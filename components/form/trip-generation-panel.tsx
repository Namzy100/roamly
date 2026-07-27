"use client";

import {
  AlertTriangle,
  ArrowLeft,
  Check,
  FlaskConical,
  Loader2,
  MapPin,
  Sparkles,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { AiStatusResponse } from "@/lib/api/generate-contract";
import {
  GENERATION_STAGES,
  GENERATION_STAGE_LABELS,
} from "@/lib/generate/types";
import type { GenerationPhase } from "@/lib/hooks/use-trip-generation";
import type { GeocodedDestinationRecord } from "@/lib/schemas";
import { cn } from "@/lib/utils";

/**
 * The second half of the builder: pick the destination, pick the planner, watch it
 * work.
 *
 * ## Why the destination is confirmed rather than assumed
 *
 * The geocoder returns up to five candidates and the domain layer refuses to choose
 * between them. That refusal is only worth anything if the interface actually asks —
 * so a single match is shown too, with its full display name, because "we resolved
 * your ‘Lisbon’ to Lisbon, Portugal" is information the traveller should see before a
 * five-day itinerary is built around it.
 *
 * ## Why there are two buttons
 *
 * Because they produce genuinely different things and the traveller is entitled to
 * choose. The AI action is disabled — not hidden, and labelled with why — when no
 * model is configured, since silently substituting the demo planner behind an "AI"
 * button is the one substitution this phase forbids. The demo planner is always
 * available and always says what it is.
 */

export function TripGenerationPanel({
  phase,
  availability,
  onSelectDestination,
  onGenerate,
  onCancel,
  onBack,
}: {
  phase: GenerationPhase;
  availability: AiStatusResponse | null;
  onSelectDestination: (candidate: GeocodedDestinationRecord) => void;
  onGenerate: (preference: "auto" | "deterministic") => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  if (phase.status === "idle") return null;

  return (
    <section
      aria-labelledby="generate-heading"
      data-testid="generation-panel"
      data-phase={phase.status}
      className="flex flex-col gap-5 rounded-2xl border border-line bg-sand/40 p-5 sm:p-6"
    >
      <div className="flex flex-col gap-1">
        <span className="eyebrow text-terracotta">Step 2</span>
        <h3
          id="generate-heading"
          className="font-display text-xl text-forest sm:text-2xl"
        >
          {phase.status === "generating"
            ? "Building your trip"
            : "Confirm where you're going"}
        </h3>
      </div>

      {phase.status === "geocoding" ? (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 aria-hidden className="size-4 animate-spin" />
          Looking up that destination in OpenStreetMap…
        </p>
      ) : null}

      {phase.status === "choosing" ? (
        <DestinationChoice
          candidates={phase.candidates}
          selected={phase.selected}
          availability={availability}
          onSelect={onSelectDestination}
          onGenerate={onGenerate}
          onBack={onBack}
        />
      ) : null}

      {phase.status === "generating" ? (
        <GenerationProgress
          stage={phase.stage}
          provider={phase.provider}
          onCancel={onCancel}
        />
      ) : null}

      {phase.status === "refused" ? (
        <Notice tone="warning" testId="generation-refused">
          {phase.message}
        </Notice>
      ) : null}

      {phase.status === "error" ? (
        <div className="flex flex-col gap-3">
          <Notice tone="error" testId="generation-error">
            {phase.message}
          </Notice>
          <Button
            type="button"
            variant="outline"
            onClick={onBack}
            className="h-9 w-fit gap-1.5"
          >
            <ArrowLeft aria-hidden className="size-3.5" />
            Start again
          </Button>
        </div>
      ) : null}

      {/*
       * The outcome, announced. A traveller using a screen reader should hear that
       * their trip is being built and that it finished, without hunting for it.
       */}
      <p className="sr-only" aria-live="polite">
        {phase.status === "generating"
          ? GENERATION_STAGE_LABELS[phase.stage]
          : phase.status === "done"
            ? "Your trip is ready."
            : ""}
      </p>
    </section>
  );
}

function DestinationChoice({
  candidates,
  selected,
  availability,
  onSelect,
  onGenerate,
  onBack,
}: {
  candidates: GeocodedDestinationRecord[];
  selected: GeocodedDestinationRecord | null;
  availability: AiStatusResponse | null;
  onSelect: (candidate: GeocodedDestinationRecord) => void;
  onGenerate: (preference: "auto" | "deterministic") => void;
  onBack: () => void;
}) {
  /**
   * Null means the status read has not landed yet, not "no model". Treating an
   * unknown as unavailable would flash a disabled button on every page load.
   */
  const modelAvailable = availability?.modelAvailable ?? false;
  const statusKnown = availability !== null;

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-ink">
          {candidates.length === 1
            ? "We found one match"
            : `${candidates.length} places match that name — which did you mean?`}
        </legend>

        {candidates.map((candidate) => {
          const isSelected = selected?.canonicalId === candidate.canonicalId;
          return (
            <label
              key={candidate.canonicalId}
              data-testid="destination-candidate"
              data-selected={isSelected}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border bg-cream-raised px-3.5 py-3 text-left transition-colors",
                isSelected
                  ? "border-terracotta ring-1 ring-terracotta"
                  : "border-line hover:border-forest-soft/60",
              )}
            >
              <input
                type="radio"
                name="destination-candidate"
                className="mt-1 accent-terracotta"
                checked={isSelected}
                onChange={() => onSelect(candidate)}
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-ink">
                  {candidate.name}
                </span>
                <span className="flex items-start gap-1 text-xs text-ink-muted">
                  <MapPin aria-hidden className="mt-0.5 size-3 shrink-0" />
                  {candidate.displayName}
                </span>
              </span>
            </label>
          );
        })}

        <p className="mt-1 text-xs text-ink-muted">
          Destinations come from OpenStreetMap via Nominatim. © OpenStreetMap
          contributors.
        </p>
      </fieldset>

      <div className="flex flex-col gap-3 border-t border-line pt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button
            type="button"
            size="lg"
            disabled={selected === null || !modelAvailable}
            onClick={() => onGenerate("auto")}
            data-testid="generate-with-ai"
            className="h-11 gap-2 rounded-full px-6"
          >
            <Sparkles aria-hidden className="size-4" />
            Generate with AI
          </Button>

          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={selected === null}
            onClick={() => onGenerate("deterministic")}
            data-testid="generate-with-demo"
            className="h-11 gap-2 rounded-full px-6"
          >
            <FlaskConical aria-hidden className="size-4" />
            Use the demo planner
          </Button>
        </div>

        {statusKnown && !modelAvailable ? (
          <p
            data-testid="ai-unavailable-note"
            className="text-xs leading-relaxed text-ink-muted"
          >
            No AI planner is configured on this deployment, so that option is
            unavailable. The demo planner works with no configuration at all — it
            builds the itinerary from real OpenStreetMap places using a fixed
            template rather than a model.
          </p>
        ) : null}

        {modelAvailable ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            {availability?.providerLabel} chooses and orders the stops. Every place
            comes from an OpenStreetMap search — the model can only pick from what
            was actually found, never invent somewhere. Free-tier rate limits may
            apply.
          </p>
        ) : null}

        <button
          type="button"
          onClick={onBack}
          className="w-fit text-xs text-ink-muted underline underline-offset-2 hover:text-forest"
        >
          Change the trip details
        </button>
      </div>
    </div>
  );
}

/**
 * Real stages, not a timed animation.
 *
 * Each label lights up when the server says that work has begun — the events come
 * from `onProgress` inside the pipeline itself. A generation that stalls on discovery
 * therefore *shows* as stalled on discovery, which is the only honest reason to have
 * a progress display at all.
 */
function GenerationProgress({
  stage,
  provider,
  onCancel,
}: {
  stage: string;
  provider: string;
  onCancel: () => void;
}) {
  const currentIndex = GENERATION_STAGES.indexOf(
    stage as (typeof GENERATION_STAGES)[number],
  );

  return (
    <div className="flex flex-col gap-4">
      <ol
        data-testid="generation-stages"
        data-current-stage={stage}
        className="flex flex-col gap-2"
      >
        {GENERATION_STAGES.map((entry, index) => {
          const done = index < currentIndex;
          const active = index === currentIndex;
          return (
            <li
              key={entry}
              data-stage={entry}
              data-state={done ? "done" : active ? "active" : "pending"}
              className={cn(
                "flex items-center gap-2.5 text-sm",
                done
                  ? "text-ink-muted"
                  : active
                    ? "font-medium text-forest"
                    : "text-ink-muted/60",
              )}
            >
              <span className="flex size-5 shrink-0 items-center justify-center">
                {done ? (
                  <Check aria-hidden className="size-3.5 text-forest" />
                ) : active ? (
                  <Loader2 aria-hidden className="size-3.5 animate-spin" />
                ) : (
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-ink-muted/30"
                  />
                )}
              </span>
              {GENERATION_STAGE_LABELS[entry]}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          data-testid="cancel-generation"
          className="h-9"
        >
          Cancel
        </Button>
        <p className="text-xs text-ink-muted">
          {provider} is planning. Nothing is saved until the whole itinerary has
          been checked, so cancelling leaves no trip behind.
        </p>
      </div>
    </div>
  );
}

function Notice({
  tone,
  testId,
  children,
}: {
  tone: "warning" | "error";
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <p
      role="alert"
      data-testid={testId}
      className={cn(
        "flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-xs leading-relaxed text-ink",
        tone === "error"
          ? "border-destructive/30 bg-destructive/[0.06]"
          : "border-terracotta/30 bg-terracotta/[0.07]",
      )}
    >
      <AlertTriangle
        aria-hidden
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          tone === "error" ? "text-destructive" : "text-terracotta",
        )}
      />
      {children}
    </p>
  );
}
