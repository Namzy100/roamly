import { DEFAULT_MODE_POLICY } from "@/lib/routing";
import {
  DEFAULT_EXISTING_SEGMENT_POLICY,
  type AppliedRoutingPolicy,
} from "@/lib/schemas";

/**
 * The default routing policy for a whole trip, and the one place partial
 * caller input is filled in.
 *
 * ## Why `allowDriveInMiddleBand` is on here
 *
 * `DEFAULT_MODE_POLICY` leaves the 1.8–8 km band undecided, which is the right
 * default for a *routing* call: the caller is asking for one leg and can say
 * what they want. It is the wrong default for a *trip*, where an undecided leg
 * silently produces no route at all and the traveller is told "pending" for a
 * journey we could perfectly well have described. Enabling driving in that band
 * makes every eligible leg answerable, and the mode is shown on the card, so
 * nothing is hidden — a traveller who disagrees can see that we routed 4 km as a
 * drive.
 *
 * This is a planning default and is overridable per request, like every other
 * threshold in `mode-policy.ts`.
 */
export const DEFAULT_ROUTING_POLICY: AppliedRoutingPolicy = {
  modePolicy: { ...DEFAULT_MODE_POLICY, allowDriveInMiddleBand: true },
  accommodation: "none",
  existingSegments: DEFAULT_EXISTING_SEGMENT_POLICY,
};

/**
 * Fills a partial policy from the defaults, without mutating the input.
 *
 * `modePolicy` is accepted partially — a caller who wants to move only the walk
 * threshold should not have to restate the other three fields, and requiring
 * them invites a copy-paste that silently drops a default.
 */
export type RoutingPolicyOverrides = {
  modePolicy?: Partial<AppliedRoutingPolicy["modePolicy"]>;
  accommodation?: AppliedRoutingPolicy["accommodation"];
  existingSegments?: AppliedRoutingPolicy["existingSegments"];
};

export function planRoutingPolicy(
  overrides: RoutingPolicyOverrides = {},
): AppliedRoutingPolicy {
  return {
    modePolicy: { ...DEFAULT_ROUTING_POLICY.modePolicy, ...overrides.modePolicy },
    accommodation:
      overrides.accommodation ?? DEFAULT_ROUTING_POLICY.accommodation,
    existingSegments:
      overrides.existingSegments ?? DEFAULT_ROUTING_POLICY.existingSegments,
  };
}
