/** Exact values typed while drawing. */
import { describe, expect, it } from "vitest";
import type { Vec2 } from "@meercad/sketch";
import { entryTarget, typeIntoEntry, type ValueOf } from "./entry";
import type { Snap } from "./types";

const valueOf: ValueOf = (text) => {
  if (text === undefined || !text.trim()) return null;

  const n = Number(text);

  return Number.isFinite(n) ? n : null;
};

const snap = (pos: Vec2): Snap => ({ pos });
const state = (points: Vec2[], cursor: Vec2 | null, sweep = 1) => ({
  points: points.map(snap),
  cursor,
  sweep,
});
const entry = (...fields: string[]) => ({ fields, active: 0 });

const close = (actual: Vec2 | null, expected: Vec2) => {
  expect(actual![0]).toBeCloseTo(expected[0]);
  expect(actual![1]).toBeCloseTo(expected[1]);
};

describe("entryTarget", () => {
  it("needs typed fields and a first point", () => {
    expect(entryTarget("line", null, state([[0, 0]], null), valueOf)).toBeNull();
    expect(entryTarget("line", entry("5"), state([], null), valueOf)).toBeNull();
    expect(entryTarget("point", entry("5"), state([[0, 0]], null), valueOf)).toBeNull();
  });

  it("ends a line at its length, toward the cursor or at the typed angle", () => {
    close(entryTarget("line", entry("10", ""), state([[1, 1]], [1, 5]), valueOf), [1, 11]);
    close(entryTarget("line", entry("10", "180"), state([[0, 0]], [0, 5]), valueOf), [-10, 0]);
    // Without a cursor away from the start: along +X.
    close(entryTarget("line", entry("10"), state([[0, 0]], [0, 0]), valueOf), [10, 0]);
    close(entryTarget("line", entry("10"), state([[0, 0]], null), valueOf), [10, 0]);
    expect(entryTarget("line", entry("0"), state([[0, 0]], null), valueOf)).toBeNull();
    expect(entryTarget("line", entry(""), state([[0, 0]], null), valueOf)).toBeNull();
    expect(entryTarget("line", entry("10", "x"), state([[0, 0]], null), valueOf)).toBeNull();
  });

  it("puts a rectangle's corner toward the cursor, an untyped side following it", () => {
    close(entryTarget("rect", entry("20", "10"), state([[0, 0]], [-5, -5]), valueOf), [-20, -10]);
    close(entryTarget("rect", entry("20", ""), state([[0, 0]], [5, 3]), valueOf), [20, 3]);
    close(entryTarget("rect", entry("", "8"), state([[0, 0]], [5, 3]), valueOf), [5, 8]);
    close(entryTarget("rect_center", entry("20", "10"), state([[0, 0]], [0, 0]), valueOf), [10, 5]);
    // The cursor straight above or level with the corner: the positive side.
    close(entryTarget("rect", entry("20", "10"), state([[0, 0]], [0, -5]), valueOf), [20, -10]);
    close(entryTarget("rect", entry("-1", "4"), state([[0, 0]], [2, 2]), valueOf), [2, 4]);
    expect(entryTarget("rect", entry("0", "-1"), state([[0, 0]], [1, 1]), valueOf)).toBeNull();
    expect(entryTarget("rect", entry("", ""), state([[0, 0]], [1, 1]), valueOf)).toBeNull();
  });

  it("puts a circle's edge at half the typed diameter", () => {
    close(entryTarget("circle", entry("10"), state([[0, 0]], [0, 3]), valueOf), [0, 5]);
    expect(entryTarget("circle", entry("0"), state([[0, 0]], [0, 3]), valueOf)).toBeNull();
    expect(entryTarget("circle", entry(""), state([[0, 0]], [0, 3]), valueOf)).toBeNull();
  });

  it("puts a three-point arc's middle from radius or angle", () => {
    const ends = state(
      [
        [-1, 0],
        [1, 0],
      ],
      [0, 5],
    );

    close(entryTarget("arc", entry("1", ""), ends, valueOf), [0, 1]);
    close(entryTarget("arc", entry("", "90"), ends, valueOf), [0, Math.SQRT2 - 1]);
    close(entryTarget("arc", entry("-1", "90"), ends, valueOf), [0, Math.SQRT2 - 1]);
    close(
      entryTarget(
        "arc",
        entry("1"),
        state(
          [
            [-1, 0],
            [1, 0],
          ],
          null,
        ),
        valueOf,
      ),
      [0, 1],
    );
    expect(entryTarget("arc", entry("", ""), ends, valueOf)).toBeNull();
    expect(entryTarget("arc", entry("1"), state([[-1, 0]], [0, 5]), valueOf)).toBeNull();
  });

  it("ends a centre arc over the typed angle in the direction moved", () => {
    close(
      entryTarget(
        "arc_center",
        entry("90"),
        state(
          [
            [0, 0],
            [5, 0],
          ],
          null,
          1,
        ),
        valueOf,
      ),
      [0, 5],
    );
    close(
      entryTarget(
        "arc_center",
        entry("90"),
        state(
          [
            [0, 0],
            [5, 0],
          ],
          null,
          -1,
        ),
        valueOf,
      ),
      [0, -5],
    );
    expect(
      entryTarget(
        "arc_center",
        entry("360"),
        state(
          [
            [0, 0],
            [5, 0],
          ],
          null,
        ),
        valueOf,
      ),
    ).toBeNull();
    expect(
      entryTarget(
        "arc_center",
        entry("0"),
        state(
          [
            [0, 0],
            [5, 0],
          ],
          null,
        ),
        valueOf,
      ),
    ).toBeNull();
    expect(
      entryTarget(
        "arc_center",
        entry(""),
        state(
          [
            [0, 0],
            [5, 0],
          ],
          null,
        ),
        valueOf,
      ),
    ).toBeNull();
    expect(entryTarget("arc_center", entry("90"), state([[0, 0]], null), valueOf)).toBeNull();
  });
});

describe("typeIntoEntry", () => {
  const fields = ["Length", "Angle"];

  it("opens the fields with the first key, a digit going into the first", () => {
    expect(typeIntoEntry(null, "5", false, fields)).toEqual({ fields: ["5", ""], active: 0 });
    expect(typeIntoEntry(null, "Tab", false, fields)).toEqual({ fields: ["", ""], active: 0 });
  });

  it("moves between fields with Tab and Shift+Tab and types into the active one", () => {
    const open = { fields: ["5", ""], active: 0 };
    const next = typeIntoEntry(open, "Tab", false, fields);

    expect(next.active).toBe(1);
    expect(typeIntoEntry(next, "Tab", true, fields).active).toBe(0);
    expect(typeIntoEntry(next, "4", false, fields)).toEqual({ fields: ["5", "4"], active: 1 });
  });
});
