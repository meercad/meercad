/**
 * Solving a sketch for a change made on the model (solveOnModel.ts): with the main-thread solver, the
 * dragged points move, constraints in `skip` are left out, parameters are resolved, and anything
 * that cannot be solved here gives null.
 */
import { describe, expect, it } from "vitest";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { SketchConstraint, SketchFeature } from "@meercad/schema";
import { getSolver } from "./solver";
import { preloadSolver, solveOnModel } from "./solveOnModel";

const sketch: SketchFeature = {
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities: [
    { id: "p1", type: "point", x: 0, y: 0 },
    { id: "p2", type: "point", x: 30, y: 0 },
    { id: "l1", type: "line", p1: "p1", p2: "p2" },
  ],
  constraints: [],
};

/** A model edge on the x axis (external), and the sketch's own line (not passed on as external). */
const curves = [
  {
    id: "edge1",
    kind: "line",
    a: [-100, 0],
    b: [100, 0],
    p1: "ox1",
    p2: "ox2",
    construction: true,
    external: true,
  },
  { id: "l1", kind: "line", a: [0, 0], b: [30, 0], p1: "p1", p2: "p2", construction: false, external: false },
];

const output = (sketches = [{ id: "sk1", curves }], params: Record<string, number> = { w: 40 }) =>
  ({ report: { sketches, params } }) as unknown as RebuildOutput;

const fixed: SketchConstraint = { id: "c0", type: "fix", point: "p1" };
const horizontal: SketchConstraint = { id: "c1", type: "horizontal", line: "l1" };
const length = (value: number | string, id = "c2"): SketchConstraint =>
  ({ id, type: "length", line: "l1", value }) as SketchConstraint;

const point = (result: ReturnType<typeof solveOnModel>, id: string) =>
  result!.entities.find((x) => x.id === id) as { x: number; y: number };

describe("solving a sketch on the model", () => {
  it("gives null until the solver is loaded", () => {
    expect(solveOnModel(sketch, [horizontal], {}, output())).toBeNull();
  });

  it("solves with the constraints and resolved parameters once loaded", async () => {
    preloadSolver();
    await getSolver();
    await Promise.resolve();

    const result = solveOnModel(sketch, [fixed, horizontal, length("w")], {}, output());
    expect(result).not.toBeNull();
    expect(point(result, "p2").x).toBeCloseTo(40, 3);
    expect(point(result, "p2").y).toBeCloseTo(0, 3);
    expect(result!.points.get("p2")![0]).toBeCloseTo(40, 3);
  });

  it("pulls dragged points and leaves out the skipped constraints", () => {
    const held = solveOnModel(sketch, [fixed, horizontal, length(30)], { p2: [50, 0] }, output());
    expect(point(held, "p2").x).toBeCloseTo(30, 3);

    const free = solveOnModel(
      sketch,
      [fixed, horizontal, length(30)],
      { p2: [50, 0] },
      output(),
      new Set(["c2"]),
    );
    expect(point(free, "p2").x).toBeCloseTo(50, 3);
  });

  it("keeps points on external curves of the model", () => {
    const onAxis: SketchConstraint = { id: "c4", type: "point_on", point: "p2", curve: "edge1" };
    const result = solveOnModel(sketch, [fixed, onAxis], { p2: [20, 15] }, output());
    expect(point(result, "p2").y).toBeCloseTo(0, 3);
  });

  it("gives null for a sketch the rebuild does not know", () => {
    expect(solveOnModel(sketch, [horizontal], {}, output([]))).toBeNull();
  });

  it("gives null when a value cannot be resolved", () => {
    expect(solveOnModel(sketch, [length("nope")], {}, output())).toBeNull();
  });

  it("gives null when the constraints contradict each other", () => {
    expect(solveOnModel(sketch, [fixed, horizontal, length(10), length(20, "c3")], {}, output())).toBeNull();
  });
});
