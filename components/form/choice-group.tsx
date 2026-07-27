"use client";

import { Check } from "lucide-react";
import type { UseFormRegisterReturn } from "react-hook-form";

import { cn } from "@/lib/utils";

type Option = { value: string; label: string; hint?: string };

/**
 * Multi-select chips built on real checkboxes.
 *
 * The input is visually hidden but still focusable, so keyboard traversal,
 * space-to-toggle, and screen-reader state all come from the platform rather
 * than from `aria-pressed` bookkeeping. Styling hangs off `peer-checked` and
 * `peer-focus-visible`.
 */
export function ChipGroup({
  options,
  registration,
  idPrefix,
}: {
  options: readonly Option[];
  registration: UseFormRegisterReturn;
  idPrefix: string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const id = `${idPrefix}-${option.value}`;
        return (
          <div key={option.value} className="contents">
            <input
              {...registration}
              type="checkbox"
              id={id}
              value={option.value}
              className="peer sr-only"
            />
            <label
              htmlFor={id}
              className={cn(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-cream-raised px-3.5 py-2 text-sm text-ink transition-colors select-none",
                "hover:border-forest-soft/60 hover:bg-sand/60",
                "peer-checked:border-forest peer-checked:bg-forest peer-checked:text-primary-foreground",
                // The icon is a descendant of the label, not a sibling of the
                // input, so it has to be reached from the label's own variant.
                "peer-checked:[&>svg]:w-3.5 peer-checked:[&>svg]:opacity-100",
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-forest",
              )}
            >
              <Check
                aria-hidden
                className="h-3.5 w-0 shrink-0 opacity-0 transition-all duration-150"
              />
              {option.label}
            </label>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Single-select cards built on real radios, for the same reasons as above —
 * arrow-key navigation within the group is native behaviour.
 */
export function RadioCardGroup({
  options,
  registration,
  idPrefix,
  columns = 3,
}: {
  options: readonly Option[];
  registration: UseFormRegisterReturn;
  idPrefix: string;
  columns?: 2 | 3 | 5;
}) {
  return (
    <div
      className={cn(
        "grid gap-2",
        columns === 2 && "grid-cols-2",
        columns === 3 && "grid-cols-1 sm:grid-cols-3",
        columns === 5 && "grid-cols-2 sm:grid-cols-3 lg:grid-cols-5",
      )}
    >
      {options.map((option) => {
        const id = `${idPrefix}-${option.value}`;
        return (
          <div key={option.value} className="contents">
            <input
              {...registration}
              type="radio"
              id={id}
              value={option.value}
              className="peer sr-only"
            />
            <label
              htmlFor={id}
              className={cn(
                "flex cursor-pointer flex-col gap-0.5 rounded-xl border border-line bg-cream-raised px-3.5 py-3 transition-colors select-none",
                "hover:border-forest-soft/60 hover:bg-sand/50",
                "peer-checked:border-forest peer-checked:bg-forest/[0.06] peer-checked:ring-1 peer-checked:ring-forest",
                "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-forest",
              )}
            >
              <span className="text-sm font-medium text-ink">
                {option.label}
              </span>
              {option.hint ? (
                <span className="text-xs text-ink-muted">{option.hint}</span>
              ) : null}
            </label>
          </div>
        );
      })}
    </div>
  );
}
