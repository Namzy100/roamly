"use client";

import { formatDayOfMonth, formatWeekdayShort } from "@/lib/format";
import type { ItineraryDay } from "@/lib/schemas";
import type { DayFilter } from "@/lib/store/workspace-store";
import { cn } from "@/lib/utils";

/**
 * Horizontal day switcher.
 *
 * Implemented as a tablist so arrow keys move between days and the selected day
 * is announced. It scrolls horizontally on narrow screens rather than wrapping,
 * which keeps the workspace header a fixed height.
 */
export function DaySelector({
  days,
  selectedDay,
  onSelect,
  isDropTarget,
}: {
  days: ItineraryDay[];
  selectedDay: DayFilter;
  onSelect: (day: DayFilter) => void;
  /**
   * Whether a stop is being dragged over this day's tab (Phase 8).
   *
   * The tabs double as drop targets for a cross-day move: they are the only place in the workspace
   * that names every day at once, so dragging a card onto "Day 4" is a shorter route than opening
   * the placement dialog. The drag itself belongs to `useItemReorder` — this component contributes
   * a `data-day-drop` rectangle to hit-test against, and a highlight, and knows nothing else about
   * it.
   *
   * Absent when the trip cannot be structurally edited, in which case the tabs are only tabs.
   */
  isDropTarget?: (dayNumber: number) => boolean;
}) {
  const options: { key: string; value: DayFilter }[] = [
    { key: "all", value: "all" },
    ...days.map((day) => ({ key: String(day.dayNumber), value: day.dayNumber })),
  ];

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const index = options.findIndex((option) => option.value === selectedDay);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = options[(index + delta + options.length) % options.length];
    onSelect(next.value);
    document.getElementById(`day-tab-${next.key}`)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Choose a day"
      onKeyDown={onKeyDown}
      className="scrollbar-subtle -mx-1 flex gap-2 overflow-x-auto px-1 pb-1"
    >
      <button
        type="button"
        id="day-tab-all"
        role="tab"
        aria-selected={selectedDay === "all"}
        tabIndex={selectedDay === "all" ? 0 : -1}
        onClick={() => onSelect("all")}
        className={cn(
          "shrink-0 rounded-xl border px-3.5 py-2.5 text-sm font-medium transition-colors",
          selectedDay === "all"
            ? "border-forest bg-forest text-primary-foreground"
            : "border-line bg-cream-raised text-ink hover:border-forest-soft/60 hover:bg-sand/60",
        )}
      >
        All days
      </button>

      {days.map((day) => {
        const active = selectedDay === day.dayNumber;
        const dropping = isDropTarget?.(day.dayNumber) ?? false;
        return (
          <button
            key={day.dayNumber}
            type="button"
            id={`day-tab-${day.dayNumber}`}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            /*
             * The drop rectangle, on the tab itself.
             *
             * Only when a drop would mean something: `isDropTarget` is absent for a trip with no
             * saved place pool, and a `data-day-drop` there would offer a target no command could
             * be built for.
             */
            {...(isDropTarget ? { "data-day-drop": day.dayNumber } : {})}
            data-drop-active={dropping ? "true" : "false"}
            onClick={() => onSelect(day.dayNumber)}
            className={cn(
              "flex shrink-0 flex-col items-start gap-0.5 rounded-xl border px-3.5 py-2 text-left transition-colors",
              active
                ? "border-forest bg-forest text-primary-foreground"
                : "border-line bg-cream-raised hover:border-forest-soft/60 hover:bg-sand/60",
              /*
               * Drawn as a ring rather than by changing the fill, so the tab does not stop looking
               * like the selected day while a stop hovers over it — those are two different facts
               * and the traveller needs both at once.
               */
              dropping && "ring-2 ring-terracotta ring-offset-2 ring-offset-cream",
            )}
          >
            <span
              className={cn(
                "text-[0.625rem] font-semibold tracking-widest uppercase",
                active ? "text-primary-foreground/70" : "text-ink-muted",
              )}
            >
              {formatWeekdayShort(day.date)}
            </span>
            <span className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  "font-display text-lg leading-none",
                  active ? "text-primary-foreground" : "text-forest",
                )}
              >
                {formatDayOfMonth(day.date)}
              </span>
              <span
                className={cn(
                  "text-xs",
                  active ? "text-primary-foreground/70" : "text-ink-muted",
                )}
              >
                Day {day.dayNumber}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
