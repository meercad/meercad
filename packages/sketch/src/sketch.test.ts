import { beforeAll, describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import {
  findRegions,
  selectRegions,
  SketchSolver,
  type ResolvedConstraint,
  type SolvedCurve,
} from "./index.js";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});

const rect = (x0: number, y0: number, x1: number, y1: number, p = "p", l = "l"): SketchEntity[] => [
  { id: `${p}1`, type: "point", x: x0, y: y0 },
  { id: `${p}2`, type: "point", x: x1, y: y0 },
  { id: `${p}3`, type: "point", x: x1, y: y1 },
  { id: `${p}4`, type: "point", x: x0, y: y1 },
  { id: `${l}1`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${l}2`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${l}3`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${l}4`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const line = (id: string, a: [number, number], b: [number, number]): SolvedCurve => ({
  id,
  kind: "line",
  a,
  b,
  p1: "",
  p2: "",
  construction: false,
  external: false,
});
const circle = (id: string, center: [number, number], radius: number): SolvedCurve => ({
  id,
  kind: "circle",
  center,
  radius,
  c: "",
  construction: false,
  external: false,
});
const box = (x0: number, y0: number, x1: number, y1: number, p = "l"): SolvedCurve[] => [
  line(`${p}1`, [x0, y0], [x1, y0]),
  line(`${p}2`, [x1, y0], [x1, y1]),
  line(`${p}3`, [x1, y1], [x0, y1]),
  line(`${p}4`, [x0, y1], [x0, y0]),
];

describe("SketchSolver", () => {
  const cons: ResolvedConstraint[] = [
    { id: "c1", type: "coincident", a: "p1", b: "origin" },
    { id: "c2", type: "horizontal", line: "l1" },
    { id: "c3", type: "horizontal", line: "l3" },
    { id: "c4", type: "vertical", line: "l2" },
    { id: "c5", type: "vertical", line: "l4" },
    { id: "c6", type: "length", line: "l1", value: 40 },
    { id: "c7", type: "length", line: "l2", value: 20 },
  ];

  it("solves a fully constrained rectangle from a sloppy drawing", () => {
    const s = solver.solve({ entities: rect(1, -2, 33, 17), constraints: cons });
    expect(s.diagnostics).toMatchObject({ ok: true, dof: 0 });
    expect(s.points.get("p3")![0]).toBeCloseTo(40);
    expect(s.points.get("p3")![1]).toBeCloseTo(20);
    expect(s.points.get("l2.p2")).toEqual(s.points.get("p3"));
  });

  it("reports remaining DOF and conflicts", () => {
    expect(solver.solve({ entities: rect(0, 0, 4, 2), constraints: cons.slice(0, 5) }).diagnostics.dof).toBe(
      2,
    );

    const bad = solver.solve({
      entities: rect(0, 0, 4, 2),
      constraints: [...cons, { id: "c8", type: "distance", a: "p1", b: "p3", value: 1 }],
    });
    expect(bad.diagnostics.ok).toBe(false);
    expect(bad.diagnostics.conflicting.length).toBeGreaterThan(0);
  });

  it("handles circles, arcs, tangency, angles and drag", () => {
    const entities: SketchEntity[] = [
      { id: "c", type: "point", x: 0, y: 0 },
      { id: "s", type: "point", x: 10, y: 0 },
      { id: "e", type: "point", x: 0, y: 10 },
      { id: "a1", type: "arc", center: "c", start: "s", end: "e" },
      { id: "q", type: "point", x: 30, y: 30 },
      { id: "k", type: "circle", center: "q", radius: 3 },
      { id: "m", type: "point", x: 0, y: 30 },
      { id: "l", type: "line", p1: "q", p2: "m" },
    ];
    const s = solver.solve({
      entities,
      constraints: [
        { id: "f", type: "fix", point: "c" },
        { id: "r", type: "radius", curve: "a1", value: 12 },
        { id: "d", type: "diameter", curve: "k", value: 10 },
        { id: "ang", type: "angle", a: "l", b: "origin.x", value: 30 },
      ],
    });
    expect(s.diagnostics.ok).toBe(true);

    const arc = s.curves.find((c) => c.id === "a1")!;
    expect(arc.kind === "arc" && arc.radius).toBeCloseTo(12);

    const k = s.curves.find((c) => c.id === "k")!;
    expect(k.kind === "circle" && k.radius).toBeCloseTo(5);

    const [q, m] = [s.points.get("q")!, s.points.get("m")!];
    const deg = (Math.atan2(Math.abs(m[1] - q[1]), Math.abs(m[0] - q[0])) * 180) / Math.PI;
    expect(deg).toBeCloseTo(30, 4);

    const dragged = solver.solve(
      { entities: rect(0, 0, 4, 2), constraints: cons.slice(1, 5) },
      { drag: { p3: [10, 7] } },
    );
    expect(dragged.points.get("p3")![0]).toBeCloseTo(10);
    expect(dragged.points.get("p2")![0]).toBeCloseTo(10); // vertical l2 follows
  });
});

describe("arc angle", () => {
  it("sets how far an arc sweeps, keeping its start", () => {
    const s = solver.solve({
      entities: [
        { id: "c", type: "point", x: 0, y: 0 },
        { id: "s", type: "point", x: 10, y: 0 },
        { id: "e", type: "point", x: 0, y: 10 },
        { id: "a1", type: "arc", center: "c", start: "s", end: "e" },
      ],
      constraints: [
        { id: "f", type: "fix", point: "c" },
        { id: "f2", type: "fix", point: "s" },
        { id: "sw", type: "arc_angle", curve: "a1", value: 135 },
      ],
    });
    expect(s.diagnostics.ok).toBe(true);

    const e = s.points.get("e")!;
    expect((Math.atan2(e[1], e[0]) * 180) / Math.PI).toBeCloseTo(135, 3);
    expect(Math.hypot(e[0], e[1])).toBeCloseTo(10, 3);
  });
});

describe("tangent to a spline end", () => {
  const dir = (a: [number, number] | undefined, b: [number, number] | undefined) => {
    const d = Math.hypot(b![0] - a![0], b![1] - a![1]);

    return [(b![0] - a![0]) / d, (b![1] - a![1]) / d];
  };

  const wave: SketchEntity[] = [
    { id: "s1p", type: "point", x: 10, y: 0 },
    { id: "s2p", type: "point", x: 20, y: 8 },
    { id: "s3p", type: "point", x: 35, y: -4 },
    { id: "s1", type: "spline", points: ["s1p", "s2p", "s3p"] },
  ];

  it("turns the spline's first span in line with a line ending there", () => {
    const s = solver.solve({
      entities: [
        { id: "a", type: "point", x: 0, y: 0 },
        ...wave,
        { id: "l1", type: "line", p1: "a", p2: "s1p" },
      ],
      constraints: [
        { id: "f1", type: "fix", point: "a" },
        { id: "f2", type: "fix", point: "s1p" },
        { id: "f3", type: "fix", point: "s3p" },
        { id: "t", type: "tangent", a: "l1", b: "s1" },
      ],
    });
    expect(s.diagnostics.ok).toBe(true);
    // The line runs along x, so the spline leaves its start along x too: the next point moved onto y = 0.
    expect(s.points.get("s2p")![1]).toBeCloseTo(0, 6);

    const sp = s.curves.find((c) => c.id === "s1")!;
    const d = sp.kind === "spline" ? dir(sp.pts[0], sp.pts[1]) : [];
    expect(d[0]).toBeCloseTo(1, 3);
  });

  it("joins an arc smoothly at the spline's last point, and another spline", () => {
    const s = solver.solve({
      entities: [
        ...wave,
        { id: "c", type: "point", x: 35, y: -14 },
        { id: "e", type: "point", x: 45, y: -14 },
        { id: "a1", type: "arc", center: "c", start: "e", end: "s3p" },
        { id: "q1", type: "point", x: 0, y: 10 },
        { id: "s2", type: "spline", points: ["q1", "s1p"] },
      ],
      constraints: [
        { id: "f1", type: "fix", point: "c" },
        { id: "f2", type: "fix", point: "s1p" },
        { id: "f3", type: "fix", point: "q1" },
        { id: "t1", type: "tangent", a: "s1", b: "a1" },
        { id: "t2", type: "tangent", a: "s2", b: "s1" },
      ],
    });
    expect(s.diagnostics.ok).toBe(true);

    const at = (id: string) => s.points.get(id)!;
    // At the arc's end the radius is perpendicular to the spline's last span.
    const r = dir(at("c"), at("s3p"));
    const span = dir(at("s2p"), at("s3p"));
    expect(r[0]! * span[0]! + r[1]! * span[1]!).toBeCloseTo(0, 6);

    // The two splines run on in one direction through their shared point.
    const into = dir(at("q1"), at("s1p"));
    const out = dir(at("s1p"), at("s2p"));
    expect(into[0]! * out[0]! + into[1]! * out[1]!).toBeCloseTo(1, 6);
  });

  it("asks for a shared end", () => {
    const s = () =>
      solver.solve({
        entities: [
          ...wave,
          { id: "a", type: "point", x: 0, y: 5 },
          { id: "b", type: "point", x: 5, y: 5 },
          { id: "l1", type: "line", p1: "a", p2: "b" },
        ],
        constraints: [{ id: "t", type: "tangent", a: "l1", b: "s1" }],
      });
    expect(s).toThrow(/must end where the other curve ends/);
  });
});

describe("findRegions", () => {
  it("keeps an arc whole when it is a hair off its line's end", () => {
    // A slanted slot with round ends exactly as the solver returned it: the arcs' radii are off by
    // rounding, and splitting an arc at the near-miss left a sliver region without area.
    const line = (id: string, a: [number, number], b: [number, number]): SolvedCurve =>
      ({ id, kind: "line", a, b, construction: false }) as SolvedCurve;
    const arc = (id: string, center: [number, number], radius: number, a0: number, a1: number): SolvedCurve =>
      ({ id, kind: "arc", center, radius, a0, a1, construction: false }) as SolvedCurve;
    const regions = findRegions([
      line("l1", [-1.670493, 33.634481], [80.105334, 71.220571]),
      arc("a1", [81.775827, 67.58609], 3.9999998753012465, -1.1399683488775014, 2.001624304712294),
      line("l2", [83.44632, 63.951609], [1.670493, 26.365519]),
      arc("a2", [0, 30], 3.999999875301249, 2.0016243047122932, 5.143216958302086),
    ]);
    expect(regions.map((x) => x.key)).toEqual(["a1+a2+l1+l2"]);
    expect(regions[0]!.area).toBeCloseTo(90 * 8 + Math.PI * 16, 1);
  });

  it("finds a rectangle region with semantic key", () => {
    const r = findRegions(box(0, 0, 40, 20));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ key: "l1+l2+l3+l4", depth: 1 });
    expect(r[0]!.area).toBeCloseTo(800);
  });

  it("turns a circle inside a rectangle into a hole (even-odd)", () => {
    const r = findRegions([...box(0, 0, 40, 20), circle("c1", [20, 10], 5)]);
    expect(r.map((x) => x.key).sort()).toEqual(["c1", "l1+l2+l3+l4|c1"]);

    const ring = r.find((x) => x.key.includes("|"))!;
    expect(ring.area).toBeCloseTo(800 - Math.PI * 25);

    const picked = selectRegions(r, "all").regions;
    expect(picked.map((x) => x.key)).toEqual(["l1+l2+l3+l4|c1"]);
  });

  it("splits crossing curves and drops dangling pieces", () => {
    // Two overlapping rectangles: 3 regions, lens at depth 2.
    const r = findRegions([...box(0, 0, 20, 20, "a"), ...box(10, 10, 30, 30, "b")]);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.depth).sort()).toEqual([1, 1, 2]);
    expect(r.reduce((s, x) => s + x.area, 0)).toBeCloseTo(700);

    // A line across a circle splits it into two halves with distinct keys; the overhang is ignored.
    const h = findRegions([circle("c1", [0, 0], 10), line("l9", [-15, 0], [15, 0])]);
    expect(h).toHaveLength(2);
    expect(new Set(h.map((x) => x.key)).size).toBe(2);
    for (const x of h) expect(x.area).toBeCloseTo((Math.PI * 100) / 2, 3);
  });

  it("supports slots made of lines and arcs", () => {
    const arc = (id: string, center: [number, number], a0: number, a1: number): SolvedCurve => ({
      id,
      kind: "arc",
      center,
      radius: 5,
      a0,
      a1,
      c: "",
      start: "",
      end: "",
      construction: false,
      external: false,
    });
    const r = findRegions([
      line("t", [0, 5], [20, 5]),
      line("b", [20, -5], [0, -5]),
      arc("ar", [20, 0], -Math.PI / 2, Math.PI / 2),
      arc("al", [0, 0], Math.PI / 2, (3 * Math.PI) / 2),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]!.area).toBeCloseTo(200 + Math.PI * 25, 6);
  });
});
