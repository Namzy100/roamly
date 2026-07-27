import {
  REFINEMENT_ACTION_LABELS,
  type StructuralEditCommand,
} from "@/lib/refinement/commands";
import type { TripGenerationContext, TripPlan } from "@/lib/schemas";

import { applyStructuralCommand } from "./dispatch";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
  StructuralEditSummary,
  StructuralEditWarning,
} from "./types";
import { validatePlanMembership } from "./validate";

/**
 * Everything that happens between a command and a write, with the write left out.
 *
 * ## Why this is not inside the hook
 *
 * `useStructuralEdits` used to run the dispatcher, re-check the pool invariant and phrase the
 * refusal inline, which put three decisions somewhere the unit suite cannot reach: tests run in
 * plain Node over `lib/**` and `app/**`, with no renderer. So the decisions that have a right
 * answer live here, and the hook keeps only the two things that genuinely need React — component
 * state, and the store write.
 *
 * ## `ready` is a preview, and a preview is the real result
 *
 * Nothing here writes, reads a clock, or touches the store, so a caller may run this to *show*
 * what an edit would do and simply not commit it. That is what the time editor and a confirmed
 * assistant proposal both rest on: not a second code path that approximates the edit, but the
 * edit itself, held back. A preview that could disagree with the commit would be worse than none.
 *
 * ## One verification gate, two producers
 *
 * `verifyStructuralResult` is deliberately separate from `prepareStructuralCommand` because the
 * pool refresh produces a `StructuralEditResult` without going through the command dispatcher —
 * it needs a provider, so it cannot be a `StructuralEditCommand`. Both still have to clear the
 * widened pool invariant before anything is stored, and one gate is how that stays true of
 * whichever path is written next.
 */

export type PreparedStructuralEdit =
  | {
      status: "ready";
      plan: TripPlan;
      generationContext: TripGenerationContext;
      summary: StructuralEditSummary;
      /** Empty for a clean success. A `partial` result carries its warnings here. */
      warnings: StructuralEditWarning[];
      /**
       * The label the record stores for this change, from the one table.
       *
       * Derived from `summary.action` rather than from the command, so it describes what the
       * applier actually did — and so the pool refresh gets a label without passing one in. These
       * double as undo labels, which is why they are phrased as things that happened.
       */
      label: string;
    }
  | {
      status: "refused";
      errors: StructuralEditError[];
      /** The first error, phrased for a traveller. Callers render this rather than re-phrasing. */
      message: string;
    };

/**
 * The last gate before a write, for any producer of a structural result.
 *
 * Re-checks `validatePlanMembership` on the *finished* pair rather than trusting the applier that
 * built it. Each applier's `commitStructuralEdit` already asserts the itinerary uses the pool, but
 * this adds `validateRetainedPlaces` — a property of the whole plan-and-pool pair, like a retained
 * place nothing references, or a place claiming to be both current and retained. That can only be
 * judged at the end. It is cheap, and the alternative is storing a trip whose places cannot all be
 * traced back to a real search.
 */
export function verifyStructuralResult(
  result: StructuralEditResult,
): PreparedStructuralEdit {
  if (result.status === "failed") {
    return {
      status: "refused",
      errors: result.errors,
      /**
       * The applier's own wording, unsoftened.
       *
       * `lockRefusalFor` exists to say *which* lock is in the way, and a wrapper that replaced
       * that with something generic would leave the interface unable to say "unlock it first".
       */
      message: result.errors[0].message,
    };
  }

  const membership = validatePlanMembership({
    plan: result.plan,
    generation: result.generationContext,
  });

  if (membership.length > 0) {
    return {
      status: "refused",
      errors: membership,
      /**
       * Framed differently from an applier's refusal, because it means something different.
       *
       * An applier refusal is about the edit — it names a lock, a full day, a window that does not
       * fit — and the traveller can act on it. Reaching here means the edit was permissible and the
       * *result* did not hold up, which is a bug rather than a choice. So the message leads with
       * the reassurance that matters most: nothing was saved.
       */
      message: `That change did not pass verification, so nothing was saved: ${membership[0].message}`,
    };
  }

  return {
    status: "ready",
    plan: result.plan,
    generationContext: result.generationContext,
    summary: result.summary,
    warnings: result.status === "partial" ? result.warnings : [],
    label: REFINEMENT_ACTION_LABELS[result.summary.action],
  };
}

/**
 * A command, applied and verified, ready to store or to show.
 *
 * The whole of what a structural edit *decides*. Goes through `applyStructuralCommand`, never an
 * individual applier, so a new entry point cannot acquire its own semantics — it can only build a
 * command. Pure, like everything it calls: the same plan and the same command give the same answer.
 */
export function prepareStructuralCommand(
  input: StructuralEditInput & { command: StructuralEditCommand },
): PreparedStructuralEdit {
  return verifyStructuralResult(applyStructuralCommand(input));
}
