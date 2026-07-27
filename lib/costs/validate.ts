import { AccommodationStyleSchema, CurrencySchema } from "@/lib/schemas";
import { bandFor } from "@/lib/plan/cost-bands";

import { DESTINATION_COST_PROFILES } from "./profiles";
import type {
  BudgetAllocation,
  CostClassKey,
  DestinationCostProfile,
} from "./types";

/**
 * Mechanical checks on the cost domain.
 *
 * ## Why these are functions rather than tests
 *
 * The allocation identity is the kind of property that is easy to state and easy to break
 * by a plausible-looking edit — adding a category, changing a rounding step. Stating it as
 * a function means the *production* code can assert it before a figure reaches a traveller,
 * not only the test suite.
 *
 * `validateProfileTable` is the same discipline applied to hand-entered data: a typo in a
 * weight that makes a profile sum to 0.9 would allocate 10 % of a budget to nothing, and no
 * amount of review reliably catches that. It is asserted instead.
 *
 * Neither function is allowed to *repair* anything. A cost figure that does not reconcile is
 * a bug in this domain, and silently correcting it would leave the bug in place with the
 * symptom hidden.
 */

export type ValidationIssue = {
  code:
    | "allocation_does_not_reconcile"
    | "negative_allocation"
    | "weights_do_not_sum"
    | "negative_weight"
    | "duplicate_profile_id"
    | "duplicate_destination_key"
    | "missing_cost_class"
    | "invalid_band_order"
    | "non_positive_multiplier"
    | "missing_source_note"
    | "band_missing_for_currency";
  message: string;
};

/** Cents. Money is rounded to the cent, so exactness is exactness at that resolution. */
const CENT = 0.005;

/**
 * The identity the budget panel depends on:
 * `flights + accommodation + food + activities + localTransport + buffer = budget`.
 *
 * Checked to within half a cent rather than with `===` because the addends are themselves
 * cent-rounded; anything larger than that is a real leak, not floating-point noise.
 */
export function validateAllocation(
  allocation: BudgetAllocation,
  budget: number,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const parts = {
    flights: allocation.flights,
    accommodation: allocation.accommodation,
    food: allocation.food,
    activities: allocation.activities,
    localTransport: allocation.localTransport,
    buffer: allocation.buffer,
  };

  for (const [name, amount] of Object.entries(parts)) {
    if (amount < 0) {
      issues.push({
        code: "negative_allocation",
        message: `The ${name} allocation is negative (${amount}), which cannot be spent.`,
      });
    }
  }

  const total = Object.values(parts).reduce((sum, amount) => sum + amount, 0);
  if (Math.abs(total - budget) > CENT) {
    issues.push({
      code: "allocation_does_not_reconcile",
      message: `The allocated categories total ${total.toFixed(2)} against a budget of ${budget.toFixed(2)}.`,
    });
  }

  return issues;
}

/** Throwing form, for the moment before a figure is shown to someone. */
export function assertAllocationReconciles(
  allocation: BudgetAllocation,
  budget: number,
): void {
  const issues = validateAllocation(allocation, budget);
  if (issues.length > 0) {
    throw new Error(
      `Budget allocation is not valid: ${issues.map((issue) => issue.message).join(" ")}`,
    );
  }
}

const REQUIRED_COST_CLASSES: CostClassKey[] = [
  "snack",
  "casual-meal",
  "sit-down-meal",
  "premium-meal",
  "ticket",
  "night",
];

// Read from the schema rather than restated, so a new style cannot be added to the
// vocabulary without this check noticing that no profile prices it.
const ACCOMMODATION_STYLES = AccommodationStyleSchema.options;

/**
 * The curated table, checked for the mistakes hand-entered data actually makes.
 *
 * Weights that do not sum to one, a band whose `low` exceeds its `high`, a duplicated
 * destination key that would make the lookup order decide the answer, a multiplier of zero
 * that would silently price a whole category at the band floor.
 */
export function validateProfileTable(
  profiles: DestinationCostProfile[] = DESTINATION_COST_PROFILES,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();
  const seenKeys = new Map<string, string>();

  for (const profile of profiles) {
    if (seenIds.has(profile.profileId)) {
      issues.push({
        code: "duplicate_profile_id",
        message: `Two profiles share the id ${profile.profileId}.`,
      });
    }
    seenIds.add(profile.profileId);

    for (const key of profile.destinationKeys) {
      const owner = seenKeys.get(key);
      if (owner) {
        issues.push({
          code: "duplicate_destination_key",
          message: `The destination key "${key}" is claimed by both ${owner} and ${profile.profileId}, so lookup order would decide the answer.`,
        });
      } else {
        seenKeys.set(key, profile.profileId);
      }
    }

    if (profile.sourceNote.trim().length === 0) {
      issues.push({
        code: "missing_source_note",
        message: `${profile.profileId} has no source note, so a reader cannot tell what its numbers are based on.`,
      });
    }

    issues.push(...validateWeights(profile));
    issues.push(...validateBands(profile));
  }

  return issues;
}

function validateWeights(profile: DestinationCostProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entries = Object.entries(profile.weights);

  for (const [name, weight] of entries) {
    if (weight < 0) {
      issues.push({
        code: "negative_weight",
        message: `${profile.profileId} has a negative ${name} weight (${weight}).`,
      });
    }
  }

  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  /**
   * A tenth of a percent of slack, because these are hand-entered decimals.
   *
   * The allocator renormalises, so a table that summed to 0.97 would still reconcile — it
   * would just quietly mean something different from what was written down. The check is
   * about the data saying what its author meant, not about the arithmetic being safe.
   */
  if (Math.abs(total - 1) > 0.001) {
    issues.push({
      code: "weights_do_not_sum",
      message: `${profile.profileId} weights sum to ${total.toFixed(4)} rather than 1.`,
    });
  }

  return issues;
}

function validateBands(profile: DestinationCostProfile): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const costClass of REQUIRED_COST_CLASSES) {
    const band = profile.relativeCost[costClass];
    if (!band) {
      issues.push({
        code: "missing_cost_class",
        message: `${profile.profileId} does not price ${costClass}.`,
      });
      continue;
    }

    if (!(band.low <= band.typical && band.typical <= band.high)) {
      issues.push({
        code: "invalid_band_order",
        message: `${profile.profileId} ${costClass} band is out of order: ${band.low}/${band.typical}/${band.high}.`,
      });
    }
    if (band.typical <= 0) {
      issues.push({
        code: "non_positive_multiplier",
        message: `${profile.profileId} ${costClass} has a typical multiplier of ${band.typical}, which is not a relative cost.`,
      });
    }
  }

  for (const style of ACCOMMODATION_STYLES) {
    const band = profile.accommodation[style];
    if (!band) {
      issues.push({
        code: "missing_cost_class",
        message: `${profile.profileId} does not price the ${style} accommodation style.`,
      });
      continue;
    }
    if (!(band.low <= band.typical && band.typical <= band.high)) {
      issues.push({
        code: "invalid_band_order",
        message: `${profile.profileId} ${style} band is out of order.`,
      });
    }
  }

  return issues;
}

/**
 * Every currency has an absolute band for every class a profile prices.
 *
 * The two tables are separate on purpose — the profile decides shape, the band decides
 * plausibility — and this is the seam where a class added to one and not the other would
 * otherwise surface as an undefined band at estimate time.
 */
export function validateBandCoverage(): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const currency of CurrencySchema.options) {
    for (const costClass of REQUIRED_COST_CLASSES) {
      const band = bandFor(currency, costClass);
      if (!band || !Number.isFinite(band.typical)) {
        issues.push({
          code: "band_missing_for_currency",
          message: `No ${currency} band for ${costClass}.`,
        });
      }
    }
  }

  return issues;
}
