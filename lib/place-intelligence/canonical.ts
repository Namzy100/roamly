import type { ExternalIdentity } from "./external-identity";
import type { PlaceFact } from "./facts";
import type { PlaceMedia } from "./media";
import type { ProviderId } from "./types";

/**
 * The canonical place, and everything hanging off it.
 *
 * ## Roamly's identity does not move
 *
 * `TripPlace.placeId` stays the canonical key, and this module does not redefine it — it references it.
 * A deliberate choice: `lib/schemas/place.ts` is where "verified" is defined and where pool validation
 * enforces it, and a second identity type here would be a second answer to "which place is this".
 *
 * So `canonicalPlaceId` below is a plain string that must equal a `TripPlace.placeId`. Not a branded
 * type, because the brand would have to be applied at the pool boundary to mean anything, and doing that
 * is a change to the verified-place domain rather than to this one.
 *
 * ## Why enrichment is a sidecar and not extra fields
 *
 * The obvious design is to widen `TripPlace` with `rating?`, `photos?`, `busyness?`. It is wrong for a
 * reason that only shows up at the storage boundary: `TripPlace` is compared **field by field** against
 * the pool by `assertItineraryUsesPool`, so any field added to it becomes part of the tampering check and
 * must be identical in the pool copy and the attached copy. An enrichment that refreshed independently
 * would read as tampering. A field that may not be persisted could not be stripped without failing the
 * comparison.
 *
 * A sidecar keyed by `canonicalPlaceId` avoids both. The verified record stays byte-stable and
 * licence-clean; enrichment refreshes, expires and is filtered on its own schedule; and dropping the
 * whole sidecar leaves a working trip, which is what makes the keyless fallback free.
 */

export type PlaceIntelligence = {
  /** Must equal a `TripPlace.placeId`. The join key, and the only identity here. */
  canonicalPlaceId: string;
  /** Outward pointers. At most one per provider — see `externalIdentityFor`. */
  identities: ExternalIdentity[];
  facts: PlaceFact[];
  media: PlaceMedia[];
};

/** An empty sidecar. The state every place is in before enrichment, and a valid one. */
export function emptyIntelligence(canonicalPlaceId: string): PlaceIntelligence {
  return { canonicalPlaceId, identities: [], facts: [], media: [] };
}

/**
 * The identity for one provider, or none.
 *
 * One per provider is an invariant rather than a convenience: two Foursquare ids for one OSM place means
 * the match went wrong, and silently picking the first would attach one of two venues' facts with no way
 * to tell which. `validate.ts` reports the duplicate; this returns the first, and callers that care
 * should have validated already.
 */
export function externalIdentityFor(
  intelligence: PlaceIntelligence,
  provider: ProviderId,
): ExternalIdentity | null {
  return (
    intelligence.identities.find((entry) => entry.provider === provider) ?? null
  );
}

/** Every fact of one kind, from every provider. Plural because two sources may both answer. */
export function factsOfKind(
  intelligence: PlaceIntelligence,
  kind: PlaceFact["kind"],
): PlaceFact[] {
  return intelligence.facts.filter((fact) => fact.kind === kind);
}

/**
 * Whether this sidecar carries anything at all.
 *
 * Used to decide whether to render an enrichment surface. An empty sidecar must produce no empty panel —
 * the same rule the itinerary card follows for an absent action row.
 */
export function intelligenceIsEmpty(intelligence: PlaceIntelligence): boolean {
  return (
    intelligence.facts.length === 0 &&
    intelligence.media.length === 0 &&
    intelligence.identities.length === 0
  );
}
