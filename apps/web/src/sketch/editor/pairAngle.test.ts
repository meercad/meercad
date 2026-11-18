/**
 * The angle chip for two lines picked together (labels.ts pairAngle), and the arc an angle dimension
 * draws (geometry.ts): the measured angle on its arc while nothing fixes it, typed into a dimension.
 */
import { describe, expect, it } from "vitest";
import type { SketchConstraint, SketchFeature } from "@meercad/schema";
import type { SolvedCurve, SolvedSketch } from "@meercad/sketch";
import { dimensionGeometry, linePair } from "./geometry";
import { constraintLabels, pairAngle } from "./labels";

const line = (id: string, a: [number, number], b: [number, number]): SolvedCurve => ({
  id,
  kind: "line",
  a,
  b,
  p1: `${id}a`,
  p2: `${id}b`,
  construction: false,
  external: false,
});
const solved: SolvedSketch = {
  points: new Map(),
  curves: [
    line("l1", [0, 0], [40, 0]),
    line("l2", [0, 0], [20, 20]),
    line("l3", [0, 5], [40, 5]),
    { id: "k", kind: "circle", center: [0, 0], radius: 2, c: "kc", construction: false, external: false },
  ],
  diagnostics: { ok: true, dof: 0, conflicting: [], redundant: [] } as unknown as SolvedSketch["diagnostics"],
};
const sketch = (constraints: SketchConstraint[] = []): SketchFeature => ({
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities: [],
  constraints,
});

describe("two lines picked together", () => {
  it("show their angle on its arc, and typing it adds the angle with its place", () => {
    const chip = pairAngle(sketch(), solved, "l1", "l2")!;
    expect(chip.text).toBe("∠ 45°");
    expect(chip.value).toBeCloseTo(45, 6);
    expect(chip.length).toBe(false);
    expect(chip.make(30)).toMatchObject({ type: "angle", a: "l1", b: "l2", value: 30 });
  });

  it("measure the corner their chip was dragged into, with its arc", () => {
    const chip = pairAngle(sketch(), solved, "l1", "l2", [-10, 3])!;
    expect(chip.value).toBeCloseTo(135, 6);
    expect(chip.angle!.arc.degrees).toBeCloseTo(135, 6);
    expect(chip.make(130)).toMatchObject({ value: 130 });
  });

  it("show none when parallel, not both lines, or their angle is already fixed", () => {
    expect(pairAngle(sketch(), solved, "l1", "l3")).toBeNull();
    expect(pairAngle(sketch(), solved, "l1", "k")).toBeNull();
    expect(linePair(solved, "k", "l1")).toBeNull();

    const fixed = sketch([{ id: "c1", type: "perpendicular", a: "l2", b: "l1" }]);
    expect(pairAngle(fixed, solved, "l1", "l2")).toBeNull();

    const other = sketch([{ id: "c1", type: "horizontal", line: "l1" }]);
    expect(pairAngle(other, solved, "l1", "l2")).not.toBeNull();
  });
});

describe("an angle dimension", () => {
  const angle: SketchConstraint = { id: "c1", type: "angle", a: "l1", b: "l2", value: 45 };

  it("draws its arc between the lines, placed or not, and puts its value on it", () => {
    const lines = dimensionGeometry(angle, solved)!;
    expect(lines.length).toBeGreaterThan(4);

    const placed = dimensionGeometry({ ...angle, label: [-10, 3] } as SketchConstraint, solved)!;
    expect(placed.length).toBeGreaterThan(4);

    const [label] = constraintLabels(sketch([angle]), solved);
    expect(label!.text).toBe("45°");
    expect(Math.atan2(label!.at[1], label!.at[0])).toBeCloseTo(Math.PI / 8, 6);
  });

  it("draws nothing for lines that do not meet or are gone, written with a variable too", () => {
    expect(dimensionGeometry({ ...angle, b: "l3" } as SketchConstraint, solved)).toBeNull();
    expect(dimensionGeometry({ ...angle, b: "gone" } as SketchConstraint, solved)).toBeNull();
    expect(dimensionGeometry({ ...angle, value: "a" } as SketchConstraint, solved)!.length).toBeGreaterThan(
      4,
    );

    const [label] = constraintLabels(sketch([{ ...angle, b: "gone" } as SketchConstraint]), solved);
    expect(label!.at).toEqual([20, 0]);
  });
});
