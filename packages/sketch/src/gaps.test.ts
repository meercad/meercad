/**
 * Corners of the sketch package the other tests leave out: an angle to the vertical axis, a
 * projected spline (ignored by the solver), a spline through fewer than two points, trimming a
 * closed spline clicked past its last cut, repeating a spline, regions of a circle cut by two lines
 * a hair either side of its seam, and two squares joined by a bridge line.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import { findRegions, intersectionPoints, patternCurves, regionAt, SketchSolver, splinePoints, trimSpline, type SolvedCurve, type Vec2 } from "./index.js";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});
const line = (id: string, a: Vec2, b: Vec2): SolvedCurve => ({ id, kind: "line", a, b, p1: "", p2: "", construction: false, external: false });
const circle = (id: string, center: Vec2, radius: number): SolvedCurve => ({ id, kind: "circle", center, radius, c: "", construction: false, external: false });
const square = (n: string, x0: number, y0: number, s: number): SolvedCurve[] => [
  line(`${n}1`, [x0, y0], [x0 + s, y0]),
  line(`${n}2`, [x0 + s, y0], [x0 + s, y0 + s]),
  line(`${n}3`, [x0 + s, y0 + s], [x0, y0 + s]),
  line(`${n}4`, [x0, y0 + s], [x0, y0]),
];

describe("the solver", () => {
  it("sets a line's angle to the vertical axis", () => {
    const es: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 10, y: 10 },
      { id: "l", type: "line", p1: "a", p2: "b" },
    ];
    const s = solver.solve({ entities: es, constraints: [{ id: "f", type: "fix", point: "a" } as never, { id: "ang", type: "angle", a: "l", b: "origin.y", value: 30 } as never] });
    const [a, b] = [s.points.get("a")!, s.points.get("b")!];
    const off = (Math.acos(Math.abs(b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1])) * 180) / Math.PI;
    expect(off).toBeCloseTo(30, 6);
  });

  it("leaves projected splines out (model edges come as lines, circles and arcs)", () => {
    const ext: SolvedCurve = { id: "x", kind: "spline", pts: [[0, 0], [5, 5]], through: [[0, 0], [5, 5]], points: [], closed: false, construction: false, external: true };
    const es: SketchEntity[] = [{ id: "a", type: "point", x: 1, y: 2 }];
    const s = solver.solve({ entities: es, constraints: [], external: [ext] });
    expect(s.points.get("a")).toEqual([1, 2]);
    expect(s.points.has("x.p1")).toBe(false);
  });
});

describe("splines", () => {
  it("a spline through one point is that point", () => {
    expect(splinePoints([[3, 4]])).toEqual([[3, 4]]);
    expect(splinePoints([])).toEqual([]);
  });

  it("trims a closed spline clicked past its last cut: the stretch over the seam goes", () => {
    const through: Vec2[] = [[0, -20], [20, 0], [0, 20], [-20, 0]];
    const ring = { id: "s1", kind: "spline" as const, pts: splinePoints(through, true), through, points: ["p0", "p1", "p2", "p3"], closed: true, construction: false, external: false };
    // Cuts on the left half only; clicked at the bottom, just left of the seam (the first point):
    // past the last cut, so the stretch removed runs on over the seam to the first cut.
    const hits = intersectionPoints(ring, line("l", [-10, -50], [-10, 50]));
    expect(hits).toHaveLength(2);
    const pieces = trimSpline(ring, [-2, -19.9], hits);
    expect(pieces).toHaveLength(1);
    // What stays is the left bulge between the two cuts, through the left point only.
    expect(pieces[0]!.filter((x) => "point" in x)).toEqual([{ point: 3 }]);
    expect(pieces[0]![0]).toEqual({ cut: hits.findIndex((h) => h[1] > 0) });
    // Just right of the seam, before the first cut: the same stretch goes.
    expect(trimSpline(ring, [2, -19.9], hits)).toEqual(pieces);
  });

  it("repeats a spline with its own points, closed stays closed", () => {
    const es: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 10, y: 5 },
      { id: "c", type: "point", x: 20, y: 0 },
      { id: "s", type: "spline", points: ["a", "b", "c"], closed: true, construction: true },
    ];
    const pos = new Map<string, Vec2>([["a", [0, 0]], ["b", [10, 5]], ["c", [20, 0]]]);
    const out = patternCurves({ entities: es, constraints: [] }, pos, ["s"], { kind: "linear", count: 2, dx: 0, dy: 30 });
    const copy = out.entities.at(-1)!;
    expect(copy).toMatchObject({ type: "spline", closed: true, construction: true });
    const pts = (copy as { points: string[] }).points.map((id) => out.entities.find((e) => e.id === id) as { x: number; y: number });
    expect(pts.map((p) => [p.x, p.y])).toEqual([[0, 30], [10, 35], [20, 30]]);
    // A spline's copy keeps its shape by its points: no "equal" constraint to the original.
    expect(out.constraints).toEqual([]);
  });
});

describe("regions", () => {
  it("a circle cut by two lines a hair either side of its seam: four pieces, not a sliver", () => {
    const r = 10;
    const regions = findRegions([circle("c", [0, 0], r), line("m", [-20, -20 * 1e-13], [20, 20 * 1e-13]), line("n", [-20, 20 * 1e-13], [20, -20 * 1e-13])]);
    const total = regions.reduce((s, x) => s + x.area, 0);
    expect(total).toBeCloseTo(Math.PI * r * r, 3);
    for (const x of regions) expect(x.area).toBeGreaterThan(1);
  });

  it("two squares joined by a line: the line is no region's edge, both squares are found", () => {
    const regions = findRegions([...square("a", 0, 0, 10), ...square("b", 30, 0, 10), line("bridge", [10, 5], [30, 5])]);
    expect(regions.map((r) => r.area).sort()).toEqual([100, 100]);
    expect(regions.every((r) => r.depth === 1)).toBe(true);
    // The bridge ends on the right square's side, which it splits in two there.
    expect(regionAt(regions, [35, 5])!.key).toBe("b1+b2+b3+b4:0+b4:1");
    expect(regionAt(regions, [20, 8])).toBeUndefined();
  });
});
