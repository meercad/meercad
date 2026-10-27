import { beforeAll, describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import { findRegions, selectRegions, SketchSolver, type ResolvedConstraint, type SolvedCurve } from "./index.js";

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
const line = (id: string, a: [number, number], b: [number, number]): SolvedCurve => ({ id, kind: "line", a, b, p1: "", p2: "", construction: false, external: false });
const circle = (id: string, center: [number, number], radius: number): SolvedCurve => ({ id, kind: "circle", center, radius, c: "", construction: false, external: false });
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
    expect(solver.solve({ entities: rect(0, 0, 4, 2), constraints: cons.slice(0, 5) }).diagnostics.dof).toBe(2);
    const bad = solver.solve({ entities: rect(0, 0, 4, 2), constraints: [...cons, { id: "c8", type: "distance", a: "p1", b: "p3", value: 1 }] });
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

    const dragged = solver.solve({ entities: rect(0, 0, 4, 2), constraints: cons.slice(1, 5) }, { drag: { p3: [10, 7] } });
    expect(dragged.points.get("p3")![0]).toBeCloseTo(10);
    expect(dragged.points.get("p2")![0]).toBeCloseTo(10); // vertical l2 follows
  });
});

describe("findRegions", () => {
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
    const arc = (id: string, center: [number, number], a0: number, a1: number): SolvedCurve => ({ id, kind: "arc", center, radius: 5, a0, a1, c: "", start: "", end: "", construction: false, external: false });
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
