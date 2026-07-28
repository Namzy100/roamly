import {
  factKindIsOperational,
  type PlaceFact,
  type PlaceFactKind,
} from "./facts";
import type { ProviderId } from "./types";

/**
 * What to do when two sources disagree about one place.
 *
 * ## Disagreement is the normal case, not an error
 *
 * OSM says the café opens at 08:00; the provider says 08:30. Both are sincere, both may be out of date, and neither is
 * checkable from here. The tempting resolutions are all worse than they look:
 *
 *  - **newest wins** — rewards whichever source we happened to poll last, and quietly replaces a community-maintained
 *    fact with a commercial one on no evidence
 *  - **provider wins** — makes the paid source authoritative, which is a licensing problem as well as an accuracy one:
 *    OSM's value may be persisted and exported, the provider's may not
 *  - **average them, or take the midpoint** — meaningless for an opening time, and for anything reputational it
 *    manufactures a number no source stated
 *
 * Roamly does none of them. There is no timestamp comparison and no arithmetic anywhere in this module. A conflict is
 * **recorded, surfaced, and left unresolved** unless an *explicit rule* names an authority, and the fact is marked
 * `disputed` — which `display-policy.ts` refuses to render as fact. Showing "08:00 or 08:30, sources disagree" is more
 * use to somebody standing on the pavement than a confident wrong answer.
 *
 * ## Only operational facts can conflict
 *
 * Two providers reporting different ratings or review counts are **not** in conflict. They surveyed different people by
 * different methods, so both numbers are true of what they measured, and calling it a conflict would invite a resolution
 * — every one of which is a fabrication. `factKindIsOperational` draws the line, and reputational kinds are excluded
 * from conflict detection entirely (they are refused from entering at all, but the exclusion is stated independently so
 * it survives any future widening).
 *
 * ## An authority needs a written rule, not a default
 *
 * An earlier shape of this module preferred OSM whenever OSM was present. That is *silent* precedence, and silent
 * precedence is how a stale opening time beats a fresh one forever. `OFFICIAL_SOURCE_RULES` replaces it: a kind has an
 * authority only if a rule names one and says why. Two kinds do. Everything else stays unresolved and visible.
 */

/**
 * A kind where one source is the recorded authority, and the reason it is.
 *
 * Deliberately tiny. Each entry has to justify itself, and "it is usually right" is not a justification — the two here
 * are cases where the source is authoritative *by construction* rather than by reputation.
 */
export type OfficialSourceRule = {
  kind: PlaceFactKind;
  authority: ProviderId;
  reason: string;
};

export const OFFICIAL_SOURCE_RULES: readonly OfficialSourceRule[] = [
  {
    kind: "category",
    authority: "openstreetmap",
    reason:
      "The pool's category is what the itinerary's slots, cost class and same-category swap rule were all derived from. A provider overriding it would invalidate the plan built on it, so OSM is authoritative here by construction rather than by accuracy.",
  },
  {
    kind: "wikidata-id",
    authority: "wikidata",
    reason:
      "The identifier is Wikidata's own primary key. A source is definitionally authoritative about its own identifiers, so a third party disagreeing about a QID is simply wrong.",
  },
];

const AUTHORITY_BY_KIND = new Map<PlaceFactKind, OfficialSourceRule>(
  OFFICIAL_SOURCE_RULES.map((rule) => [rule.kind, rule]),
);

/** The rule naming an authority for this kind, or none. Absence means the conflict stays unresolved. */
export function officialSourceRuleFor(
  kind: PlaceFactKind,
): OfficialSourceRule | null {
  return AUTHORITY_BY_KIND.get(kind) ?? null;
}

export type ConflictResolution =
  /** Both values kept, neither shown as fact. The default and usually the end state. */
  | "unresolved"
  /** An explicit rule named an authority and that source is one of the claimants. */
  | "official-source"
  /** A person chose. Recorded so it is never silently recomputed. */
  | "manual";

export type FactConflict = {
  kind: PlaceFactKind;
  canonicalPlaceId: string;
  /** Every value in play, with the source that gave it. Never collapsed to a winner. */
  claims: { provider: ProviderId; value: PlaceFact["value"] }[];
  resolution: ConflictResolution;
  /** The rule that resolved it, when one did. Absent for `unresolved`. */
  rule?: OfficialSourceRule;
  /** Plain language, safe to render — this is what the traveller reads. */
  message: string;
};

/**
 * Values that differ only cosmetically, which should not be reported as disagreement.
 *
 * Trimmed and case-folded for strings; numbers and booleans compared exactly. Deliberately shallow: a real normaliser
 * for opening-hours strings or addresses belongs in the adapter that produced them, and doing it here would mean this
 * module quietly deciding that `Mo-Fr 09:00-17:00` and `Mon-Fri 9am-5pm` are the same string — a judgement with its own
 * failure modes.
 */
function valuesAgree(a: PlaceFact["value"], b: PlaceFact["value"]): boolean {
  if (typeof a === "string" && typeof b === "string") {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
  }
  return a === b;
}

/**
 * Every operational disagreement among a place's facts, grouped by kind.
 *
 * Facts of a kind only one source supplied are not conflicts, and neither are two sources agreeing — agreement is
 * handled in `merge.ts`, the only thing allowed to promote a fact to `corroborated`.
 *
 * Deterministic in output order: kinds are sorted, so two runs over the same facts produce the same list, which is what
 * makes a conflict banner stable across renders.
 */
export function detectConflicts(
  canonicalPlaceId: string,
  facts: PlaceFact[],
): FactConflict[] {
  const byKind = new Map<PlaceFactKind, PlaceFact[]>();

  for (const fact of facts) {
    /*
     * Reputational kinds are skipped here rather than filtered by the caller.
     *
     * Two ratings are two measurements, not a contradiction. Excluding them at the source means no downstream consumer
     * can accidentally treat "different ratings" as something needing resolution.
     */
    if (!factKindIsOperational(fact.kind)) continue;

    const existing = byKind.get(fact.kind);
    if (existing) existing.push(fact);
    else byKind.set(fact.kind, [fact]);
  }

  const conflicts: FactConflict[] = [];

  for (const kind of [...byKind.keys()].sort()) {
    const group = byKind.get(kind) as PlaceFact[];
    if (group.length < 2) continue;

    const first = group[0];
    if (group.every((fact) => valuesAgree(fact.value, first.value))) continue;

    const claims = group.map((fact) => ({
      provider: fact.provenance.provider,
      value: fact.value,
    }));

    const rule = officialSourceRuleFor(kind);
    const authorityPresent =
      rule !== null &&
      group.some((fact) => fact.provenance.provider === rule.authority);

    conflicts.push({
      kind,
      canonicalPlaceId,
      claims,
      resolution: authorityPresent ? "official-source" : "unresolved",
      ...(authorityPresent && rule ? { rule } : {}),
      message:
        authorityPresent && rule
          ? `Sources disagree about this place's ${humanise(kind)}. ${rule.authority} is the recorded authority for this field.`
          : `Sources disagree about this place's ${humanise(kind)}. Check before relying on it.`,
    });
  }

  return conflicts;
}

/**
 * The fact kinds whose value must not be shown as settled fact.
 *
 * An `official-source` resolution is deliberately **still** included. The authority's value is the one the plan is built
 * on and the one that may be exported, but the disagreement is real and the traveller is owed it — so the field is shown
 * with its conflict rather than as a settled answer. Only a person's decision (`manual`) settles a field.
 */
export function disputedKinds(
  conflicts: FactConflict[],
): ReadonlySet<PlaceFactKind> {
  return new Set(
    conflicts
      .filter((conflict) => conflict.resolution !== "manual")
      .map((conflict) => conflict.kind),
  );
}

function humanise(kind: PlaceFactKind): string {
  return kind.replace(/-/g, " ");
}
