"use client";

import { PiggyBank, TrendingUp } from "lucide-react";

import { formatMoney } from "@/lib/format";
import type { BudgetSummary } from "@/lib/schemas";
import { cn } from "@/lib/utils";

const CATEGORY_COLORS = [
  "bg-forest",
  "bg-forest-soft",
  "bg-terracotta",
  "bg-terracotta/70",
  "bg-sand",
] as const;

/**
 * Money only.
 *
 * Route availability and transport cost are separate concerns and are kept
 * separate here. An unroutable leg does not make the trip cheaper — the
 * traveller still has to get there, by some means, at some cost — so nothing in
 * this panel changes when routing fails, and the transport figure stays exactly
 * the estimate it always was. Routing coverage is reported by `RoutingControls`
 * instead, where it belongs.
 */
export function BudgetPanel({ budget }: { budget: BudgetSummary }) {
  const categories = [
    { label: "Flights", amount: budget.flights },
    { label: "Stay", amount: budget.accommodation },
    { label: "Food", amount: budget.food },
    { label: "Activities", amount: budget.activities },
    { label: "Transport", amount: budget.transport },
  ];

  const overBudget = budget.remaining < 0;
  // Guard against a zero total, which would make every share NaN.
  const denominator = budget.total || 1;
  const usedPct = Math.min(
    100,
    Math.round((budget.total / (budget.requestedBudget || 1)) * 100),
  );

  return (
    <section
      aria-labelledby="budget-heading"
      className="flex flex-col gap-4 rounded-2xl border border-line bg-cream-raised p-5"
    >
      <div className="flex items-center justify-between gap-3">
        <h3
          id="budget-heading"
          className="flex items-center gap-2 font-display text-lg text-forest"
        >
          <PiggyBank aria-hidden className="size-4 text-terracotta" />
          Budget
        </h3>
        <span className="text-xs text-ink-muted">
          {usedPct}% of {formatMoney(budget.requestedBudget, budget.currency)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-display text-3xl text-forest">
            {formatMoney(budget.total, budget.currency)}
          </span>
          <span
            className={cn(
              "text-sm font-medium",
              overBudget ? "text-destructive" : "text-forest-soft",
            )}
          >
            {overBudget
              ? `${formatMoney(Math.abs(budget.remaining), budget.currency)} over`
              : `${formatMoney(budget.remaining, budget.currency)} left`}
          </span>
        </div>

        {/* Stacked share of the total, not of the requested budget. */}
        <div
          className="flex h-2 w-full overflow-hidden rounded-full bg-sand"
          role="img"
          aria-label={categories
            .map(
              (category) =>
                `${category.label} ${formatMoney(category.amount, budget.currency)}`,
            )
            .join(", ")}
        >
          {categories.map((category, index) => (
            <span
              key={category.label}
              className={CATEGORY_COLORS[index]}
              style={{ width: `${(category.amount / denominator) * 100}%` }}
            />
          ))}
        </div>
      </div>

      <dl className="flex flex-col divide-y divide-line">
        {categories.map((category, index) => (
          <div
            key={category.label}
            className="flex items-center justify-between gap-3 py-2"
          >
            <dt className="flex items-center gap-2 text-sm text-ink">
              <span
                aria-hidden
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  CATEGORY_COLORS[index],
                )}
              />
              {category.label}
              {/*
               * Transport is a planning estimate and stays one whatever routing
               * says. Labelling it here stops a traveller reading a routed
               * duration beside it as a priced fare.
               */}
              {category.label === "Transport" ? (
                <span
                  className="text-[0.625rem] text-ink-muted"
                  title="A planning estimate for local transport. Independent of whether a route could be calculated."
                  data-testid="transport-estimate-label"
                >
                  estimate
                </span>
              ) : null}
            </dt>
            <dd className="text-sm font-medium tabular-nums text-ink">
              {formatMoney(category.amount, budget.currency)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="flex items-center justify-between gap-3 rounded-xl bg-sand/60 px-3 py-2.5">
        <span className="flex items-center gap-2 text-xs text-ink-muted">
          <TrendingUp aria-hidden className="size-3.5" />
          Per traveller
        </span>
        <span className="font-display text-base text-forest">
          {formatMoney(budget.perTraveler, budget.currency)}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <p className="eyebrow text-ink-muted">Daily spend</p>
        <ul className="flex flex-col gap-1">
          {budget.byDay.map((day) => {
            const max = Math.max(...budget.byDay.map((entry) => entry.amount), 1);
            return (
              <li
                key={day.dayNumber}
                className="flex items-center gap-2.5 text-xs"
              >
                <span className="w-11 shrink-0 text-ink-muted">
                  Day {day.dayNumber}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-sand">
                  <span
                    className="block h-full rounded-full bg-forest-soft"
                    style={{ width: `${(day.amount / max) * 100}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right font-medium tabular-nums text-ink">
                  {formatMoney(day.amount, budget.currency)}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
