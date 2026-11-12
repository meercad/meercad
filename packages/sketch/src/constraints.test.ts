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

describe("constraints between circles and arcs, and with projected model edges", () => {
  const circle = (id: string, c: string, x: number, y: number, r: number): SketchEntity[] => [pt(c, x, y), { id, type: "circle", center: c, radius: r }];
  const arc = (id: string, c: string, s: string, e: string, cx: number, cy: number, r: number): SketchEntity[] => [pt(c, cx, cy), pt(s, cx + r, cy), pt(e, cx, cy + r), { id, type: "arc", center: c, start: s, end: e }];

  it("tangent circles touch: centres one sum of radii apart", () => {
    const s = solve([...circle("k1", "c1", 0, 0, 5), ...circle("k2", "c2", 12, 3, 3)], [
      { id: "f", type: "fix", point: "c1" },
      { id: "r1", type: "radius", curve: "k1", value: 5 },
      { id: "r2", type: "radius", curve: "k2", value: 3 },
      { id: "t", type: "tangent", a: "k1", b: "k2" },
    ]);
    const d = dist(s.p("c1"), s.p("c2"));
    expect(Math.min(Math.abs(d - 8), Math.abs(d - 2))).toBeLessThan(1e-8);
  });

  it("tangent arcs, a circle tangent to an arc, and equal radii between circles and arcs", () => {
    const s = solve([...arc("a1", "c1", "s1", "e1", 0, 0, 5), ...arc("a2", "c2", "s2", "e2", 20, 0, 4), ...circle("k", "c3", 0, 20, 2)], [
      { id: "f1", type: "fix", point: "c1" },
      { id: "r1", type: "radius", curve: "a1", value: 5 },
      { id: "eq1", type: "equal", a: "a1", b: "a2" },
      { id: "t1", type: "tangent", a: "a1", b: "a2" },
      { id: "eq2", type: "equal", a: "k", b: "a1" },
      { id: "t2", type: "tangent", a: "k", b: "a1" },
    ]);
    const r = (id: string) => (s.curve(id) as { radius: number }).radius;
    expect(r("a2")).toBeCloseTo(5, 8);
    expect(r("k")).toBeCloseTo(5, 8);
    const d12 = dist(s.p("c1"), s.p("c2"));
    expect(Math.min(Math.abs(d12 - 10), Math.abs(d12))).toBeLessThan(1e-7);
    const d13 = dist(s.p("c1"), s.p("c3"));
    expect(Math.min(Math.abs(d13 - 10), Math.abs(d13))).toBeLessThan(1e-7);
  });

  it("a point on an arc and on a circle", () => {
    const s = solve([...arc("a", "c1", "s1", "e1", 0, 0, 5), ...circle("k", "c2", 20, 0, 3), pt("q", 3, 3), pt("r", 19, 4)], [
      { id: "f1", type: "fix", point: "c1" },
      { id: "f2", type: "fix", point: "c2" },
      { id: "ra", type: "radius", curve: "a", value: 5 },
      { id: "rk", type: "radius", curve: "k", value: 3 },
      { id: "o1", type: "point_on", point: "q", curve: "a" },
      { id: "o2", type: "point_on", point: "r", curve: "k" },
    ]);
    expect(dist(s.p("q"), s.p("c1"))).toBeCloseTo(5, 8);
    expect(dist(s.p("r"), s.p("c2"))).toBeCloseTo(3, 8);
  });

  it("projected model edges stay where they are and can be used: line, circle and arc", () => {
    const external: SolvedCurve[] = [
      { id: "x1", kind: "line", a: [0, 0], b: [50, 0], p1: "", p2: "", construction: false, external: true },
      { id: "x2", kind: "circle", center: [30, 30], radius: 6, c: "", construction: false, external: true },
      { id: "x3", kind: "arc", center: [-20, 0], radius: 4, a0: 0, a1: Math.PI / 2, c: "", start: "", end: "", construction: false, external: true },
    ];
    const s = solver.solve(
      {
        entities: [pt("a", 3, 7), pt("b", 20, 20), pt("c", -15, 3)],
        constraints: [
          { id: "1", type: "point_on", point: "a", curve: "x1" },
          { id: "2", type: "coincident", a: "b", b: "x2.center" },
          { id: "3", type: "point_on", point: "c", curve: "x3" },
        ],
        external,
      },
    );
    expect(s.diagnostics.ok).toBe(true);
    expect((s.points.get("a") as V2)[1]).toBeCloseTo(0, 8);
    expect(s.points.get("b")).toEqual([30, 30].map((v) => expect.closeTo(v, 8)));
    expect(dist(s.points.get("c") as V2, [-20, 0])).toBeCloseTo(4, 8);
  });

  it.each([
    ["tangent between two lines", { type: "tangent", a: "l1", b: "l2" }, /needs a circle or arc/],
    ["equal between a line and a circle", { type: "equal", a: "l1", b: "k" }, /cannot mix lines and circles/],
    ["a radius on a line", { type: "radius", curve: "l1", value: 3 }, /needs a circle or arc/],
    ["a length on a circle", { type: "length", line: "k", value: 3 }, /needs a line/],
    ["an angle with a circle", { type: "angle", a: "l1", b: "k", value: 30 }, /needs two lines/],
    ["an arc angle on a line", { type: "arc_angle", curve: "l1", value: 30 }, /needs an arc/],
    ["a constraint on a curve that does not exist", { type: "horizontal", line: "zz" }, /unknown curve "zz"/],
  ])("explains %s", (_n, c, msg) => {
    const entities = [pt("a", 0, 0), pt("b", 10, 0), pt("c", 10, 10), ln("l1", "a", "b"), ln("l2", "b", "c"), ...circle("k", "kc", 30, 0, 3)];
    expect(() => solver.solve({ entities, constraints: [{ id: "x", ...c } as ResolvedConstraint] })).toThrow(msg);
  });
});
