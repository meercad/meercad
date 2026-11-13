import { describe, expect, it } from "vitest";
import {
  add2,
  cross2,
  distance2,
  dot2,
  len2,
  midpoint2,
  perpendicular2,
  scale2,
  sub2,
  type Vec2,
} from "./geometry.js";

describe("2D vector helpers", () => {
  const a: Vec2 = [3, 4];
  const b: Vec2 = [-1, 2];

  it("adds, subtracts and scales by component", () => {
    expect(add2(a, b)).toEqual([2, 6]);
    expect(sub2(a, b)).toEqual([4, 2]);
    expect(scale2(a, -2)).toEqual([-6, -8]);
  });

  it("gives the dot product and the z part of the cross product", () => {
    expect(dot2(a, b)).toBe(5);
    expect(cross2(a, b)).toBe(10);
    // b lies counter-clockwise of a, so the other order is negative.
    expect(cross2(b, a)).toBe(-10);
  });

  it("measures a length and the distance between two points", () => {
    expect(len2(a)).toBe(5);
    expect(distance2(a, [0, 0])).toBe(5);
    expect(distance2(a, a)).toBe(0);
  });

  it("finds the middle between two points", () => {
    expect(midpoint2(a, b)).toEqual([1, 3]);
  });

  it("turns a vector a quarter turn counter-clockwise", () => {
    expect(perpendicular2([2, 3])).toEqual([-3, 2]);
    expect(perpendicular2([-1, 5])).toEqual([-5, -1]);
    expect(dot2(a, perpendicular2(a))).toBe(0);
  });
});
