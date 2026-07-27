import type { GenerationViolation } from "../schemas";

import { ASSEMBLY_SYSTEM_INSTRUCTION } from "./assembly";
import { STRATEGY_SYSTEM_INSTRUCTION } from "./strategy";

/**
 * The repair instruction.
 *
 * ## Why it is the original prompt plus an addendum
 *
 * A repair pass must produce something the *same* validator accepts, so it needs
 * the same contract, the same schema and the same prohibitions. Writing a second,
 * shorter prompt would mean two descriptions of one contract, and the shorter one
 * would drift — the classic way a repair pass starts producing output the main
 * path rejects.
 *
 * Appending also keeps the cacheable prefix intact: the original instruction is
 * byte-identical up to the addendum, so a provider that caches prompt prefixes
 * still gets a hit on the expensive part.
 *
 * ## The permissions are stated as a closed list
 *
 * A repair is a narrow operation and the temptation is to treat it as "try again,
 * better". It is not. The candidate pool is fixed, the request is fixed, and no
 * new search happens — so the only moves available are reselection, removal,
 * rescheduling and honest surrender. Saying so explicitly is what stops a repair
 * pass "fixing" a missing café by inventing one.
 */

const SHARED_RULES = `
# You are repairing a previous answer

Your last answer was checked mechanically and rejected. The problems are listed below.

Return a **complete, corrected object** of the same shape — not a patch, not a diff, not only the changed parts. Everything that was already correct should come back unchanged.

## What you may change

- select a different place from the candidate list you were already given
- remove an optional stop that was causing a conflict
- move times so nothing overlaps and every stop ends after it starts
- replace a slot you cannot fill with an item of kind "unavailable"
- reduce a cost estimate
- make a day less packed

## What you may not change

- the candidate list. No new search happens, and no place outside the list exists.
- any fact about a candidate: its name, coordinates, category, address or identity
- the traveller's request: dates, day count, budget, currency, party size, pace
- any travel duration, distance or route
- ratings, review counts or price levels. You have none and cannot acquire any.

This is your **only** repair attempt. If a problem cannot be fixed within these rules, use the "unavailable" arm and explain it, rather than working around it with something invented.
`;

export function strategyRepairSystemInstruction(): string {
  return `${STRATEGY_SYSTEM_INSTRUCTION}\n${SHARED_RULES}`;
}

export function assemblyRepairSystemInstruction(): string {
  return `${ASSEMBLY_SYSTEM_INSTRUCTION}\n${SHARED_RULES}`;
}

/**
 * The violation report, as the model sees it.
 *
 * Codes are included alongside the sentences: they are stable, they group
 * repeated problems, and they make the report readable when the same mistake was
 * made eight times. The list is capped — a model handed forty violations is being
 * asked to rewrite from scratch, and the honest response to that is to fail rather
 * than to spend a second call on it.
 */
export const MAX_REPORTED_VIOLATIONS = 12;

export function formatViolations(violations: GenerationViolation[]): string {
  const shown = violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const lines = shown.map((violation, index) => {
    const context = [
      violation.dayNumber !== undefined ? `day ${violation.dayNumber}` : null,
      violation.slotId ? `slot ${violation.slotId}` : null,
      violation.itemId ? `item ${violation.itemId}` : null,
      violation.placeId ? `place ${violation.placeId}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    return `${index + 1}. [${violation.code}]${context ? ` (${context})` : ""} ${violation.message}`;
  });

  const omitted = violations.length - shown.length;
  if (omitted > 0) {
    lines.push(
      `…and ${omitted} further problem${omitted === 1 ? "" : "s"} of the same kinds.`,
    );
  }

  return lines.join("\n");
}
