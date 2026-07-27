"use client";

import { TripNotFound } from "@/components/states/trip-not-found";
import { WorkspaceSkeleton } from "@/components/states/workspace-skeleton";
import { TripWorkspace } from "@/components/trip/trip-workspace";
import { useTripGeneration, useTripPlan } from "@/lib/store/trip-store";
import { useTripStoreHydration } from "@/lib/store/use-hydration";

/**
 * Bridges the server-rendered route to client-only storage.
 *
 * The plan lives in localStorage, so its existence is unknowable until after
 * mount. The three states are explicit: not yet read, read and found, read and
 * missing. Rendering the workspace before hydration finishes would mean the
 * server's HTML (no trip) disagreed with the client's first paint.
 */
export function TripLoader({ tripId }: { tripId: string }) {
  const hydrated = useTripStoreHydration();
  const plan = useTripPlan(tripId);
  // Read from the same record, so a reload restores the pool and the provenance
  // along with the itinerary rather than losing them to the in-memory session.
  const generation = useTripGeneration(tripId);

  if (!hydrated) return <WorkspaceSkeleton />;
  if (!plan) return <TripNotFound tripId={tripId} />;

  return (
    <main className="flex flex-1 flex-col">
      <TripWorkspace plan={plan} generation={generation} />
    </main>
  );
}
