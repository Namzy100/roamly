import { describe, expect, it } from "vitest";

import {
  FIXTURE_GENERATION,
  fixtureSavedPlan,
} from "@/lib/refinement/test-fixtures";
import { StructuralEditCommandSchema } from "@/lib/refinement/commands";

import {
  applyStructuralCommand,
  applyUnvalidatedStructuralCommand,
} from "./dispatch";
import { applyMoveItem } from "./move-item";
import { applyRemoveItem } from "./remove-item";
import { applySetItemSchedule } from "./set-schedule";
import type { StructuralEditInput, StructuralEditResult } from "./types";

/**
 * The dispatcher owns no rules, so these tests do not re-test the appliers — each of those has its
 * own suite. What is worth pinning down is the property the whole editable workspace rests on:
 *
 * > routing a command through `applyStructuralCommand` is indistinguishable from calling its applier
 * > directly.
 *
 * If that ever stops holding, a drag and a menu press would mean different things, which is exactly
 * what §4 of the brief forbids and what a single mutation path exists to prevent.
 *
 * Day one of the fixture plan: `cafe-one` (the only breakfast), `museum-one`, `dinner-one` (the only
 * dinner). So `museum-one` is the stop most edits can safely touch.
 */

const TIMEZONE = "Europe/Lisbon";

function base(): StructuralEditInput {
  return {
    plan: fixtureSavedPlan(),
    generation: FIXTURE_GENERATION,
    revisionBefore: 3,
    timezone: TIMEZONE,
  };
}

/** Every arm of the union, with arguments the fixture plan can actually satisfy. */
const EVERY_COMMAND = [
  {
    label: "move-item",
    command: {
      type: "move-item",
      sourceDayNumber: 1,
      targetDayNumber: 2,
      itemId: "museum-one",
      targetPosition: { kind: "end" },
    },
  },
  {
    label: "set-item-time",
    command: {
      type: "set-item-time",
      dayNumber: 1,
      itemId: "museum-one",
      startTime: "11:30",
      endTime: "13:00",
    },
  },
  {
    label: "set-item-duration",
    command: {
      type: "set-item-duration",
      dayNumber: 1,
      itemId: "museum-one",
      durationMinutes: 60,
      anchor: "start",
    },
  },
  {
    label: "insert-free-time",
    command: {
      type: "insert-free-time",
      dayNumber: 2,
      startTime: "16:00",
      endTime: "17:00",
    },
  },
  {
    label: "remove-item",
    command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
  },
  {
    label: "lock-item",
    command: { type: "lock-item", dayNumber: 1, itemId: "museum-one" },
  },
  {
    label: "unlock-item",
    command: { type: "unlock-item", dayNumber: 1, itemId: "museum-one" },
  },
] as const;

describe("applyStructuralCommand — the single mutation path", () => {
  /**
   * The union and the switch agree.
   *
   * A tenth command added to the schema and forgotten here would land on the `never` arm and be
   * refused as unsupported, so this asserts every declared arm is genuinely reachable rather than
   * merely declared. The `default` branch makes that a compile error too; this catches the case
   * where someone silences the compiler instead of wiring the applier.
   */
  it("dispatches every command in the schema to a real applier", () => {
    for (const { label, command } of EVERY_COMMAND) {
      const result = applyStructuralCommand({ ...base(), command });

      const codes =
        result.status === "failed"
          ? result.errors.map((error) => error.code)
          : [];

      expect(codes, `${label} should not be refused as unsupported`).not.toContain(
        "unsupported_command",
      );
    }
  });

  it("produces exactly what calling the applier directly produces", () => {
    const cases: {
      label: string;
      command: unknown;
      direct: StructuralEditResult;
    }[] = [
      {
        label: "move-item",
        command: {
          type: "move-item",
          sourceDayNumber: 1,
          targetDayNumber: 2,
          itemId: "museum-one",
          targetPosition: { kind: "end" },
        },
        direct: applyMoveItem({
          ...base(),
          command: {
            type: "move-item",
            sourceDayNumber: 1,
            targetDayNumber: 2,
            itemId: "museum-one",
            targetPosition: { kind: "end" },
          },
        }),
      },
      {
        label: "remove-item",
        command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
        direct: applyRemoveItem({
          ...base(),
          command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
        }),
      },
      {
        label: "set-item-duration",
        command: {
          type: "set-item-duration",
          dayNumber: 1,
          itemId: "museum-one",
          durationMinutes: 60,
          anchor: "start",
        },
        direct: applySetItemSchedule({
          ...base(),
          command: {
            type: "set-item-duration",
            dayNumber: 1,
            itemId: "museum-one",
            durationMinutes: 60,
            anchor: "start",
          },
        }),
      },
    ];

    for (const { label, command, direct } of cases) {
      const parsed = StructuralEditCommandSchema.parse(command);
      const dispatched = applyStructuralCommand({ ...base(), command: parsed });

      // Deep equality, not identity: `commitStructuralEdit` re-parses, so Zod rebuilds the plan.
      expect(dispatched, `${label} via the dispatcher`).toStrictEqual(direct);
    }
  });

  /**
   * A refusal travels back unchanged.
   *
   * The dispatcher must not soften an applier's error into a generic one — the whole value of
   * `lockRefusalFor` is that it says *which* lock, and a wrapper that flattened that would make the
   * interface unable to say "unlock it first".
   */
  it("passes an applier's own refusal straight through", () => {
    const plan = fixtureSavedPlan();
    const locked = {
      ...plan,
      days: plan.days.map((day) =>
        day.dayNumber === 1
          ? {
              ...day,
              items: day.items.map((item) =>
                item.id === "museum-one" ? { ...item, locked: true } : item,
              ),
            }
          : day,
      ),
    };

    const result = applyStructuralCommand({
      ...base(),
      plan: locked,
      command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("item_locked");
    expect(result.errors[0].itemId).toBe("museum-one");
  });

  it("writes nothing — the plan it was given is untouched", () => {
    const plan = fixtureSavedPlan();
    const before = JSON.stringify(plan);

    applyStructuralCommand({
      ...base(),
      plan,
      command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
    });

    expect(JSON.stringify(plan)).toBe(before);
  });
});

describe("applyUnvalidatedStructuralCommand — the serialisation boundary", () => {
  it("applies a command that parses", () => {
    const result = applyUnvalidatedStructuralCommand({
      ...base(),
      command: { type: "remove-item", dayNumber: 1, itemId: "museum-one" },
    });

    expect(result.status).not.toBe("failed");
  });

  it.each([
    ["an unknown action", { type: "delete-everything", dayNumber: 1 }],
    ["a missing discriminant", { dayNumber: 1, itemId: "museum-one" }],
    ["not an object at all", "remove-item"],
    ["null", null],
    /** The cap lives in the schema rather than in arithmetic: 12 hours is the ceiling. */
    [
      "a duration past the cap",
      {
        type: "set-item-duration",
        dayNumber: 1,
        itemId: "museum-one",
        durationMinutes: 9_999,
        anchor: "start",
      },
    ],
    /** Control characters are refused rather than silently stripped. */
    [
      "a free-time label carrying a control character",
      {
        type: "insert-free-time",
        dayNumber: 2,
        startTime: "16:00",
        endTime: "17:00",
        title: "nap\u0000swim",
      },
    ],
    /** A place is a `placeId` and nothing else, so a name cannot stand in for identity. */
    [
      "a place named instead of identified",
      {
        type: "select-alternative",
        dayNumber: 1,
        itemId: "museum-one",
        alternativePlaceId: "the museum round the corner",
      },
    ],
  ])("refuses %s without throwing", (_label, command) => {
    const result = applyUnvalidatedStructuralCommand({ ...base(), command });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].code).toBe("unsupported_command");
  });

  /**
   * The rejected value must not be echoed.
   *
   * A command from outside can carry model output or imported file contents, and a message that
   * quoted it would make this the one place unvalidated text reaches the page.
   */
  it("never echoes the rejected value into the message", () => {
    const result = applyUnvalidatedStructuralCommand({
      ...base(),
      command: { type: "<img src=x onerror=alert(1)>", secret: "sk-live-xxxx" },
    });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.errors[0].message).not.toContain("<img");
    expect(result.errors[0].message).not.toContain("sk-live");
  });
});
