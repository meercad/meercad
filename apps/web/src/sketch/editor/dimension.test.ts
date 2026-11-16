/** Which dimension the dimension tool gives picked geometry. */
import { describe, expect, it } from "vitest";
import type { SolvedCurve, SolvedSketch, Vec2 } from "@meercad/sketch";
import { dimensionFor } from "./dimension";

const line = (id: string, a: Vec2, b: Vec2): SolvedCurve => ({
  id,
  kind: "line",
  a,
  b,
  p1: `${id}.p1`,
  p2: `${id}.p2`,
  construction: false,
  external: false,
});
const shown: SolvedSketch = {
  points: new Map<string, Vec2>([
    ["p1", [0, 0]],
    ["p2", [30, 40]],
    ["p3", [5, 7]],
  ]),
  curves: [
    line("l1", [0, 0], [10, 0]),
    line("l2", [0, 5], [20, 5]),
    line("l3", [0, 0], [10, 10]),
    { id: "c1", kind: "circle", center: [0, 0], radius: 2.5, c: "p1", construction: false, external: false },
    {
      id: "a1",
      kind: "arc",
      center: [0, 0],
      radius: 10,
      a0: 0,
      a1: Math.PI / 2,
      c: "p1",
      start: "s",
      end: "e",
      construction: false,
      external: false,
    },
    {
      id: "s1",
      kind: "spline",
      pts: [],
      through: [],
      points: [],
      closed: false,
      construction: false,
      external: false,
    },
  ],
  diagnostics: {} as SolvedSketch["diagnostics"],
};
const point = (id: string) => ({ kind: "point" as const, id });
const curve = (id: string) => ({ kind: "curve" as const, id });

describe("dimensionFor", () => {
  it("measures a single curve", () => {
    expect(dimensionFor(shown, curve("l1"), null, [5.12345, -3])).toEqual({
      type: "length",
      line: "l1",
      value: 10,
      label: [5.123, -3],
    });
    expect(dimensionFor(shown, curve("c1"), null, [0, 0])).toMatchObject({ type: "diameter", value: 5 });
    expect(dimensionFor(shown, curve("a1"), null, [2, 2])).toMatchObject({ type: "arc_angle", value: 90 });
    expect(dimensionFor(shown, curve("a1"), null, [12, 12])).toMatchObject({ type: "radius", value: 10 });
    expect(dimensionFor(shown, curve("s1"), null, [0, 0])).toBeNull();
  });

  it("measures two points across or straight, by where the label goes", () => {
    expect(dimensionFor(shown, point("p1"), point("p2"), [50, 20])).toMatchObject({ axis: "y", value: 40 });
    expect(dimensionFor(shown, point("p1"), point("p2"), [15, -10])).toMatchObject({ axis: "x", value: 30 });
    expect(dimensionFor(shown, point("p1"), point("p2"), [15, 20])).toEqual({
      type: "distance",
      a: "p1",
      b: "p2",
      value: 50,
      label: [15, 20],
    });
    expect(
      (dimensionFor(shown, point("p1"), point("p2"), [-5, 50]) as { axis?: string }).axis,
    ).toBeUndefined();
  });

  it("measures a point from a line, either picked first", () => {
    expect(dimensionFor(shown, point("p3"), curve("l1"), [0, 0])).toMatchObject({
      a: "p3",
      b: "l1",
      value: 7,
    });
    expect(dimensionFor(shown, curve("l1"), point("p3"), [0, 0])).toMatchObject({
      a: "p3",
      b: "l1",
      value: 7,
    });
    expect(dimensionFor(shown, point("p3"), curve("c1"), [0, 0])).toBeNull();
  });

  it("measures parallel lines apart, others by their angle", () => {
    expect(dimensionFor(shown, curve("l1"), curve("l2"), [0, 0])).toMatchObject({
      type: "distance",
      a: "l2.p1",
      b: "l1",
      value: 5,
    });
    expect(dimensionFor(shown, curve("l1"), curve("l3"), [0, 0])).toMatchObject({ type: "angle", value: 45 });
    expect(dimensionFor(shown, curve("l1"), curve("c1"), [0, 0])).toBeNull();
    expect(dimensionFor(shown, curve("c1"), curve("l1"), [0, 0])).toBeNull();
  });

  it("has nothing for a point alone or a point and nothing", () => {
    expect(dimensionFor(shown, point("p1"), null, [0, 0])).toBeNull();
  });
});
