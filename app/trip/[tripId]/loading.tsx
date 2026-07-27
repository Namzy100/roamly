import { WorkspaceSkeleton } from "@/components/states/workspace-skeleton";

/**
 * Segment-level loading UI. Covers the navigation itself; `TripLoader` shows the
 * same skeleton again for the localStorage read that follows.
 */
export default function TripLoading() {
  return <WorkspaceSkeleton />;
}
