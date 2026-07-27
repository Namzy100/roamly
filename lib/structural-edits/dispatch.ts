import {
  StructuralEditCommandSchema,
  type StructuralEditCommand,
} from "@/lib/refinement/commands";

import { applyInsertFreeTime } from "./insert-free-time";
import { applyMoveItem } from "./move-item";
import { applyPromoteBackup } from "./promote-backup";
import { applyRemoveItem } from "./remove-item";
import { applySelectAlternative } from "./select-alternative";
import { applySetItemLock } from "./set-lock";
import { applySetItemSchedule } from "./set-schedule";
import type {
  StructuralEditError,
  StructuralEditInput,
  StructuralEditResult,
} from "./types";

/**
 * One command in, one result out — the single mutation path for the editable workspace.
 *
 * ## Why a dispatcher rather than nine callbacks
 *
 * Phase 6C had two structural edits and `use-structural-edits.ts` grew one bespoke callback for
 * each. Phase 8 has nine commands and three ways to issue them — a card menu, a drag, and an
 * assistant proposal the traveller confirmed. Nine times three is twenty-seven hand-written paths,
 * and the ones that would drift are precisely the ones written last: a drag handler that forgets the
 * lock check, or a proposal path that skips the membership re-check.
 *
 * §4 of the Phase 8 brief states the rule directly — *"The drag event must produce an existing typed
 * command. Do not implement a separate mutation path specifically for drag-and-drop."* This function
 * is what makes that enforceable rather than aspirational: there is exactly one place a
 * `StructuralEditCommand` becomes a `StructuralEditResult`, so a new entry point cannot acquire its
 * own semantics. It can only build a command.
 *
 * ## Pure, like every applier it calls
 *
 * No clock, no network, no model, no store. Given the same plan and command it returns the same
 * result, which is what lets a *preview* be the real result simply not saved — the property the time
 * editor and the assistant's preview-before-apply both rest on. Nothing here writes.
 *
 * ## Exhaustive by construction
 *
 * The `switch` covers every arm of the union and the default branch is typed `never`, so adding a
 * tenth command is a compile error here rather than a silent fall-through at runtime. That is the
 * whole reason the vocabulary is a discriminated union.
 */

export function applyStructuralCommand(
  input: StructuralEditInput & { command: StructuralEditCommand },
): StructuralEditResult {
  const { command } = input;

  switch (command.type) {
    case "promote-backup":
      return applyPromoteBackup({ ...input, command });

    case "move-item":
      return applyMoveItem({ ...input, command });

    /**
     * Two commands, one applier.
     *
     * They differ only in how the requested window is *derived* — given outright, or computed from a
     * length and an anchored end. `applySetItemSchedule` takes the union and narrows internally, so
     * the window check exists once. See `./set-schedule.ts`.
     */
    case "set-item-time":
    case "set-item-duration":
      return applySetItemSchedule({ ...input, command });

    case "insert-free-time":
      return applyInsertFreeTime({ ...input, command });

    case "remove-item":
      return applyRemoveItem({ ...input, command });

    /** Likewise: the intended outcome is the discriminant, and one applier honours both. */
    case "lock-item":
    case "unlock-item":
      return applySetItemLock({ ...input, command });

    case "select-alternative":
      return applySelectAlternative({ ...input, command });

    default: {
      /**
       * Unreachable while the union and this switch agree, which is the point.
       *
       * Typed `never` so a tenth command fails to compile here. The runtime arm exists anyway
       * because a command can arrive from `JSON.parse` — an imported trip, an assistant proposal —
       * and "cannot happen" is not the same as "does not happen".
       */
      const unreachable: never = command;
      return {
        status: "failed",
        errors: [
          {
            code: "unsupported_command",
            message: `“${describeUnknown(unreachable)}” is not an edit this workspace can make.`,
          },
        ],
      };
    }
  }
}

/**
 * The same dispatch, for a command that has not been validated yet.
 *
 * The entry point for anything that crossed a serialisation boundary: an assistant proposal, an
 * imported action, a `postMessage`. Parsing here rather than at each call site means a caller cannot
 * hold a plausible-looking object literal and skip the schema — and the schema is where the bounds
 * live. `durationMinutes` is capped, a free-time label is length-limited and control-character-free,
 * and a `placeId` is charset-checked, none of which TypeScript can enforce on data from outside.
 *
 * A parse failure is a refusal like any other, so the caller has one shape to handle rather than a
 * thrown exception beside a returned result.
 */
export function applyUnvalidatedStructuralCommand(
  input: StructuralEditInput & { command: unknown },
): StructuralEditResult {
  const parsed = StructuralEditCommandSchema.safeParse(input.command);

  if (!parsed.success) {
    return {
      status: "failed",
      errors: [
        {
          code: "unsupported_command",
          /**
           * The issue's own message, never the value that failed.
           *
           * A rejected command can carry model output or imported file contents, and echoing it into
           * a rendered error would make this the one place unvalidated text reaches the page.
           */
          message: `That edit was not something this workspace can make: ${parsed.error.issues[0]?.message ?? "it did not match any known action"}.`,
        } satisfies StructuralEditError,
      ],
    };
  }

  return applyStructuralCommand({ ...input, command: parsed.data });
}

/**
 * A safe label for something the type system says cannot exist.
 *
 * Reads `type` when it is a plain string and says nothing otherwise. Deliberately not
 * `JSON.stringify`: the value is by definition unrecognised, so it may be arbitrarily large or carry
 * text from outside, and neither belongs in a message a traveller reads.
 */
function describeUnknown(value: never): string {
  const candidate = (value as { type?: unknown } | null)?.type;
  return typeof candidate === "string" && /^[\w-]{1,40}$/.test(candidate)
    ? candidate
    : "unknown action";
}
