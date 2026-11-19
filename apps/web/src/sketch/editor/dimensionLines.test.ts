/**
 * The lines a moved dimension is drawn with (geometry.ts): extension lines from what it measures to
 * the dimension line through its value, the dimension line reaching on to a value moved past its
 * ends, and a leader from a circle to its value.
 */
import { describe, expect, it } from "vitest";
import type { SketchConstraint } from "@meercad/schema";
import type { SolvedSketch } from "@meercad/sketch";
import { dimensionDrawing, dimensionGeometry, reachLabel } from "./geometry";

const solved = {
  points: new Map([
    ["p1", [0, 0]],
    ["p2", [40, 0]],
  ]),
  curves: [
    {
      id: "l1",
      kind: "line",
      a: [0, 0],
      b: [40, 0],
      p1: "p1",
      p2: "p2",
      construction: false,
      external: false,
    },
    { id: "k", kind: "circle", center: [0, 0], radius: 5, c: "c", construction: false, external: false },
  ],
} as unknown as SolvedSketch;
const pairs = (flat: number[][]) => flat.length / 2;

describe("a dimension line reaching its value", () => {
  it("goes on past the end the value was moved beyond, and not otherwise", () => {
    expect(reachLabel([0, 0], [10, 0], [5, 3])).toEqual([]);
    expect(reachLabel([0, 0], [10, 0], [14, 3])).toEqual([
      [10, 0],
      [14, 0],
    ]);
    expect(reachLabel([0, 0], [10, 0], [-2, 3])).toEqual([
      [0, 0],
      [-2, 0],
    ]);
    expect(reachLabel([1, 1], [1, 1], [3, 1])).toEqual([]);
  });
});

describe("a moved dimension", () => {
  it("of a length: two extension lines and the dimension line, longer when moved past the end", () => {
    const length = { id: "c", type: "length", line: "l1", value: 40 } as SketchConstraint;
    expect(dimensionGeometry(length, solved)).toBeNull();
    expect(pairs(dimensionGeometry({ ...length, label: [20, 8] } as SketchConstraint, solved)!)).toBe(3);
    expect(pairs(dimensionGeometry({ ...length, label: [55, 8] } as SketchConstraint, solved)!)).toBe(4);
  });

  it("of a distance along an axis likewise", () => {
    const across = { id: "c", type: "distance", a: "p1", b: "p2", axis: "x", value: 40 } as SketchConstraint;
    expect(pairs(dimensionGeometry({ ...across, label: [20, -6] } as SketchConstraint, solved)!)).toBe(3);
    expect(pairs(dimensionGeometry({ ...across, label: [-9, -6] } as SketchConstraint, solved)!)).toBe(4);
  });

  it("of a diameter: a leader from the circle", () => {
    const diameter = { id: "c", type: "diameter", curve: "k", value: 10, label: [12, 0] } as SketchConstraint;
    expect(pairs(dimensionGeometry(diameter, solved)!)).toBe(1);
  });
});

describe("dimensions drawn like a drawing's", () => {
  const sizes = { gap: 1, overshoot: 2, arrow: 3, offset: 10 };
  const draw = (c: Record<string, unknown>) =>
    dimensionDrawing({ id: "c", value: 1, ...c } as SketchConstraint, solved, sizes, [20, 20]);

  it("are drawn for lengths, distances and angles, through a moved value", () => {
    expect(draw({ type: "length", line: "l1" })!.offset).toBe(-10);
    expect(draw({ type: "length", line: "l1", label: [20, 6] })!.text.at).toEqual([20, 6]);
    // A label taken off again (left as undefined) is the same as none.
    expect(draw({ type: "length", line: "l1", label: undefined })!.offset).toBe(-10);
    expect(draw({ type: "distance", a: "p1", b: "p2", axis: "x" })!.lines[0]).toEqual({
      a: [0, -10],
      b: [40, -10],
    });
    expect(draw({ type: "distance", a: "p1", b: "p2", axis: "y" })).toBeNull();
    expect(draw({ type: "distance", a: "p2", b: "l1" })).toBeNull();
  });

  it("not for what they cannot find, nor for other kinds", () => {
    expect(draw({ type: "length", line: "k" })).toBeNull();
    expect(draw({ type: "distance", a: "gone", b: "p2" })).toBeNull();
    expect(draw({ type: "radius", curve: "k" })).toBeNull();
    expect(draw({ type: "angle", a: "l1", b: "k", label: [3, 3] })).toBeNull();
  });
});
