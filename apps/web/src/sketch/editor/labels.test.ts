/** Dimension values and constraint glyphs in the sketch, and the size chips of a new shape. */
import { afterEach, describe, expect, it } from "vitest";
import type { SketchConstraint, SketchFeature } from "@meercad/schema";
import type { SolvedCurve, SolvedSketch, Vec2 } from "@meercad/sketch";
import { setUnitSource } from "../../lib/units";
import { constraintLabels, quickDimensions } from "./labels";

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
const circle: SolvedCurve = {
  id: "c1",
  kind: "circle",
  center: [0, 0],
  radius: 5,
  c: "p0",
  construction: false,
  external: false,
};
const arc = (id: string, a0: number, a1: number): SolvedCurve => ({
  id,
  kind: "arc",
  center: [0, 0],
  radius: 10,
  a0,
  a1,
  c: "p0",
  start: "s",
  end: "e",
  construction: false,
  external: false,
});
const spline: SolvedCurve = {
  id: "s1",
  kind: "spline",
  pts: [
    [0, 0],
    [1, 1],
    [2, 0],
  ],
  through: [],
  points: [],
  closed: false,
  construction: false,
  external: false,
};
const emptySpline: SolvedCurve = { ...spline, id: "s2", pts: [] };

const solved: SolvedSketch = {
  points: new Map<string, Vec2>([
    ["p1", [0, 0]],
    ["p2", [4, 0]],
    ["p3", [0, 2]],
  ]),
  curves: [
    line("l1", [0, 0], [10, 0]),
    line("l2", [0, 0], [0, 4]),
    circle,
    arc("a1", 0, Math.PI / 2),
    arc("a2", 3, 1),
    spline,
    emptySpline,
  ],
  diagnostics: {} as SolvedSketch["diagnostics"],
};
const sketchWith = (constraints: SketchConstraint[]): SketchFeature => ({
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities: [],
  constraints,
});

afterEach(() => setUnitSource(() => "mm"));

describe("constraintLabels", () => {
  it("puts dimension values on what they measure", () => {
    const labels = constraintLabels(
      sketchWith([
        { id: "d1", type: "length", line: "l1", value: 10 },
        { id: "d2", type: "diameter", curve: "c1", value: 10 },
        { id: "d3", type: "radius", curve: "a1", value: "r" },
        { id: "d4", type: "angle", a: "l1", b: "l2", value: 90 },
        { id: "d5", type: "arc_angle", curve: "a1", value: 90 },
        { id: "d6", type: "distance", a: "p1", b: "p2", value: 4 },
        { id: "d7", type: "distance", a: "p3", b: "l1", value: 2 },
        { id: "d8", type: "length", line: "l1", value: 10, label: [7, 7] },
        { id: "d9", type: "arc_angle", curve: "s1", value: 10 },
        { id: "d10", type: "radius", curve: "a2", value: 10 },
        { id: "d11", type: "length", line: "s2", value: 1 },
      ]),
      solved,
    );
    const byId = Object.fromEntries(labels.map((label) => [label.id, label]));

    // A length without a stored place sits on its dimension line, off the measured line.
    expect(byId.d1).toMatchObject({ text: "10", dimension: true });
    expect(byId.d1!.at[0]).toBeCloseTo(5);
    expect(byId.d1!.at[1]).toBeCloseTo(-0.8);
    expect(byId.d2).toMatchObject({ at: [0, 5], text: "⌀10" });
    expect(byId.d3!.text).toBe("Rr");
    // An angle sits on its arc, halfway between the two lines.
    expect(byId.d4!.text).toBe("90°");
    expect(byId.d4!.at[0]).toBeCloseTo(byId.d4!.at[1]);
    expect(byId.d4!.at[0]).toBeGreaterThan(0);
    expect(byId.d5!.text).toBe("∠90°");
    expect(byId.d5!.at[0]).toBeCloseTo(5 * Math.SQRT1_2);
    // Distances sit on their dimension lines too, off what they measure.
    expect(byId.d6!.at[0]).toBeCloseTo(2);
    expect(byId.d6!.at[1]).toBeCloseTo(-0.8);
    expect(byId.d7!.at[0]).toBeCloseTo(-0.8);
    expect(byId.d7!.at[1]).toBeCloseTo(1);
    expect(byId.d8!.at).toEqual([7, 7]);
    expect(byId.d9!.at).toEqual([1, 1]);
    // An arc that runs past angle zero: its middle is on the far side.
    expect(byId.d10!.at[0]).toBeCloseTo(10 * Math.cos(2 + Math.PI));
    expect(byId.d11).toBeUndefined();
    expect(byId.d1!.title).toContain("d1");
  });

  it("puts angles and distances that cannot be drawn by what they measure", () => {
    const parallel = { ...solved, curves: [...solved.curves, line("l3", [0, 3], [10, 3])] };
    const labels = constraintLabels(
      sketchWith([
        // Not two lines, or two that never meet: by the first of them.
        { id: "d1", type: "angle", a: "c1", b: "l1", value: 30 },
        { id: "d2", type: "angle", a: "l1", b: "l3", value: "w" },
        { id: "d3", type: "angle", a: "gone", b: "l1", value: 30 },
        // A point and a curve: halfway between the point and the curve's middle.
        { id: "d4", type: "distance", a: "p3", b: "s1", value: 2 },
      ]),
      parallel,
    );
    const byId = Object.fromEntries(labels.map((label) => [label.id, label]));

    expect(byId.d1!.text).toBe("30°");
    expect(byId.d2!.at[0]).toBeCloseTo(5);
    expect(byId.d2!.at[1]).toBeCloseTo(0);
    expect(byId.d3).toBeUndefined();
    expect(byId.d4!.at[0]).toBeGreaterThan(0);
  });

  it("leaves out dimensions on what is not there", () => {
    const labels = constraintLabels(
      sketchWith([
        { id: "d1", type: "length", line: "gone", value: 10 },
        { id: "d2", type: "distance", a: "gone", b: "p2", value: 4 },
        { id: "d3", type: "distance", a: "p1", b: "gone", value: 4 },
        { id: "d4", type: "arc_angle", curve: "gone", value: 4 },
        // A kind of dimension this version does not know: shown only where its label was put.
        { id: "d5", type: "weight", value: 4 } as unknown as SketchConstraint,
        { id: "d6", type: "weight", value: 4, label: [1, 2] } as unknown as SketchConstraint,
      ]),
      solved,
    );

    expect(labels.map((label) => [label.id, label.at, label.text])).toEqual([["d6", [1, 2], "4"]]);
    expect(labels[0]!.title).toContain("weight");
  });

  it("writes lengths of an inch design with their unit", () => {
    setUnitSource(() => "in");

    const [length, angle] = constraintLabels(
      sketchWith([
        { id: "d1", type: "length", line: "l1", value: 25.4 },
        { id: "d2", type: "angle", a: "l1", b: "l2", value: 30 },
      ]),
      solved,
    );

    expect(length!.text).toBe("1 in");
    expect(angle!.text).toBe("30°");
  });

  it("puts glyphs on their geometry, fanned out where they share a spot", () => {
    const labels = constraintLabels(
      sketchWith([
        { id: "g1", type: "horizontal", line: "l1" },
        { id: "g2", type: "parallel", a: "l1", b: "l2" },
        { id: "g3", type: "midpoint", point: "p2", line: "l1" },
        { id: "g4", type: "fix", point: "p1" },
        { id: "g5", type: "point_on", point: "p3", curve: "l1" },
        { id: "g6", type: "symmetric", a: "p1", b: "p2", axis: "l2" },
        { id: "g7", type: "horizontal_points", a: "p1", b: "p2" },
        { id: "g8", type: "coincident", a: "p1", b: "p2" },
        { id: "g9", type: "vertical_points", a: "p1", b: "gone" },
        { id: "g10", type: "midpoint", point: "gone", line: "l1" },
        { id: "g11", type: "fix", point: "gone" },
        { id: "g12", type: "unknown" } as unknown as SketchConstraint,
      ]),
      solved,
    );
    const byId = Object.fromEntries(labels.map((label) => [label.id, label]));

    expect(Object.keys(byId)).toEqual(["g1", "g2", "g3", "g4", "g5", "g6", "g7"]);
    expect(byId.g1).toMatchObject({ text: "H", dimension: false });
    expect(byId.g2!.at[0]).toBeGreaterThan(byId.g1!.at[0]);
    expect(byId.g2!.at[1]).toBe(byId.g1!.at[1]);
    // The largest curve (the arcs, 20 across) sets the spacing: 3 % below, 4 % along per glyph.
    expect(byId.g2!.at[0] - byId.g1!.at[0]).toBeCloseTo(0.8);
    // The symmetry glyph shares its spot with the point-on glyph of p3.
    expect(byId.g6!.at[0]).toBeCloseTo(0.8);
    expect(byId.g6!.at[1]).toBeCloseTo(1.4);
    expect(byId.g7!.at).toEqual([2, -0.6]);
  });

  it("scales the fan-out to the sketch, at least 10", () => {
    const tiny: SolvedSketch = { ...solved, curves: [line("l1", [0, 0], [1, 0])] };
    const [label] = constraintLabels(sketchWith([{ id: "g1", type: "horizontal", line: "l1" }]), tiny);

    expect(label!.at).toEqual([0.5, -0.3]);
  });
});

describe("quickDimensions", () => {
  const chips = (curve: SolvedCurve, constraints: SketchConstraint[] = []) =>
    quickDimensions(sketchWith(constraints), curve).map((chip) => [chip.key, chip.text, chip.value]);

  it("offers a new line's length and angle until constraints fix them", () => {
    expect(chips(line("l1", [0, 0], [-3, -4]))).toEqual([
      ["len", "5 mm", 5],
      ["ang", "∠ 53.13°", 53.13],
    ]);
    expect(
      chips(line("l1", [0, 0], [3, 4]), [
        { id: "k1", type: "length", line: "l1", value: 5 },
        { id: "k2", type: "angle", a: "l1", b: "l9", value: 5 },
      ]),
    ).toEqual([]);
    // Constraints on other curves do not count.
    expect(
      chips(line("l1", [0, 0], [3, 4]), [{ id: "k1", type: "length", line: "l2", value: 5 }]),
    ).toHaveLength(2);
    expect(chips(line("l1", [0, 0], [3, 4]), [{ id: "k1", type: "fix", point: "p1" }])).toHaveLength(2);
  });

  it("offers a circle's diameter and an arc's radius and sweep", () => {
    expect(chips(circle)).toEqual([["dia", "⌀ 10 mm", 10]]);
    expect(chips(circle, [{ id: "k1", type: "radius", curve: "c1", value: 5 }])).toEqual([]);
    expect(chips(arc("a1", 0, Math.PI / 2))).toEqual([
      ["rad", "R 10 mm", 10],
      ["sweep", "∠ 90°", 90],
    ]);
    expect(
      chips(arc("a1", 0, 1), [
        { id: "k1", type: "diameter", curve: "a1", value: 5 },
        { id: "k2", type: "arc_angle", curve: "a1", value: 5 },
      ]),
    ).toEqual([]);
    expect(chips(spline)).toEqual([]);
  });

  it("makes the constraint a chip stands for", () => {
    const make = (curve: SolvedCurve) => quickDimensions(sketchWith([]), curve).map((chip) => chip.make(7));

    expect(make(line("l1", [0, 0], [1, 0]))).toEqual([
      { type: "length", line: "l1", value: 7 },
      { type: "angle", a: "l1", b: "origin.x", value: 7 },
    ]);
    expect(make(circle)).toEqual([{ type: "diameter", curve: "c1", value: 7 }]);
    expect(make(arc("a1", 0, 1))).toEqual([
      { type: "radius", curve: "a1", value: 7 },
      { type: "arc_angle", curve: "a1", value: 7 },
    ]);
  });
});
