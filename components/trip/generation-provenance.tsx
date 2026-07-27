"use client";

import {
  ChevronDown,
  CircleSlash,
  Coins,
  Cpu,
  Map as MapIcon,
  RouteOff,
} from "lucide-react";
import { useState } from "react";

import { PROVIDER_LABELS } from "@/lib/api/generate-contract";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";
import { cn } from "@/lib/utils";

/**
 * How this trip was made, said in the workspace.
 *
 * ## What has to be visible, and why each one
 *
 * **Which planner.** A traveller reading an itinerary is entitled to know whether a
 * model chose these stops or a template did. It changes how much weight the
 * commentary deserves.
 *
 * **Where the places came from.** OpenStreetMap's licence requires attribution, and
 * beyond the licence it is the substance of the no-invention claim: these are mapped
 * places, not suggestions a model produced.
 *
 * **That prices are estimates.** Every figure in the plan is a category estimate.
 * Once, prominently, rather than only in a tooltip on each card.
 *
 * **That routes are not calculated yet.** Until the traveller asks, no travel time in
 * the plan has been measured. A plan that looked routed but was not would be the
 * quietest possible lie.
 *
 * **Where the search came up short.** Warnings and open slots are surfaced rather
 * than logged, because a partial result presented as complete is the failure this
 * whole architecture is arranged to prevent.
 *
 * The model id lives in the collapsed details panel, not the headline. "Generated
 * with Gemini" is what a traveller needs; `gemini-2.5-flash` is for whoever is
 * debugging.
 */

export function GenerationProvenance({
  plan,
  generation,
}: {
  plan: TripPlan;
  generation: TripGenerationContext | null;
}) {
  const [showDetails, setShowDetails] = useState(false);

  // A trip with no retained context is the fixed sample or a plan saved before
  // generation existed. Its own banner says what it is; there is nothing to add.
  if (!generation) return null;

  const providerLabel = PROVIDER_LABELS[generation.provider] ?? "Demo Planner";
  const unfilled = plan.days.reduce(
    (total, day) =>
      total + day.items.filter((item) => item.status === "unavailable").length,
    0,
  );
  const notRouted = plan.routing === null;

  return (
    <section
      aria-labelledby="provenance-heading"
      data-testid="generation-provenance"
      data-provider={generation.provider}
      data-warning-count={generation.warnings.length}
      data-unfilled-slots={unfilled}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <h3
        id="provenance-heading"
        className="flex items-center gap-2 font-display text-lg text-forest"
      >
        <Cpu aria-hidden className="size-4 text-terracotta" />
        How this plan was made
      </h3>

      <ul className="flex flex-col gap-2 text-xs leading-relaxed text-ink-muted">
        <Fact icon={Cpu}>
          <span className="font-medium text-ink">
            Generated with {providerLabel}
          </span>
          {generation.provider === "deterministic"
            ? " — a fixed template, not a language model. It selected real places by category and its commentary is generic."
            : " — the planner chose and ordered the stops from places that were already found, and could not add any of its own."}
        </Fact>

        <Fact icon={MapIcon}>
          Places sourced from OpenStreetMap. {generation.discoverySummary.attribution}
        </Fact>

        <Fact icon={Coins}>
          Prices are planning estimates for the whole party, from typical costs for
          each kind of place. Nothing has been quoted, converted or booked.
        </Fact>

        {notRouted ? (
          <Fact icon={RouteOff}>
            <span className="font-medium text-ink">
              Routes have not been calculated yet.
            </span>{" "}
            No travel time between these stops has been measured — use “Calculate
            real routes” below.
          </Fact>
        ) : null}

        {unfilled > 0 ? (
          <Fact icon={CircleSlash}>
            <span className="font-medium text-ink">
              {unfilled} slot{unfilled === 1 ? "" : "s"} left open.
            </span>{" "}
            The place search found nothing suitable, and an open slot is shown rather
            than something invented.
          </Fact>
        ) : null}
      </ul>

      {generation.warnings.length > 0 ? (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setShowDetails((current) => !current)}
            aria-expanded={showDetails}
            data-testid="provenance-details-toggle"
            className="flex w-fit items-center gap-1 text-xs font-medium text-forest underline-offset-2 hover:underline"
          >
            {showDetails ? "Hide" : "Show"} {generation.warnings.length} note
            {generation.warnings.length === 1 ? "" : "s"} about this plan
            <ChevronDown
              aria-hidden
              className={cn(
                "size-3 transition-transform",
                showDetails && "rotate-180",
              )}
            />
          </button>

          {showDetails ? (
            <div
              data-testid="provenance-details"
              className="flex flex-col gap-2 rounded-xl bg-sand/50 p-3.5"
            >
              <ul className="flex flex-col gap-1.5 text-xs leading-relaxed text-ink-muted">
                {generation.warnings.map((warning, index) => (
                  <li key={`${warning.code}-${index}`} className="flex gap-1.5">
                    <span aria-hidden className="text-ink-muted/60">
                      ·
                    </span>
                    {warning.message}
                  </li>
                ))}
              </ul>

              <dl className="mt-1 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-line pt-2.5 text-[0.6875rem] text-ink-muted">
                <Detail label="Planner">{generation.model}</Detail>
                <Detail label="Places found">
                  {generation.discoverySummary.candidateCount}
                </Detail>
                <Detail label="Search radius">
                  {Math.round(generation.discoverySummary.radiusMeters / 100) / 10}{" "}
                  km
                </Detail>
                <Detail label="Searches run">
                  {generation.discoverySummary.requestCount}
                </Detail>
                {/*
                  * Phase 6B provenance. Absent for anything generated earlier, and
                  * deliberately not backfilled — those figures came from different
                  * arithmetic, and labelling them with a profile they never saw would be
                  * inventing provenance.
                  */}
                {generation.costProfile ? (
                  <Detail label="Cost profile">
                    {COST_PROFILE_LABELS[generation.costProfile.match]} ·{" "}
                    {generation.costProfile.profileId}@
                    {generation.costProfile.version} ·{" "}
                    {generation.costProfile.confidence} confidence
                  </Detail>
                ) : null}
                {generation.destinationTimezone ? (
                  <Detail label="Local time">
                    {generation.destinationTimezone.timezone.replace("_", " ")} (from
                    the {generation.destinationTimezone.source})
                  </Detail>
                ) : (
                  <Detail label="Local time">
                    Not determined — opening hours are shown as recorded but not checked
                  </Detail>
                )}
              </dl>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * How the profile was matched, in words.
 *
 * A global fallback is not wrong, it is uninformed, and a traveller reading a figure
 * deserves to know which they have — so the match is stated rather than implied by the
 * confidence alone.
 */
const COST_PROFILE_LABELS: Record<
  NonNullable<TripGenerationContext["costProfile"]>["match"],
  string
> = {
  city: "This city",
  country: "This country",
  region: "This region",
  global: "Generic baseline",
};

function Fact({
  icon: Icon,
  children,
}: {
  icon: typeof Cpu;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-2">
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-ink-muted/70" />
      <span>{children}</span>
    </li>
  );
}

function Detail({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col">
      <dt className="text-ink-muted/70">{label}</dt>
      <dd className="font-medium text-ink">{children}</dd>
    </div>
  );
}
