import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, clickSelect, keepShown, toggleAll } from "../apps/web/src/lib/multiSelect";

const ORDER = ["a", "b", "c", "d", "e"];

describe("selecting several parts", () => {
  it("toggles single parts and keeps the order shown", () => {
    let s = clickSelect(EMPTY_SELECTION, ORDER, "d");
    s = clickSelect(s, ORDER, "b");
    expect(s.ids).toEqual(["b", "d"]);
    s = clickSelect(s, ORDER, "d");
    expect(s).toEqual({ ids: ["b"], anchor: "d" });
  });

  it("adds a range with Shift in either direction", () => {
    let s = clickSelect(EMPTY_SELECTION, ORDER, "b");
    s = clickSelect(s, ORDER, "d", true);
    expect(s.ids).toEqual(["b", "c", "d"]);
    expect(s.anchor).toBe("b");
    s = clickSelect(clickSelect(EMPTY_SELECTION, ORDER, "e"), ORDER, "c", true);
    expect(s.ids).toEqual(["c", "d", "e"]);
  });

  it("keeps what was picked before a range", () => {
    let s = clickSelect(EMPTY_SELECTION, ORDER, "a");
    s = clickSelect(s, ORDER, "d");
    s = clickSelect(s, ORDER, "e", true);
    expect(s.ids).toEqual(["a", "d", "e"]);
  });

  it("treats Shift without an earlier click as a plain click", () => {
    expect(clickSelect(EMPTY_SELECTION, ORDER, "c", true)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("selects all, then none", () => {
    const all = toggleAll(clickSelect(EMPTY_SELECTION, ORDER, "b"), ORDER);
    expect(all.ids).toEqual(ORDER);
    expect(toggleAll(all, ORDER).ids).toEqual([]);
    expect(toggleAll(EMPTY_SELECTION, []).ids).toEqual([]);
  });

  it("forgets parts that are gone", () => {
    const s = { ids: ["a", "c", "e"], anchor: "c" };
    expect(keepShown(s, ["a", "b", "e"])).toEqual({ ids: ["a", "e"], anchor: null });
    expect(keepShown(s, ORDER)).toBe(s);
  });
});
