/** Picking several parts in the project overview. */
import { describe, expect, it } from "vitest";
import { clickSelect, EMPTY_SELECTION, keepShown, toggleAll } from "./multiSelect";

const order = ["a", "b", "c", "d", "e"];

describe("clickSelect", () => {
  it("toggles one part and keeps the order shown", () => {
    const one = clickSelect(EMPTY_SELECTION, order, "c");
    const two = clickSelect(one, order, "a");

    expect(two).toEqual({ ids: ["a", "c"], anchor: "a" });
    expect(clickSelect(two, order, "c")).toEqual({ ids: ["a"], anchor: "c" });
  });

  it("adds the range from the last click with Shift, either way", () => {
    const start = clickSelect(EMPTY_SELECTION, order, "d");

    expect(clickSelect(start, order, "b", true)).toEqual({ ids: ["b", "c", "d"], anchor: "d" });
    expect(clickSelect({ ids: ["a"], anchor: "b" }, order, "c", true)).toEqual({
      ids: ["a", "b", "c"],
      anchor: "b",
    });
  });

  it("toggles instead when there is no range to take", () => {
    expect(clickSelect(EMPTY_SELECTION, order, "b", true)).toEqual({ ids: ["b"], anchor: "b" });
    expect(clickSelect({ ids: [], anchor: "gone" }, order, "b", true)).toEqual({ ids: ["b"], anchor: "b" });
    expect(clickSelect({ ids: [], anchor: "a" }, order, "gone", true)).toEqual({ ids: [], anchor: "gone" });
  });
});

describe("toggleAll and keepShown", () => {
  it("selects all, or none when all are selected", () => {
    expect(toggleAll(EMPTY_SELECTION, order)).toEqual({ ids: order, anchor: null });
    expect(toggleAll({ ids: order, anchor: "a" }, order)).toEqual({ ids: [], anchor: null });
    expect(toggleAll(EMPTY_SELECTION, [])).toEqual({ ids: [], anchor: null });
  });

  it("drops parts no longer shown and keeps the selection when nothing changed", () => {
    const sel = { ids: ["a", "x"], anchor: "x" };

    expect(keepShown(sel, order)).toEqual({ ids: ["a"], anchor: null });
    expect(keepShown({ ids: ["a"], anchor: "a" }, ["b"])).toEqual({ ids: [], anchor: null });

    const same = { ids: ["a"], anchor: "a" };

    expect(keepShown(same, order)).toBe(same);
    expect(keepShown(EMPTY_SELECTION, order)).toBe(EMPTY_SELECTION);
  });
});
