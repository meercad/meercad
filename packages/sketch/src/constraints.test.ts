/**
 * Every sketch constraint against the geometry it must produce: each case starts from a sloppy
 * drawing, solves, and checks the solved coordinates by numbers worked out by hand.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import { SketchSolver, type ResolvedConstraint, type SolvedCurve } from "./index.js";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});

type V2 = [number, number];
const pt = (id: string, x: number, y: number): SketchEntity => ({ id, type: "point", x, y });
const ln = (id: string, p1: string, p2: string): SketchEntity => ({ id, type: "line", p1, p2 });
const solve = (entities: SketchEntity[], constraints: ResolvedConstraint[]) => {
  const s = solver.solve({ entities, constraints });
  expect(s.diagnostics.ok, JSON.stringify(s.diagnostics)).toBe(true);
  return { ...s, p: (id: string): V2 => s.points.get(id) as V2, curve: (id: string): SolvedCurve => s.curves.find((c) => c.id === id)! };
};
const dist = (a: V2, b: V2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const dir = (a: V2, b: V2): V2 => {
  const l = dist(a, b);
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
};
const cross = (u: V2, v: V2) => u[0] * v[1] - u[1] * v[0];
const dot = (u: V2, v: V2) => u[0] * v[0] + u[1] * v[1];
/** Two points pinned so the solve has something fixed to work from. */
const anchor: ResolvedConstraint[] = [{ id: "fixA", type: "fix", point: "a" }];

describe("sketch constraints give the exact geometry", () => {
  it("coincident joins two points (and a point to the origin)", () => {
    const s = solve([pt("a", 3, 4), pt("b", 7, -2)], [{ id: "c", type: "coincident", a: "a", b: "origin" }, { id: "d", type: "coincident", a: "b", b: "a" }]);
    expect(s.p("a")[0]).toBeCloseTo(0, 9);
    expect(s.p("a")[1]).toBeCloseTo(0, 9);
    expect(dist(s.p("a"), s.p("b"))).toBeCloseTo(0, 9);
  });

  it("horizontal and vertical lines", () => {
    const s = solve([pt("a", 0, 0), pt("b", 10, 3), pt("c", 2, 0), pt("d", 3, 9), ln("h", "a", "b"), ln("v", "c", "d")], [
      { id: "1", type: "horizontal", line: "h" },
      { id: "2", type: "vertical", line: "v" },
    ]);
    expect(s.p("a")[1]).toBeCloseTo(s.p("b")[1], 9);
    expect(s.p("c")[0]).toBeCloseTo(s.p("d")[0], 9);
  });

  it("horizontal_points and vertical_points line up two points", () => {
    const s = solve([pt("a", 0, 0), pt("b", 10, 3), pt("c", 4, 7)], [
      ...anchor,
      { id: "1", type: "horizontal_points", a: "a", b: "b" },
      { id: "2", type: "vertical_points", a: "a", b: "c" },
    ]);
    expect(s.p("b")[1]).toBeCloseTo(0, 9);
    expect(s.p("c")[0]).toBeCloseTo(0, 9);
  });

  it("parallel, perpendicular and collinear lines", () => {
    const s = solve(
      [pt("a", 0, 0), pt("b", 10, 1), pt("c", 0, 5), pt("d", 9, 7), pt("e", 3, 3), pt("f", 4, 12), pt("g", 20, 2), pt("h", 30, 5), ln("l1", "a", "b"), ln("l2", "c", "d"), ln("l3", "e", "f"), ln("l4", "g", "h")],
      [
        { id: "1", type: "parallel", a: "l1", b: "l2" },
        { id: "2", type: "perpendicular", a: "l1", b: "l3" },
        { id: "3", type: "collinear", a: "l1", b: "l4" },
      ],
    );
    const u1 = dir(s.p("a"), s.p("b"));
    expect(Math.abs(cross(u1, dir(s.p("c"), s.p("d"))))).toBeLessThan(1e-9);
    expect(Math.abs(dot(u1, dir(s.p("e"), s.p("f"))))).toBeLessThan(1e-9);
    // Both ends of l4 on l1's line.
    for (const q of ["g", "h"]) expect(Math.abs(cross(u1, [s.p(q)[0] - s.p("a")[0], s.p(q)[1] - s.p("a")[1]]))).toBeLessThan(1e-8);
  });

  it("equal lengths and equal radii", () => {
    const s = solve(
      [pt("a", 0, 0), pt("b", 10, 0), pt("c", 0, 5), pt("d", 3, 9), ln("l1", "a", "b"), ln("l2", "c", "d"), pt("k1c", 30, 0), { id: "k1", type: "circle", center: "k1c", radius: 4 }, pt("k2c", 50, 0), { id: "k2", type: "circle", center: "k2c", radius: 9 }],
      [
        { id: "len", type: "length", line: "l1", value: 25 },
        { id: "1", type: "equal", a: "l1", b: "l2" },
        { id: "dk", type: "diameter", curve: "k1", value: 12 },
        { id: "2", type: "equal", a: "k1", b: "k2" },
      ],
    );
    expect(dist(s.p("c"), s.p("d"))).toBeCloseTo(25, 9);
    const k2 = s.curve("k2");
    expect(k2.kind === "circle" && k2.radius).toBeCloseTo(6, 9);
  });

  it("point_on a line and on a circle", () => {
    const s = solve(
      [pt("a", 0, 0), pt("b", 10, 0), ln("l", "a", "b"), pt("q", 4, 3), pt("kc", 0, 20), { id: "k", type: "circle", center: "kc", radius: 5 }, pt("r", 1, 13)],
      [
        ...anchor,
        { id: "h", type: "horizontal", line: "l" },
        { id: "1", type: "point_on", point: "q", curve: "l" },
        { id: "fk", type: "fix", point: "kc" },
        { id: "rk", type: "radius", curve: "k", value: 5 },
        { id: "2", type: "point_on", point: "r", curve: "k" },
      ],
    );
    expect(s.p("q")[1]).toBeCloseTo(0, 9);
    expect(dist(s.p("r"), s.p("kc"))).toBeCloseTo(5, 9);
  });

  it("midpoint sits halfway along the line", () => {
    const s = solve([pt("a", 0, 0), pt("b", 10, 4), ln("l", "a", "b"), pt("m", 1, 1)], [{ id: "1", type: "midpoint", point: "m", line: "l" }]);
    expect(s.p("m")[0]).toBeCloseTo((s.p("a")[0] + s.p("b")[0]) / 2, 9);
    expect(s.p("m")[1]).toBeCloseTo((s.p("a")[1] + s.p("b")[1]) / 2, 9);
  });

  it("symmetric mirrors two points about a line", () => {
    const s = solve(
      [pt("a", 0, -10), pt("b", 0, 10), ln("ax", "a", "b"), pt("p", 7, 2), pt("q", -5, 4)],
      [{ id: "fa", type: "fix", point: "a" }, { id: "fb", type: "fix", point: "b" }, { id: "fp", type: "fix", point: "p" }, { id: "1", type: "symmetric", a: "p", b: "q", axis: "ax" }],
    );
    expect(s.p("q")[0]).toBeCloseTo(-7, 9);
    expect(s.p("q")[1]).toBeCloseTo(2, 9);
  });

  it("distance between points, along x and y, and from a point to a line", () => {
    const s = solve(
      [pt("a", 0, 0), pt("b", 10, 3), pt("c", 3, 8), pt("d", 9, 9), pt("l1a", 0, 20), pt("l1b", 30, 21), ln("l1", "l1a", "l1b"), pt("e", 5, 30)],
      [
        ...anchor,
        { id: "1", type: "distance", a: "a", b: "b", value: 13 },
        { id: "2", type: "distance", a: "a", b: "c", value: 4, axis: "x" },
        { id: "3", type: "distance", a: "a", b: "d", value: 6, axis: "y" },
        { id: "f1", type: "fix", point: "l1a" },
        { id: "h1", type: "horizontal", line: "l1" },
        { id: "4", type: "distance", a: "e", b: "l1", value: 7.5 },
      ],
    );
    expect(dist(s.p("a"), s.p("b"))).toBeCloseTo(13, 9);
    expect(Math.abs(s.p("c")[0])).toBeCloseTo(4, 9);
    expect(Math.abs(s.p("d")[1])).toBeCloseTo(6, 9);
    expect(Math.abs(s.p("e")[1] - 20)).toBeCloseTo(7.5, 9);
  });

  it("length, radius, diameter and angle by value", () => {
    const s = solve(
      [pt("a", 0, 0), pt("b", 10, 3), ln("l", "a", "b"), pt("kc", 50, 50), { id: "k", type: "circle", center: "kc", radius: 3 }],
      [...anchor, { id: "1", type: "length", line: "l", value: 33.3 }, { id: "2", type: "angle", a: "l", b: "origin.x", value: 37 }, { id: "3", type: "radius", curve: "k", value: 7.25 }],
    );
    expect(dist(s.p("a"), s.p("b"))).toBeCloseTo(33.3, 9);
    const u = dir(s.p("a"), s.p("b"));
    expect((Math.acos(Math.abs(u[0])) * 180) / Math.PI).toBeCloseTo(37, 6);
    const k = s.curve("k");
    expect(k.kind === "circle" && k.radius).toBeCloseTo(7.25, 9);
  });

  it("tangent line to circle: the centre is one radius from the line", () => {
    const s = solve(
      [pt("a", 0, 0), pt("b", 40, 0), ln("l", "a", "b"), pt("kc", 20, 7), { id: "k", type: "circle", center: "kc", radius: 4 }],
      [...anchor, { id: "h", type: "horizontal", line: "l" }, { id: "r", type: "radius", curve: "k", value: 5 }, { id: "t", type: "tangent", a: "l", b: "k" }],
    );
    expect(Math.abs(s.p("kc")[1] - s.p("a")[1])).toBeCloseTo(5, 8);
  });

  it("arc_angle sweeps the arc by the given degrees", () => {
    const s = solve(
      [pt("c", 0, 0), pt("s", 10, 0), pt("e", 0, 10), { id: "arc", type: "arc", center: "c", start: "s", end: "e" }],
      [{ id: "f", type: "fix", point: "c" }, { id: "fs", type: "fix", point: "s" }, { id: "1", type: "arc_angle", curve: "arc", value: 135 }],
    );
    const e = s.p("e");
    expect((Math.atan2(e[1], e[0]) * 180) / Math.PI).toBeCloseTo(135, 6);
    expect(Math.hypot(...e)).toBeCloseTo(10, 8);
  });

  it("a fully dimensioned plate: every corner and hole where the drawing says", () => {
    // 80 × 50 plate at the origin, a Ø 8 hole 10 from the left and bottom edges.
    const s = solve(
      [pt("p1", 1, -1), pt("p2", 77, 2), pt("p3", 83, 49), pt("p4", -2, 52), ln("l1", "p1", "p2"), ln("l2", "p2", "p3"), ln("l3", "p3", "p4"), ln("l4", "p4", "p1"), pt("hc", 12, 9), { id: "h", type: "circle", center: "hc", radius: 3 }],
      [
        { id: "o", type: "coincident", a: "p1", b: "origin" },
        { id: "h1", type: "horizontal", line: "l1" },
        { id: "h3", type: "horizontal", line: "l3" },
        { id: "v2", type: "vertical", line: "l2" },
        { id: "v4", type: "vertical", line: "l4" },
        { id: "w", type: "length", line: "l1", value: 80 },
        { id: "hh", type: "length", line: "l2", value: 50 },
        { id: "dx", type: "distance", a: "p1", b: "hc", value: 10, axis: "x" },
        { id: "dy", type: "distance", a: "p1", b: "hc", value: 10, axis: "y" },
        { id: "dh", type: "diameter", curve: "h", value: 8 },
      ],
    );
    expect(s.diagnostics.dof).toBe(0);
    const want: Record<string, V2> = { p1: [0, 0], p2: [80, 0], p3: [80, 50], p4: [0, 50], hc: [10, 10] };
    for (const [id, [x, y]] of Object.entries(want)) {
      expect(s.p(id)[0], id).toBeCloseTo(x, 9);
      expect(s.p(id)[1], id).toBeCloseTo(y, 9);
    }
    const h = s.curve("h");
    expect(h.kind === "circle" && h.radius).toBeCloseTo(4, 9);
  });

  it("reports over-constrained sketches instead of silently picking one value", () => {
    const s = solver.solve({
      entities: [pt("a", 0, 0), pt("b", 10, 0), ln("l", "a", "b")],
      constraints: [...anchor, { id: "1", type: "length", line: "l", value: 10 }, { id: "2", type: "distance", a: "a", b: "b", value: 12 }],
    });
    expect(s.diagnostics.ok).toBe(false);
    expect(s.diagnostics.conflicting.length).toBeGreaterThan(0);
  });
});
