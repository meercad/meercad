/**
 * Dimensions drawn like a technical drawing's (dimStyle.ts): dimension line set off to the outside or
 * through a moved value, extension lines, arrowheads, an angle's arc with arrowheads, sizes in
 * proportion to the sketch, and text laid readably into the plane as seen on the screen.
 */
import { describe, expect, it } from "vitest";
import { angleArc } from "./angleDim";
import {
  angleDrawing,
  arrowhead,
  extentOf,
  lengthDrawing,
  middleOf,
  planeText,
  sizesFor,
  type DimensionSizes,
} from "./dimStyle";

const sizes: DimensionSizes = { gap: 1, overshoot: 2, arrow: 3, offset: 10 };

describe("a length", () => {
  it("stands off to the outside of the shape, its value in the middle of its line", () => {
    const drawing = lengthDrawing([0, 0], [40, 0], sizes, null, [20, 15])!;
    expect(drawing.offset).toBe(-10);
    expect(drawing.lines[0]).toEqual({ a: [0, -10], b: [40, -10] });
    expect(drawing.text.at).toEqual([20, -10]);
    expect(drawing.text.up[0]).toBeCloseTo(0, 9);
    expect(drawing.text.up[1]).toBe(-1);
    // Extension lines from just off the points to just past the line.
    expect(drawing.lines[1]).toEqual({ a: [0, -1], b: [0, -12] });
    expect(drawing.arrows[0]![0]).toEqual([0, -10]);
    expect(drawing.arrows[1]![1][0]).toBeCloseTo(37, 9);
  });

  it("goes to the default side without a shape, and through a moved value, past an end too", () => {
    expect(lengthDrawing([0, 0], [40, 0], sizes)!.offset).toBe(10);

    const moved = lengthDrawing([0, 0], [40, 0], sizes, [55, 6])!;
    expect(moved.offset).toBe(6);
    expect(moved.text.at).toEqual([55, 6]);
    expect(moved.lines[1]).toEqual({ a: [40, 6], b: [55, 6] });

    const before = lengthDrawing([0, 0], [40, 0], sizes, [-5, 6])!;
    expect(before.lines[1]).toEqual({ a: [0, 6], b: [-5, 6] });
    // A value left on the line itself keeps the default distance.
    expect(lengthDrawing([0, 0], [40, 0], sizes, [20, 0.5])!.offset).toBe(10);
  });

  it("along an axis, between points at different heights", () => {
    const drawing = lengthDrawing([0, 0], [30, 20], sizes, [15, -8], null, [1, 0])!;
    expect(drawing.lines[0]).toEqual({ a: [0, -8], b: [30, -8] });
    expect(drawing.text.at).toEqual([15, -8]);
    // From the higher point the extension line runs down to the dimension line.
    expect(drawing.lines[2]!.a).toEqual([30, 19]);

    // The line through the higher point itself: its extension line is just the overshoot.
    const level = lengthDrawing([0, 0], [30, 20], sizes, [15, 20], null, [1, 0])!;
    expect(level.lines[2]).toEqual({ a: [30, 21], b: [30, 22] });
  });

  it("is none for points on one spot, or seen across its axis", () => {
    expect(lengthDrawing([1, 1], [1, 1], sizes)).toBeNull();
    expect(lengthDrawing([0, 0], [0, 20], sizes, null, null, [1, 0])).toBeNull();
  });
});

describe("an angle", () => {
  it("is its arc with arrowheads at both ends, its value half way round", () => {
    const arc = angleArc({ a: [0, 0], b: [40, 0] }, { a: [0, 0], b: [0, 40] })!;
    const drawing = angleDrawing(arc, sizes);
    expect(drawing.lines.length).toBeGreaterThan(4);
    expect(drawing.arrows).toHaveLength(2);
    expect(drawing.arrows[0]![0][1]).toBeCloseTo(0, 9);
    expect(drawing.text.at).toEqual(arc.label);
    expect(drawing.offset).toBe(arc.radius);
  });
});

describe("pieces", () => {
  it("an arrowhead points along its direction", () => {
    const [tip, left, right] = arrowhead([10, 0], [1, 0], 4);
    expect(tip).toEqual([10, 0]);
    expect(left[0]).toBe(6);
    expect(right[1]).toBeCloseTo(-left[1], 9);
  });

  it("sizes follow the sketch, small ones as if 10 mm across", () => {
    expect(sizesFor(350).arrow).toBeCloseTo(9, 9);
    expect(sizesFor(1).offset).toBeCloseTo(sizesFor(10).offset, 9);
    // On the model: within bounds on the screen, however near or far.
    expect(sizesFor(350, 0.1).arrow).toBeCloseTo(9 * 0.16, 9);
    expect(sizesFor(350, 10).arrow).toBeCloseTo(9 * 9, 9);
    expect(sizesFor(350, 1).arrow).toBeCloseTo(9, 9);
    expect(
      extentOf([
        [0, 0],
        [3, 4],
      ]),
    ).toBe(5);
    expect(extentOf([])).toBe(0);
    expect(
      middleOf([
        [0, 0],
        [4, 2],
      ]),
    ).toEqual([2, 1]);
    expect(middleOf([])).toBeNull();
  });
});

describe("text in the plane", () => {
  it("runs left to right along its line, standing on the side it should", () => {
    const flat = planeText([100, 100], [110, 100], [100, 90], 1)!;
    expect(flat.matrix[0]).toBeGreaterThan(0);
    expect(flat.above).toBe(true);

    // The line runs right to left on the screen: turned round, still readable and above.
    const back = planeText([100, 100], [90, 100], [100, 90], 1)!;
    expect(back.matrix[0]).toBeGreaterThan(0);
    expect(back.above).toBe(true);

    // Its upper side faces down the screen (the plane seen from below): not mirrored, hanging below.
    const under = planeText([100, 100], [110, 100], [100, 110], 1)!;
    expect(under.matrix[0] * under.matrix[3] - under.matrix[1] * under.matrix[2]).toBeGreaterThan(0);
    expect(under.above).toBe(false);
  });

  it("follows the zoom within bounds, and is none for a line seen end on", () => {
    const near = planeText([0, 0], [100, 0], [0, -100], 1)!;
    const far = planeText([0, 0], [0.01, 0], [0, -0.01], 1)!;
    expect(near.matrix[0]).toBeCloseTo(1.4, 9);
    expect(far.matrix[0]).toBeCloseTo(0.85, 9);
    expect(planeText([0, 0], [0, 0], [0, -1], 1)).toBeNull();
    expect(near.edgeOn).toBe(false);

    // The plane seen almost from its side: its up runs nearly along the line.
    const low = planeText([0, 0], [10, 0], [10, -0.3], 1)!;
    expect(low.edgeOn).toBe(true);
    // Still not squashed flatter than readable.
    expect(Math.abs(low.matrix[3]) / low.matrix[0]).toBeCloseTo(0.8, 9);
    // Nor slanted further than readable.
    expect(Math.abs(low.matrix[2]) / Math.abs(low.matrix[3])).toBeCloseTo(0.6, 9);

    const leaning = planeText([0, 0], [10, 0], [-3, -10], 1)!;
    expect(leaning.matrix[2] / leaning.matrix[0]).toBeCloseTo(0.3, 9);
  });
});
