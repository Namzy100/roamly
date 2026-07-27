import { describe, expect, it } from "vitest";

import { fixtureItem } from "@/lib/plan/test-fixtures";

import { insertAt, removeById, renumber, resolvePosition } from "./position";

const ITEMS = [
  fixtureItem("a", null, { order: 0, startTime: "09:00", endTime: "10:00" }),
  fixtureItem("b", null, { order: 1, startTime: "11:00", endTime: "12:00" }),
  fixtureItem("c", null, { order: 2, startTime: "14:00", endTime: "15:00" }),
];

describe("resolvePosition", () => {
  it("resolves before the first item", () => {
    const result = resolvePosition(ITEMS, { kind: "before", itemId: "a" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index).toBe(0);
    expect(result.value.before).toBeNull();
    expect(result.value.after?.id).toBe("a");
  });

  it("resolves before a middle item", () => {
    const result = resolvePosition(ITEMS, { kind: "before", itemId: "b" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index).toBe(1);
    expect(result.value.before?.id).toBe("a");
    expect(result.value.after?.id).toBe("b");
  });

  it("resolves after an item", () => {
    const result = resolvePosition(ITEMS, { kind: "after", itemId: "b" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index).toBe(2);
    expect(result.value.before?.id).toBe("b");
    expect(result.value.after?.id).toBe("c");
  });

  it("resolves after the last item as the end", () => {
    const result = resolvePosition(ITEMS, { kind: "after", itemId: "c" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index).toBe(3);
    expect(result.value.after).toBeNull();
  });

  it("resolves the end", () => {
    const result = resolvePosition(ITEMS, { kind: "end" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.index).toBe(3);
    expect(result.value.before?.id).toBe("c");
    expect(result.value.after).toBeNull();
  });

  it("resolves the end of an empty day", () => {
    const result = resolvePosition([], { kind: "end" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ index: 0, before: null, after: null });
  });

  /**
   * The refusal that makes a position safer than an index. An id that has gone is a clean
   * failure; an index that has shifted is a silent misplacement.
   */
  it("refuses an anchor that is not there", () => {
    expect(resolvePosition(ITEMS, { kind: "before", itemId: "gone" })).toMatchObject({
      ok: false,
      error: { code: "target_item_not_found", itemId: "gone" },
    });
    expect(resolvePosition(ITEMS, { kind: "after", itemId: "gone" })).toMatchObject({
      ok: false,
      error: { code: "target_item_not_found" },
    });
  });
});

describe("insertAt", () => {
  const inserted = fixtureItem("x", null, { order: 99 });

  it("inserts at the front and renumbers", () => {
    const result = insertAt(ITEMS, 0, inserted);

    expect(result.map((item) => item.id)).toEqual(["x", "a", "b", "c"]);
    expect(result.map((item) => item.order)).toEqual([0, 1, 2, 3]);
  });

  it("inserts in the middle", () => {
    expect(insertAt(ITEMS, 2, inserted).map((item) => item.id)).toEqual([
      "a",
      "b",
      "x",
      "c",
    ]);
  });

  it("inserts at the end", () => {
    expect(insertAt(ITEMS, 3, inserted).map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
      "x",
    ]);
  });

  /**
   * `order` is what the cards and the routing legs read, so an insertion that left it stale
   * would give a day whose displayed sequence and stored sequence disagree.
   */
  it("renumbers order to match the array", () => {
    const result = insertAt(ITEMS, 1, inserted);
    expect(result.map((item) => item.order)).toEqual([0, 1, 2, 3]);
    expect(result[1].id).toBe("x");
  });
});

describe("removeById", () => {
  it("removes and renumbers", () => {
    const result = removeById(ITEMS, "b");

    expect(result.map((item) => item.id)).toEqual(["a", "c"]);
    expect(result.map((item) => item.order)).toEqual([0, 1]);
  });

  /** The same array object, so a caller can tell "nothing happened" from "nothing changed". */
  it("returns the same list when the id is absent", () => {
    expect(removeById(ITEMS, "nope")).toBe(ITEMS);
  });
});

describe("renumber", () => {
  it("leaves already-correct items as the same objects", () => {
    const result = renumber(ITEMS);

    for (const [index, item] of result.entries()) {
      expect(item).toBe(ITEMS[index]);
    }
  });

  it("rewrites only the items whose order is wrong", () => {
    const shuffled = [ITEMS[1], ITEMS[0], ITEMS[2]];
    const result = renumber(shuffled);

    expect(result.map((item) => item.order)).toEqual([0, 1, 2]);
    // The third was already at index 2, so it is untouched.
    expect(result[2]).toBe(ITEMS[2]);
  });
});
