"use client";

import { ArrowUpRight, Compass, Trash2 } from "lucide-react";
import Link from "next/link";

import { StoragePanel } from "@/components/trip/storage-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateRange, formatMoney } from "@/lib/format";
import { useTripStore } from "@/lib/store/trip-store";
import { useTripStoreHydration } from "@/lib/store/use-hydration";

/**
 * Trips already in localStorage.
 *
 * Renders a skeleton until hydration completes, because the server has no way to
 * know what is in storage — showing "no trips yet" first and then swapping it
 * out would both flash and risk a hydration mismatch.
 */
export function SavedTrips() {
  const hydrated = useTripStoreHydration();
  const records = useTripStore((state) => state.records);
  const removeTrip = useTripStore((state) => state.removeTrip);

  if (!hydrated) {
    return (
      <section className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8">
        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-24 w-full rounded-2xl" />
        </div>
      </section>
    );
  }

  // Newest first, by the plan's own creation time. `record.updatedAt` moves
  // when routes are calculated, and re-ordering the list because someone routed
  // an old trip would be surprising.
  const entries = Object.values(records)
    .map((record) => record.plan)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  /**
   * The storage panel is shown *only* when there is something stored.
   *
   * A first-time visitor has no trips and nothing to manage, and a panel explaining browser quotas
   * before they have planned anything is noise. It appears with the first saved trip, which is also
   * the first moment losing one would matter.
   */
  if (entries.length === 0) return null;

  return (
    <section
      className="mx-auto w-full max-w-6xl px-5 pb-16 sm:px-8"
      aria-labelledby="saved-heading"
    >
      <div className="mb-4 flex items-center gap-2">
        <Compass aria-hidden className="size-4 text-terracotta" />
        <h2 id="saved-heading" className="eyebrow text-forest">
          Your saved trips
        </h2>
      </div>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((trip) => (
          <li key={trip.id}>
            <div className="group/trip relative flex h-full flex-col gap-3 rounded-2xl border border-line bg-cream-raised p-5 transition-shadow hover:shadow-card">
              <div className="flex flex-col gap-1">
                <p className="font-display text-xl text-forest">
                  {trip.request.departureCity} → {trip.destination.city}
                </p>
                <p className="text-xs text-ink-muted">
                  {formatDateRange(
                    trip.request.startDate,
                    trip.request.endDate,
                  )}{" "}
                  · {trip.days.length} days ·{" "}
                  {formatMoney(trip.budget.total, trip.budget.currency)}
                </p>
              </div>

              <div className="mt-auto flex items-center justify-between gap-2">
                <Link
                  href={`/trip/${trip.id}`}
                  className="inline-flex items-center gap-1 rounded-md text-sm font-medium text-forest underline-offset-4 hover:underline"
                >
                  Open plan
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </Link>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => removeTrip(trip.id)}
                  aria-label={`Delete the trip to ${trip.destination.city}`}
                  className="text-ink-muted hover:text-destructive"
                >
                  <Trash2 aria-hidden className="size-3.5" />
                </Button>
              </div>
            </div>
          </li>
        ))}
      </ul>

      {/*
        * Storage management sits under the list rather than in the workspace: it is about the
        * *collection*, and the decisions it offers — export, delete, free space — are ones a
        * traveller makes while looking at all their trips at once.
        */}
      <StoragePanel className="mt-6" />
    </section>
  );
}
