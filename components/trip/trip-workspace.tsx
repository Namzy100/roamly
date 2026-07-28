"use client";

import { List, MapPin } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { MapPanel } from "@/components/map/map-panel";
import { AccommodationCard } from "@/components/trip/accommodation-card";
import { BackupOptions } from "@/components/trip/backup-options";
import { BudgetPanel } from "@/components/trip/budget-panel";
import { DaySelector } from "@/components/trip/day-selector";
import { FlightEstimateCard } from "@/components/trip/flight-estimate-card";
import { GenerationProvenance } from "@/components/trip/generation-provenance";
import { ItineraryPanel } from "@/components/trip/itinerary-panel";
import { PracticalNotes } from "@/components/trip/practical-notes";
import { PlacePoolPanel } from "@/components/trip/place-pool-panel";
import { PlacementDialog, type PlacementRequest } from "@/components/trip/placement-dialog";
import { RefinePanel } from "@/components/trip/refine-panel";
import { ScheduleAccuracy } from "@/components/trip/schedule-accuracy";
import { RoutingControls } from "@/components/trip/routing-controls";
import { TripHeader } from "@/components/trip/trip-header";
import { AiStatusResponseSchema, type AiStatusResponse } from "@/lib/api/generate-contract";
import { useItemReorder } from "@/lib/hooks/use-item-reorder";
import { LG_QUERY, useMediaQuery } from "@/lib/hooks/use-media-query";
import { useTripRefinement } from "@/lib/hooks/use-trip-refinement";
import { useStructuralEdits } from "@/lib/hooks/use-structural-edits";
import {
  buildScheduleAccuracyReport,
  evaluatePlanItems,
} from "@/lib/plan/schedule-report";
import type { StructuralEditCommand } from "@/lib/refinement/commands";
import { canRefinePlaces } from "@/lib/refinement/eligibility";
import { hoursConflictCandidates } from "@/lib/refinement/resolve-hours";
import { alternativesForItem } from "@/lib/structural-edits/alternatives";
import { describeEditedItem } from "@/lib/structural-edits/preview-item";
import {
  stopAlternatives,
  type StopAlternative,
} from "@/lib/structural-edits/stop-alternatives";
import { freeWindowForItem } from "@/lib/structural-edits/set-schedule";
import { findOpenSlotForItem } from "@/lib/plan/schedule-repair";
import { deriveMapRouteLines } from "@/lib/map/derive-routes";
import { deriveVisibleMapPlaces, reconcileSelection } from "@/lib/map/derive";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";
import { useWorkspaceStore } from "@/lib/store/workspace-store";
import { getVisibleItems } from "@/lib/trip/visible-items";
import { cn } from "@/lib/utils";

/**
 * The split-screen workspace.
 *
 * Layout, by breakpoint:
 *  - mobile  — one column, Plan/Map segmented toggle, map fills the viewport
 *  - tablet  — one column, map inlined above the itinerary at a fixed height
 *  - desktop — two columns, itinerary scrolls, map sticky beside it
 *
 * Selection state lives in `useWorkspaceStore` rather than here so the itinerary
 * and the map stay decoupled: both write the same field, both read it, and
 * neither holds a reference to the other.
 */
export function TripWorkspace({
  plan,
  generation,
}: {
  plan: TripPlan;
  /**
   * Null for the fixed sample and for trips saved before generation existed. The
   * provenance panel renders nothing in that case — the header's template banner has
   * already said what such a plan is.
   */
  generation: TripGenerationContext | null;
}) {
  const selectedDay = useWorkspaceStore((state) => state.selectedDay);
  const selectedItemId = useWorkspaceStore((state) => state.selectedItemId);
  const hoveredItemId = useWorkspaceStore((state) => state.hoveredItemId);
  const selectionSource = useWorkspaceStore((state) => state.selectionSource);
  const mobilePane = useWorkspaceStore((state) => state.mobilePane);
  const selectDay = useWorkspaceStore((state) => state.selectDay);
  const selectItem = useWorkspaceStore((state) => state.selectItem);
  const hoverItem = useWorkspaceStore((state) => state.hoverItem);
  const setMobilePane = useWorkspaceStore((state) => state.setMobilePane);
  const reset = useWorkspaceStore((state) => state.reset);

  // Opening a different trip must not inherit the previous trip's selection.
  useEffect(() => {
    reset();
  }, [plan.id, reset]);

  const visibleItems = useMemo(
    () => getVisibleItems(plan, selectedDay),
    [plan, selectedDay],
  );

  const activeDay =
    selectedDay === "all"
      ? null
      : (plan.days.find((day) => day.dayNumber === selectedDay) ?? null);

  const dayLabel =
    activeDay === null
      ? `All ${plan.days.length} days · ${visibleItems.length} stops`
      : `Day ${activeDay.dayNumber} · ${activeDay.items.length} stops`;

  const backups = activeDay
    ? activeDay.backups
    : plan.days.flatMap((day) => day.backups);

  /**
   * The map's view of the world: plain data only, derived once here. The map
   * layer receives no plan, no schema type and no store handle.
   */
  const mapPlaces = useMemo(
    () => deriveVisibleMapPlaces(plan, selectedDay),
    [plan, selectedDay],
  );

  /**
   * Real routed geometry, from the plan itself. Empty until the traveller asks
   * for routes, and restored for free on a reload because it lives on the
   * validated plan rather than in memory.
   */
  const mapRoutes = useMemo(
    () => deriveMapRouteLines(plan, selectedDay, { selectedItemId }),
    [plan, selectedDay, selectedItemId],
  );

  /**
   * A card can be selected that the map does not show — an unavailable slot, or a
   * stop with no single location. Reconciling here means the map renders no
   * selection rather than a stale one.
   */
  const mapSelectedItemId = reconcileSelection(selectedItemId, mapPlaces);

  /**
   * Whether the map's container actually has dimensions. Below `lg` the map is
   * `display: none` while the Plan tab is active, and a map initialised at 0×0
   * needs an explicit resize once it is shown.
   */
  const isDesktop = useMediaQuery(LG_QUERY);
  const mapIsVisible = isDesktop || mobilePane === "map";

  /**
   * Refinement.
   *
   * The hook holds all of it — which endpoint each action goes to, the guarded save,
   * the undo. This component only decides what to show.
   */
  const refinement = useTripRefinement(plan.id);

  /**
   * Structural edits and pool refresh (Phase 6C).
   *
   * A second hook rather than more surface on the first: these need no planner and no routing
   * service, and their workflow state is a multi-step preview rather than a single job. Folding
   * them in would give one hook two unrelated lifecycles.
   */
  const structural = useStructuralEdits(plan.id);

  /**
   * The open placement dialog, if any.
   *
   * Held here because both entry points — a backup card and an itinerary row — open the same
   * dialog, and the trigger that opened it is where focus must return.
   */
  const [placement, setPlacement] = useState<
    | { request: PlacementRequest; kind: "promote"; backupId: string }
    | { request: PlacementRequest; kind: "move"; itemId: string }
    | null
  >(null);

  const closePlacement = () => {
    setPlacement(null);
    structural.dismissEdit();
  };

  /**
   * The clock, read once when this component first mounts.
   *
   * Safe in a `useState` initialiser because `TripLoader` renders the workspace only *after*
   * store hydration — so this component never renders on the server, and there is no first
   * paint for a clock reading to disagree with. Reading it on every render would instead make
   * the pool-age label change under a hover.
   */
  const [now] = useState(() => new Date());

  /**
   * Whether an AI planner is configured.
   *
   * Read once, and only to decide whether to *offer* the AI actions. The server
   * refuses an unmeetable request regardless — this exists so a traveller is not
   * offered a button that will explain itself only after they press it.
   */
  const [availability, setAvailability] = useState<AiStatusResponse | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/ai/status", { signal: controller.signal })
      .then((response) => response.json())
      .then((json: unknown) => {
        const parsed = AiStatusResponseSchema.safeParse(json);
        if (parsed.success) setAvailability(parsed.data);
      })
      .catch(() => {
        // Null stays "not yet known"; the panel treats it as no model and the demo
        // path is unaffected.
      });
    return () => controller.abort();
  }, []);

  /** Which day a flattened backup belongs to, for the All Days view. */
  const dayNumberOfBackup = useMemo(() => {
    const index = new Map<string, number>();
    for (const day of plan.days) {
      for (const backup of day.backups) index.set(backup.id, day.dayNumber);
    }
    return (backupId: string) => index.get(backupId) ?? null;
  }, [plan.days]);

  const runningTargetId =
    refinement.job.status === "running" ? (refinement.job.targetId ?? null) : null;

  /**
   * The opening-hours verdicts, derived once per plan (Phase 6B).
   *
   * Derived rather than read from the plan, for the same reason the coverage counts are:
   * the parser and the curated timezone table will change, and a stored verdict could only
   * drift — in the worst direction, telling a traveller their schedule was checked by a
   * parser that no longer exists. Memoised on the plan and the zone, so a hover does not
   * re-parse nine `opening_hours` strings.
   */
  const timezone = generation?.destinationTimezone?.timezone ?? null;

  const openingHoursByItemId = useMemo(
    () =>
      new Map(
        evaluatePlanItems({ plan, timezone }).map((entry) => [
          entry.itemId,
          entry.evaluation,
        ]),
      ),
    [plan, timezone],
  );

  const scheduleReport = useMemo(
    () => buildScheduleAccuracyReport({ plan, timezone }),
    [plan, timezone],
  );

  /**
   * Whether a conflicted stop has anywhere to move to.
   *
   * Asked through the same slot-finder the repair itself uses, so the button appears exactly
   * when pressing it would work. Two answers to "does this fit" would eventually differ, and
   * the difference would show as a control that fails.
   */
  const hasOpenSlot = (conflict: { dayNumber: number; itemId: string }) => {
    if (!timezone) return false;
    const day = plan.days.find((entry) => entry.dayNumber === conflict.dayNumber);
    const item = day?.items.find((entry) => entry.id === conflict.itemId);
    if (!day || !item) return false;

    return (
      findOpenSlotForItem({ item, items: day.items, day, timezone }) !== null
    );
  };

  /**
   * The same answer the refine panel uses.
   *
   * A per-stop "Replace" that appears when no planner can act on this trip is a button
   * that cannot work — so the itinerary and the panel are gated on one shared
   * predicate rather than two similar-looking conditions.
   */
  const canReplacePlaces = canRefinePlaces({
    generation,
    modelAvailable: availability?.modelAvailable ?? null,
  });

  /**
   * Structural editing, as three small functions handed to the itinerary.
   *
   * All of it gated on `generation !== null`: a trip with no saved place search has no pool to
   * verify an edit against, so the controls are absent rather than present-and-failing. The panel
   * reads a missing handler as a missing capability, which is the same convention `onReplaceItem`
   * already follows — one condition, not a handler plus a `canEdit` flag that could disagree.
   */
  const canEditStructure = generation !== null;

  /** One command in, one save. The panel never sees the store, the revision, or the outcome. */
  const runCommand = (command: StructuralEditCommand) => {
    void structural.run(command);
  };

  /**
   * The refusal a command *would* produce, or null.
   *
   * `structural.preview` is the real applier stopped short of writing, so a time editor that asks
   * this shows the same sentence the save would — never an approximation of it.
   */
  const checkCommand = (command: StructuralEditCommand) => {
    const prepared = structural.preview(command);
    return prepared.status === "refused" ? prepared.message : null;
  };

  /**
   * The same preview, read for *where a stop would end up* rather than merely whether it may.
   *
   * The length editor states the resulting times and the drag indicator states the landing slot, so
   * both need the plan the edit would produce, not a yes or no. One `preview` call underneath, so a
   * form's promise and a save's outcome are the same computation.
   *
   * The stop is named by the caller rather than dug out of the command. Only some commands carry an
   * `itemId`, and a helper that guessed would answer `insert-free-time` with the wrong stop rather
   * than with nothing.
   */
  const describeCommand = (command: StructuralEditCommand, itemId: string) =>
    describeEditedItem(structural.preview(command), itemId);

  /**
   * The open stop's alternatives, described — and memoised, which is not optional here.
   *
   * `stopAlternatives` runs the real applier once per alternative, so one call is up to five full
   * plan applications and five schema parses. The panel re-renders on hover, and hovering a card
   * moves the pointer across a list of them, so an unmemoised derivation would do that work dozens
   * of times a second for a picker whose contents cannot have changed.
   *
   * The key is the revision plus the stop, because the revision is what moves when the plan does:
   * every structural edit and every refinement bumps it under the same guard, so a cached answer
   * outliving the plan it described is not a state this can reach. `plan`, `generation` and
   * `timezone` stay in the dependency list for the one case the revision does not cover — a
   * different trip's record arriving under the same revision number.
   */
  const comparisonCache = useRef<{
    key: string;
    value: StopAlternative[];
  } | null>(null);

  const alternativeComparisonsFor = useCallback(
    ({ dayNumber, itemId }: { dayNumber: number; itemId: string }) => {
      const key = `${structural.revision ?? "none"}:${dayNumber}:${itemId}`;
      if (comparisonCache.current?.key === key) {
        return comparisonCache.current.value;
      }

      const value = stopAlternatives({
        plan,
        generation,
        dayNumber,
        itemId,
        timezone,
        revisionBefore: structural.revision ?? 0,
      });

      comparisonCache.current = { key, value };
      return value;
    },
    [plan, generation, timezone, structural.revision],
  );

  /**
   * Reordering by drag or by keyboard (Phase 8).
   *
   * Handed the hook's own `preview` and `run`, so a completed drag is a `move-item` going through
   * the single execution path — the same one the placement dialog and every card control use. The
   * hook is created unconditionally, because hooks must be, and simply never offered to the
   * interface when the trip has no pool to verify a move against.
   */
  const reorder = useItemReorder({
    days: plan.days,
    disabled: structural.isBusy,
    preview: structural.preview,
    run: runCommand,
  });

  return (
    <div className="flex flex-1 flex-col">
      <TripHeader plan={plan} />

      {/* Sticky controls: the day switcher stays reachable while scrolling. */}
      <div className="sticky top-16 z-30 border-b border-line bg-cream/90 px-5 py-3 backdrop-blur-md sm:px-8">
        <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-3">
          <DaySelector
            days={plan.days}
            selectedDay={selectedDay}
            onSelect={selectDay}
            {...(canEditStructure ? { isDropTarget: reorder.isTargetDay } : {})}
          />

          {/* Plan/Map toggle — mobile only. */}
          <div
            role="tablist"
            aria-label="Switch between plan and map"
            className="flex gap-1 rounded-full border border-line bg-cream-raised p-1 lg:hidden"
          >
            {(
              [
                { value: "plan", label: "Plan", icon: List },
                { value: "map", label: "Map", icon: MapPin },
              ] as const
            ).map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mobilePane === value}
                onClick={() => setMobilePane(value)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-2 text-sm font-medium transition-colors",
                  mobilePane === value
                    ? "bg-forest text-primary-foreground"
                    : "text-ink-muted hover:text-forest",
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/*
        * A successful edit closes the dialog; a failure keeps it open with the reason.
        *
        * That asymmetry is deliberate. A failure is nearly always fixable *in the dialog* — a
        * different position, or explicit times — so dropping the traveller back to the
        * itinerary would be the wrong answer to "there is no free gap there". Derived rather
        * than set from an effect, which would be a cascading render for no gain.
        */}
      {placement && structural.edit.status !== "success" ? (
        <PlacementDialog
          request={placement.request}
          days={plan.days}
          timezone={timezone}
          busy={structural.edit.status === "saving"}
          errorMessage={
            structural.edit.status === "error" ||
            structural.edit.status === "conflict"
              ? structural.edit.message
              : null
          }
          onCancel={closePlacement}
          onConfirm={(choice) => {
            /*
             * Both branches build a command and hand it to the one execution path.
             *
             * The dialog collects a day, a position and optionally a time — which is precisely
             * what differs between these two commands and nothing else. There is no
             * promote-specific or move-specific save behaviour left for either to get wrong.
             */
            void structural.run(
              placement.kind === "promote"
                ? {
                    type: "promote-backup",
                    sourceDayNumber: placement.request.sourceDayNumber,
                    backupId: placement.backupId,
                    ...choice,
                  }
                : {
                    type: "move-item",
                    sourceDayNumber: placement.request.sourceDayNumber,
                    itemId: placement.itemId,
                    ...choice,
                  },
            );
          }}
        />
      ) : null}

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col gap-6 px-5 py-6 sm:px-8 lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(24rem,26rem)] lg:items-start lg:gap-8">
        {/* Itinerary column */}
        <div
          className={cn(
            "flex min-w-0 flex-col gap-8",
            mobilePane === "map" && "hidden lg:flex",
          )}
        >
          <ItineraryPanel
            days={plan.days}
            visibleItems={visibleItems}
            selectedDay={selectedDay}
            selectedItemId={selectedItemId}
            hoveredItemId={hoveredItemId}
            selectionSource={selectionSource}
            currency={plan.budget.currency}
            onSelectItem={(itemId) => selectItem(itemId, "list")}
            onHoverItem={hoverItem}
            canReplace={canReplacePlaces}
            busyItemId={
              refinement.job.status === "running" &&
              refinement.job.action === "replace-item"
                ? runningTargetId
                : null
            }
            busyLegId={
              refinement.job.status === "running" &&
              refinement.job.action === "retry-routes"
                ? runningTargetId
                : null
            }
            onReplaceItem={({ dayNumber, itemId }) =>
              void refinement.refine(
                { type: "replace-item", dayNumber, itemId },
                { targetId: itemId },
              )
            }
            onRetryRoute={(legId) =>
              void refinement.retryRoutes({
                type: "retry-routes",
                scope: "unavailable-only",
                legIds: [legId],
              })
            }
            openingHoursByItemId={openingHoursByItemId}
            editBusy={structural.isBusy}
            {...(canEditStructure
              ? {
                  onCommand: runCommand,
                  checkCommand,
                  describeCommand,
                  reorder,
                  /*
                   * Derived per stop on demand rather than for every stop up front.
                   *
                   * The panel asks only for the stops it is rendering, and the answer feeds both the
                   * Swap control's presence and its count — so a control that appears and a list
                   * that is empty cannot come apart.
                   */
                  alternativesFor: ({
                    dayNumber,
                    itemId,
                  }: {
                    dayNumber: number;
                    itemId: string;
                  }) =>
                    alternativesForItem({
                      plan,
                      generation,
                      dayNumber,
                      itemId,
                      timezone,
                    }),
                  /*
                   * The described version, asked for only by the picker that is open.
                   *
                   * Same derivation underneath, so this list and the count on the Swap control
                   * cannot come apart — but this one runs the applier per alternative, which is
                   * why it is a second callback rather than a richer return from the first.
                   */
                  alternativeComparisonsFor,
                  freeWindowFor: ({
                    dayNumber,
                    itemId,
                  }: {
                    dayNumber: number;
                    itemId: string;
                  }) => freeWindowForItem(plan, dayNumber, itemId),
                }
              : {})}
            canMoveItems={generation !== null}
            onMoveItem={({ dayNumber, itemId }) => {
              const day = plan.days.find((entry) => entry.dayNumber === dayNumber);
              const item = day?.items.find((entry) => entry.id === itemId);
              if (!item) return;

              structural.dismissEdit();
              setPlacement({
                kind: "move",
                itemId,
                request: {
                  label: `Move “${item.title}”`,
                  sourceDayNumber: dayNumber,
                  item,
                  kind: item.kind,
                  ...(item.place?.openingHours
                    ? { openingHours: item.place.openingHours }
                    : {}),
                  ...(item.place ? { placeName: item.place.name } : {}),
                },
              });
            }}
          />

          {/*
            * Schedule accuracy sits directly under the itinerary, because every row in it
            * points at a card above. Its repairs are deterministic and local — no model, no
            * network — so they are offered whatever the AI availability is.
            */}
          <ScheduleAccuracy
            report={scheduleReport}
            busy={refinement.isRunning}
            candidatesFor={(conflict) =>
              hoursConflictCandidates({
                plan,
                generation,
                dayNumber: conflict.dayNumber,
                itemId: conflict.itemId,
                timezone,
              })
            }
            canAdjustTime={(conflict) => hasOpenSlot(conflict)}
            onAdjustTime={(conflict) =>
              refinement.resolveHoursConflict({
                dayNumber: conflict.dayNumber,
                itemId: conflict.itemId,
                resolution: { kind: "adjust-time" },
              })
            }
            onMarkUnavailable={(conflict) =>
              refinement.resolveHoursConflict({
                dayNumber: conflict.dayNumber,
                itemId: conflict.itemId,
                resolution: { kind: "mark-unavailable" },
              })
            }
            onReplacePlace={(conflict, placeId) =>
              refinement.resolveHoursConflict({
                dayNumber: conflict.dayNumber,
                itemId: conflict.itemId,
                resolution: { kind: "replace-place", placeId },
              })
            }
          />

          {/*
           * Provenance sits above the routing action deliberately: it is where the
           * "routes have not been calculated yet" line lives, and reading that
           * immediately before the button that calculates them is the order that
           * makes sense.
           */}
          <GenerationProvenance plan={plan} generation={generation} />

          {/*
            * Refinement sits above routing: a change to the itinerary is what makes
            * routes need recalculating, so reading the two in that order matches the
            * order a traveller actually works in.
            */}
          <RefinePanel
            plan={plan}
            generation={generation}
            availability={availability}
            job={refinement.job}
            selectedDay={selectedDay === "all" ? null : selectedDay}
            undoableAction={refinement.undoableAction}
            redoableAction={refinement.redoableAction}
            undoDepth={refinement.undoDepth}
            redoDepth={refinement.redoDepth}
            onRegenerate={() =>
              void refinement.refine({ type: "regenerate-trip" })
            }
            onAdjustDay={(dayNumber, adjustment) =>
              void refinement.refine({ type: "adjust-day", dayNumber, adjustment })
            }
            onRetryRoutes={(scope) =>
              void refinement.retryRoutes({ type: "retry-routes", scope })
            }
            onRecalculateEstimates={refinement.recalculateEstimates}
            onUndo={refinement.undo}
            onRedo={refinement.redo}
            onCancel={refinement.cancel}
            onDismiss={refinement.dismiss}
          />

          <RoutingControls plan={plan} />

          <BackupOptions
            backups={backups}
            currency={plan.budget.currency}
            canReplace={canReplacePlaces}
            dayNumberOf={dayNumberOfBackup}
            busyBackupId={
              refinement.job.status === "running" &&
              refinement.job.action === "replace-backup"
                ? runningTargetId
                : null
            }
            onReplace={({ dayNumber, backupId }) =>
              void refinement.refine(
                { type: "replace-backup", dayNumber, backupId },
                { targetId: backupId },
              )
            }
            canPromote={generation !== null}
            onPromote={({ dayNumber, backupId }) => {
              const day = plan.days.find((entry) => entry.dayNumber === dayNumber);
              const backup = day?.backups.find((entry) => entry.id === backupId);
              if (!backup) return;

              structural.dismissEdit();
              setPlacement({
                kind: "promote",
                backupId,
                request: {
                  label: `Add “${backup.title}” to the itinerary`,
                  sourceDayNumber: dayNumber,
                  kind: backup.kind,
                  ...(backup.place.openingHours
                    ? { openingHours: backup.place.openingHours }
                    : {}),
                  placeName: backup.place.name,
                },
              });
            }}
          />

          {/*
            * The place pool sits with the reference panels rather than with the actions: it is
            * something a traveller reads to decide whether refreshing is worth it, and the
            * refresh flow unfolds in place beneath it.
            */}
          <PlacePoolPanel
            generation={generation}
            now={now}
            state={structural.refresh}
            onBegin={structural.beginRefresh}
            onRun={(policy) => void structural.runRefresh({ policy })}
            onApply={structural.applyRefresh}
            onCancel={structural.cancelRefresh}
            onDismiss={structural.dismissRefresh}
          />

          {/*
           * Reference panels live in the scrolling column, not beside the map.
           * A sticky element cannot share a column with siblings in normal flow
           * — they scroll straight over it. Keeping the map alone on the right
           * is what lets it stay pinned, and these panels are read once anyway
           * rather than scanned repeatedly like the day cards.
           */}
          <div className="grid gap-5 sm:grid-cols-2">
            <BudgetPanel budget={plan.budget} />
            <div className="flex flex-col gap-5">
              <FlightEstimateCard
                flights={plan.flights}
                currency={plan.budget.currency}
                travelers={plan.request.travelers}
              />
              <AccommodationCard
                accommodation={plan.accommodation}
                currency={plan.budget.currency}
              />
            </div>
          </div>

          <PracticalNotes
            notes={plan.practicalNotes}
            destination={plan.destination}
          />
        </div>

        {/*
         * Map column — nothing else lives here, which is precisely what allows
         * the map to stay pinned. The offset clears the site header (4rem) plus
         * the day-selector bar.
         */}
        <div
          className={cn(
            "min-w-0",
            mobilePane === "plan" && "hidden lg:block",
            "h-[calc(100dvh-19rem)] min-h-[20rem] sm:h-[26rem] lg:sticky lg:top-36 lg:h-[calc(100dvh-11rem)] lg:max-h-[42rem]",
          )}
        >
          <MapPanel
            places={mapPlaces}
            routes={mapRoutes}
            selectedItemId={mapSelectedItemId}
            activeDayNumber={selectedDay}
            onSelectItem={selectItem}
            dayLabel={dayLabel}
            isVisible={mapIsVisible}
          />
        </div>
      </div>
    </div>
  );
}
