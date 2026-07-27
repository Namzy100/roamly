"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  RouteOff,
  Waypoints,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatDistance, formatDuration } from "@/lib/format";
import { useOnlineStatus } from "@/lib/hooks/use-online-status";
import { useTripRouting } from "@/lib/hooks/use-trip-routing";
import { durationSecondsToMinutes } from "@/lib/routing";
import type { RoutingEnrichmentSummary, TripPlan } from "@/lib/schemas";
import { cn } from "@/lib/utils";

/**
 * The user-initiated routing action, and what it produced.
 *
 * Nothing here fires on mount. The provider is a donated demo server and real
 * routes are something the traveller asks for — which is also why the button
 * says how long it takes rather than pretending the result is instant.
 *
 * Coverage is always shown once a run has happened, including when it is
 * partial. "8 of 10 legs calculated" is the sentence that stops a day with two
 * unroutable hops from reading as a day with less travel in it.
 */
export function RoutingControls({ plan }: { plan: TripPlan }) {
  const online = useOnlineStatus();
  const { job, calculateRoutes, cancel, isRunning } = useTripRouting(plan.id);

  const routing = plan.routing;
  const hasRun = routing !== null;

  return (
    <section
      aria-labelledby="routing-heading"
      data-testid="routing-controls"
      data-routing-completion={routing?.summary.completion ?? "not_attempted"}
      className="flex flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h3
            id="routing-heading"
            className="flex items-center gap-2 font-display text-lg text-forest"
          >
            <Waypoints aria-hidden className="size-4 text-terracotta" />
            Real routes
          </h3>
          <p className="max-w-md text-xs leading-relaxed text-ink-muted">
            {hasRun
              ? "Travel times below come from OpenStreetMap road data. Not live traffic."
              : "Travel times below are estimates. Calculate real walking and driving routes from OpenStreetMap road data — it takes a few seconds."}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {isRunning ? (
            <Button
              type="button"
              onClick={cancel}
              className="h-9 gap-1.5 bg-transparent text-ink-muted hover:text-forest"
              data-testid="cancel-routes-button"
            >
              Cancel
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => void calculateRoutes()}
            /**
             * Offline this cannot work: routes come from a routing service. Disabled with the reason
             * shown, rather than starting a request that is certain to fail.
             */
            disabled={isRunning || !online}
            className="h-9 gap-1.5"
            data-testid="calculate-routes-button"
          >
            {isRunning ? (
              <>
                <Loader2 aria-hidden className="size-3.5 animate-spin" />
                Calculating routes…
              </>
            ) : hasRun ? (
              <>
                <RefreshCw aria-hidden className="size-3.5" />
                Recalculate routes
              </>
            ) : (
              <>
                <Waypoints aria-hidden className="size-3.5" />
                Calculate real routes
              </>
            )}
          </Button>
        </div>
      </div>

      {routing ? <CoverageRow summary={routing.summary} /> : null}

      {job.status === "error" || job.status === "conflict" ? (
        <p
          role="alert"
          data-testid="routing-job-error"
          data-job-status={job.status}
          className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/[0.06] px-3.5 py-2.5 text-xs leading-relaxed text-ink"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-3.5 shrink-0 text-destructive"
          />
          {job.message}
        </p>
      ) : null}

      {/*
       * A live region rather than a toast: the outcome matters and a traveller
       * using a screen reader should hear it without hunting for it.
       */}
      <p className="sr-only" aria-live="polite">
        {job.status === "running"
          ? "Calculating routes."
          : job.status === "success"
            ? "All routes calculated."
            : job.status === "partial"
              ? "Some routes are unavailable."
              : ""}
      </p>
    </section>
  );
}

/**
 * Coverage, stated plainly.
 *
 * The counts come straight from the validated summary on the plan, so what is
 * rendered here and what the plan claims cannot diverge. Distance and duration
 * are explicitly labelled "across routed legs" — an unroutable leg contributes
 * nothing, and saying so is the difference between an honest total and an
 * under-count presented as a fact.
 */
function CoverageRow({ summary }: { summary: RoutingEnrichmentSummary }) {
  const complete = summary.completion === "complete";
  const nothing = summary.routedLegs === 0;

  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-sand/60 px-3.5 py-2.5 text-xs"
      data-testid="routing-coverage"
      data-routed-legs={summary.routedLegs}
      data-expected-legs={summary.expectedLegs}
      data-unavailable-legs={summary.unavailableLegs}
      data-pending-legs={summary.pendingLegs}
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 font-medium",
          complete ? "text-forest" : nothing ? "text-terracotta" : "text-ink",
        )}
      >
        {complete ? (
          <CheckCircle2 aria-hidden className="size-3.5" />
        ) : (
          <RouteOff aria-hidden className="size-3.5" />
        )}
        Routing coverage: {summary.routedLegs} of {summary.expectedLegs} legs
        calculated
      </span>

      {summary.unavailableLegs > 0 ? (
        <span className="text-ink-muted">
          {summary.unavailableLegs} unavailable
        </span>
      ) : null}

      {summary.pendingLegs > 0 ? (
        <span className="text-ink-muted">
          {summary.pendingLegs} not calculated
        </span>
      ) : null}

      {summary.routedLegs > 0 ? (
        <span className="text-ink-muted">
          {formatDistance(summary.totalRoutedDistanceMeters)} ·{" "}
          {formatDuration(
            durationSecondsToMinutes(summary.totalRoutedDurationSeconds),
          )}{" "}
          across routed legs
        </span>
      ) : null}
    </div>
  );
}
