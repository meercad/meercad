import { beforeAll, describe, expect, it } from "vitest";
import type { SketchConstraint, SketchEntity } from "@meercad/schema";
import {
  cornerEdit,
  intersectionPoints,
  offsetCurves,
  SketchSolver,
  splineParam,
  splinePoints,
  trimSpline,
  type ResolvedConstraint,
  type SketchData,
  type Vec2,
} from "./index.js";

let solver: SketchSolver;
beforeAll(async () => {
  solver = await SketchSolver.create();
});

const rect = (x0: number, y0: number, x1: number, y1: number): SketchEntity[] => [
  { id: "p1", type: "point", x: x0, y: y0 },
  { id: "p2", type: "point", x: x1, y: y0 },
  { id: "p3", type: "point", x: x1, y: y1 },
  { id: "p4", type: "point", x: x0, y: y1 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const positions = (es: SketchEntity[]) =>
  new Map(es.flatMap((e) => (e.type === "point" ? [[e.id, [e.x, e.y] as Vec2]] : [])));

const at = (d: SketchData, id: string): Vec2 => {
  const p = d.entities.find((e) => e.id === id);
  if (p?.type !== "point") throw new Error(`no point ${id}`);

  return [p.x, p.y];
};

const close = (a: Vec2, b: Vec2) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

/**
 * Solves the edited sketch and returns its solved points: the edit's constraints must agree with its
 * geometry.
 */
function solve(d: SketchData) {
  const s = solver.solve({ entities: d.entities, constraints: d.constraints as ResolvedConstraint[] });
  expect(s.diagnostics.ok).toBe(true);

  return s;
}

const fixedRect: SketchConstraint[] = [
  { id: "f1", type: "fix", point: "p1" },
  { id: "h1", type: "horizontal", line: "l1" },
  { id: "h3", type: "horizontal", line: "l3" },
  { id: "v2", type: "vertical", line: "l2" },
  { id: "v4", type: "vertical", line: "l4" },
  { id: "k1", type: "length", line: "l1", value: 40 },
  { id: "k2", type: "length", line: "l2", value: 20 },
];

describe("cornerEdit", () => {
  it("rounds a corner with a tangent arc of the radius", () => {
    const sk = { entities: rect(0, 0, 40, 20), constraints: fixedRect };
    const d = cornerEdit(sk, positions(sk.entities), "p3", 5, "fillet");
    const arc = d.entities.find((e) => e.type === "arc")!;
    expect(arc.type === "arc" && at(d, arc.center)).toEqual([35, 15]);
    // The lines end where the arc begins, the corner point is gone.
    expect(d.entities.some((e) => e.type === "point" && e.x === 40 && e.y === 20)).toBe(false);

    const l2 = d.entities.find((e) => e.id === "l2")!;
    close(at(d, l2.type === "line" ? l2.p2 : ""), [40, 15]);
    expect(d.constraints.filter((c) => c.type === "tangent")).toHaveLength(2);
    expect(d.constraints.find((c) => c.type === "radius")).toMatchObject({ value: 5 });

    // The rectangle's lengths go with the corner; it still solves to the same shape.
    const s = solve(d);
    const a = s.curves.find((c) => c.kind === "arc")!;
    expect(a.kind === "arc" && a.radius).toBeCloseTo(5, 6);
  });

  it("rounds all four corners without redundant constraints, and stays tangent when resized", () => {
    let sk: SketchData = {
      entities: rect(0, 0, 40, 20),
      constraints: fixedRect.filter((c) => c.type !== "length"),
    };
    for (const p of ["p1", "p2", "p3", "p4"]) sk = cornerEdit(sk, positions(sk.entities), p, 4, "fillet");

    const s = solve(sk);
    expect(s.diagnostics.redundant).toEqual([]);

    // Wider: drag the right side out by fixing the arc centres' x via a distance on the bottom line.
    const bottom = sk.entities.find((e) => e.id === "l1")!;
    if (bottom.type !== "line") throw new Error();

    const wider = solve({
      ...sk,
      constraints: [...sk.constraints, { id: "w", type: "length", line: "l1", value: 50 }],
    });
    const arc = wider.curves.filter((c) => c.kind === "arc");
    expect(arc).toHaveLength(4);

    // Every line end still meets its arc at a right angle to the radius (tangent).
    for (const l of wider.curves.filter((c) => c.kind === "line")) {
      if (l.kind !== "line") continue;

      for (const q of [l.a, l.b]) {
        const a = arc.find(
          (x) =>
            x.kind === "arc" &&
            Math.abs(Math.hypot(q[0] - x.center[0], q[1] - x.center[1]) - x.radius) < 1e-6,
        );
        if (a?.kind !== "arc") continue;

        const dot = (l.b[0] - l.a[0]) * (q[0] - a.center[0]) + (l.b[1] - l.a[1]) * (q[1] - a.center[1]);
        expect(Math.abs(dot)).toBeLessThan(1e-6);
      }
    }
  });

  it("rounds an oblique corner", () => {
    const es: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 20, y: 0 },
      { id: "c", type: "point", x: 0, y: 20 },
      { id: "l1", type: "line", p1: "b", p2: "a" },
      { id: "l2", type: "line", p1: "b", p2: "c" },
    ];
    const d = cornerEdit({ entities: es, constraints: [] }, positions(es), "b", 3, "fillet");
    const arc = d.entities.find((e) => e.type === "arc")!;
    if (arc.type !== "arc") throw new Error();

    const c = at(d, arc.center);
    // The centre is 3 from both lines: y = 3, and distance to x + y = 20 is 3.
    expect(c[1]).toBeCloseTo(3, 6);
    expect((20 - c[0] - c[1]) / Math.SQRT2).toBeCloseTo(3, 6);
    solve(d);
  });

  it("bevels a corner", () => {
    const sk = { entities: rect(0, 0, 40, 20), constraints: [] };
    const d = cornerEdit(sk, positions(sk.entities), "p1", 3, "chamfer");
    const l = d.entities.find((e) => e.type === "line" && !["l1", "l2", "l3", "l4"].includes(e.id))!;
    if (l.type !== "line") throw new Error();

    const [a, b] = [at(d, l.p1), at(d, l.p2)].sort((x, y) => x[0] - y[0]);
    close(a!, [0, 3]);
    close(b!, [3, 0]);
    expect(d.constraints.find((c) => c.type === "length")).toMatchObject({
      value: Math.round(3 * Math.SQRT2 * 1e6) / 1e6,
    });
    solve(d);
  });

  it("explains what is wrong", () => {
    const sk = { entities: rect(0, 0, 40, 20), constraints: [] };
    expect(() => cornerEdit(sk, positions(sk.entities), "p1", 25, "fillet")).toThrow(/too large/);
    expect(() => cornerEdit(sk, positions(sk.entities), "l1", 2, "fillet")).toThrow(/exactly two lines/);
  });
});

describe("offsetCurves", () => {
  it("grows a closed rectangle outwards with joined corners, whichever way it runs", () => {
    for (const es of [rect(0, 0, 40, 20), rect(40, 0, 0, 20)]) {
      const sk = { entities: es, constraints: [] };
      const d = offsetCurves(sk, positions(es), ["l1", "l2", "l3", "l4"], 2);
      const pts = d.entities
        .filter((e) => e.type === "point" && !["p1", "p2", "p3", "p4"].includes(e.id))
        .map((e) => (e.type === "point" ? [e.x, e.y] : [0, 0]));
      expect(pts).toHaveLength(4);

      const xs = pts.map((p) => p[0]!),
        ys = pts.map((p) => p[1]!);
      expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([-2, 42, -2, 22]);
      solve(d);
    }

    const inner = offsetCurves(
      { entities: rect(0, 0, 40, 20), constraints: [] },
      positions(rect(0, 0, 40, 20)),
      ["l1", "l2", "l3", "l4"],
      -2,
    );
    const xs = inner.entities.flatMap((e) =>
      e.type === "point" && !["p1", "p2", "p3", "p4"].includes(e.id) ? [e.x] : [],
    );
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([2, 38]);
  });

  it("moves an open chain to its left", () => {
    const es: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 10, y: 0 },
      { id: "c", type: "point", x: 10, y: 10 },
      { id: "l1", type: "line", p1: "a", p2: "b" },
      { id: "l2", type: "line", p1: "b", p2: "c" },
    ];
    const d = offsetCurves({ entities: es, constraints: [] }, positions(es), ["l1", "l2"], 1);
    const lines = d.entities.filter((e) => e.type === "line" && e.id !== "l1" && e.id !== "l2");
    const pts = lines.flatMap((l) => (l.type === "line" ? [at(d, l.p1), at(d, l.p2)] : []));
    expect(pts).toEqual([
      [0, 1],
      [9, 1],
      [9, 1],
      [9, 10],
    ]);
    solve(d);
  });

  it("offsets a slot: arcs keep their centres and grow with the loop", () => {
    // Slot: lines from (0,0) to (20,0) and (20,10) to (0,10), half circles at both ends.
    const es: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 20, y: 0 },
      { id: "c", type: "point", x: 20, y: 10 },
      { id: "d", type: "point", x: 0, y: 10 },
      { id: "k1", type: "point", x: 20, y: 5 },
      { id: "k2", type: "point", x: 0, y: 5 },
      { id: "l1", type: "line", p1: "a", p2: "b" },
      { id: "a1", type: "arc", center: "k1", start: "b", end: "c" },
      { id: "l2", type: "line", p1: "c", p2: "d" },
      { id: "a2", type: "arc", center: "k2", start: "d", end: "a" },
    ];
    const d = offsetCurves({ entities: es, constraints: [] }, positions(es), ["l1", "a1", "l2", "a2"], 2);
    const radii = d.constraints
      .filter((c) => c.type === "radius")
      .map((c) => (c.type === "radius" ? c.value : 0));
    expect(radii).toEqual([7, 7]);

    const arcs = d.entities.filter((e) => e.type === "arc" && e.id !== "a1" && e.id !== "a2");
    expect(arcs.map((a) => (a.type === "arc" ? a.center : ""))).toEqual(["k1", "k2"]);

    const ys = d.entities
      .filter((e) => e.type === "point" && e.id.startsWith("p"))
      .map((e) => (e.type === "point" ? e.y : 0));
    expect([Math.min(...ys), Math.max(...ys)]).toEqual([-2, 12]);
  });

  it("offsets a rounded rectangle inwards without redundant constraints", () => {
    // As the sketch tools do it: a 60 × 40 rectangle, its corners rounded R5, offset 3 inwards.
    let sk: SketchData = { entities: rect(0, 0, 60, 40), constraints: fixedRect };
    for (const p of ["p1", "p2", "p3", "p4"]) sk = cornerEdit(sk, positions(sk.entities), p, 5, "fillet");

    const curves = sk.entities.filter((e) => e.type === "line" || e.type === "arc").map((e) => e.id);
    const d = offsetCurves(sk, solve(sk).points, curves, -3);
    const s = solve(d);
    expect(s.diagnostics.redundant).toEqual([]);

    const inner = s.curves.filter((c) => c.kind === "arc" && !curves.includes(c.id));
    expect(inner.map((c) => (c.kind === "arc" ? +c.radius.toFixed(6) : 0))).toEqual([2, 2, 2, 2]);
  });

  it("grows circles and explains errors", () => {
    const es: SketchEntity[] = [
      { id: "o", type: "point", x: 0, y: 0 },
      { id: "c1", type: "circle", center: "o", radius: 5 },
    ];
    const d = offsetCurves({ entities: es, constraints: [] }, positions(es), ["c1"], 3);
    expect(d.entities.find((e) => e.type === "circle" && e.id !== "c1")).toMatchObject({
      center: "o",
      radius: 8,
    });
    expect(() => offsetCurves({ entities: es, constraints: [] }, positions(es), ["c1"], -6)).toThrow(
      /larger than a radius/,
    );
  });
});

describe("splinePoints", () => {
  it("passes through every point, smoothly between them", async () => {
    const { splinePoints, SPLINE_SAMPLES } = await import("./index.js");
    const through: Vec2[] = [
      [0, 0],
      [10, 10],
      [20, 0],
      [30, 10],
    ];
    const pts = splinePoints(through);
    expect(pts).toHaveLength(3 * SPLINE_SAMPLES + 1);
    through.forEach((p, i) => close(pts[i * SPLINE_SAMPLES]!, p));
    // No overshoot far beyond the points (centripetal): stays within a small margin of their box.
    for (const p of pts) expect(p[1]).toBeLessThan(12);

    const loop = splinePoints(through, true);
    close(loop[loop.length - 1]!, through[0]!);
  });
});

describe("patternCurves", () => {
  it("repeats circles in a row and round a centre, sizes kept equal", async () => {
    const { patternCurves } = await import("./index.js");
    const es: SketchEntity[] = [
      { id: "o", type: "point", x: 10, y: 0 },
      { id: "c1", type: "circle", center: "o", radius: 2 },
    ];
    const row = patternCurves({ entities: es, constraints: [] }, positions(es), ["c1"], {
      kind: "linear",
      count: 4,
      dx: 15,
      dy: 0,
    });
    const xs = row.entities.filter((e) => e.type === "point").map((e) => (e.type === "point" ? e.x : 0));
    expect(xs).toEqual([10, 25, 40, 55]);
    expect(row.constraints.filter((c) => c.type === "equal")).toHaveLength(3);
    solve(row);

    const ring = patternCurves({ entities: es, constraints: [] }, positions(es), ["c1"], {
      kind: "circular",
      count: 4,
      angle: 90,
      center: [0, 0],
    });
    const pts = ring.entities
      .filter((e) => e.type === "point")
      .map((e) =>
        e.type === "point" ? [Math.round(e.x * 1e6) / 1e6 + 0, Math.round(e.y * 1e6) / 1e6 + 0] : [],
      );
    expect(pts).toEqual([
      [10, 0],
      [0, 10],
      [-10, 0],
      [0, -10],
    ]);
  });

  it("keeps shared corners shared in each copy", async () => {
    const { patternCurves } = await import("./index.js");
    const sk = { entities: rect(0, 0, 10, 5), constraints: [] };
    const d = patternCurves(sk, positions(sk.entities), ["l1", "l2", "l3", "l4"], {
      kind: "linear",
      count: 3,
      dx: 0,
      dy: 10,
    });
    // Two copies of a closed rectangle: 4 new points each (not 8).
    expect(d.entities.filter((e) => e.type === "point")).toHaveLength(4 + 8);
    expect(d.entities.filter((e) => e.type === "line")).toHaveLength(12);
    expect(() =>
      patternCurves(sk, positions(sk.entities), ["l1"], { kind: "linear", count: 1, dx: 1, dy: 0 }),
    ).toThrow(/count/);
  });
});

describe("trimSpline", () => {
  const spline = (through: Vec2[], closed = false) => ({
    id: "s1",
    kind: "spline" as const,
    pts: splinePoints(through, closed),
    through,
    points: through.map((_, i) => `p${i}`),
    closed,
    construction: false,
    external: false,
  });
  // A wave from x = 0 to 80 through five points; vertical lines at x = 30 and 50 cross it.
  const wave = spline([
    [0, 0],
    [20, 15],
    [40, -10],
    [60, 10],
    [80, 0],
  ]);
  const cutAt = (x: number) =>
    intersectionPoints(wave, {
      id: "l",
      kind: "line",
      a: [x, -50],
      b: [x, 50],
      p1: "a",
      p2: "b",
      construction: false,
      external: false,
    })[0]!;
  const cuts = [cutAt(30), cutAt(50)];

  it("cuts out the stretch between the cuts around the click, keeping the old points on both sides", () => {
    expect(trimSpline(wave, [40, -10], cuts)).toEqual([
      [{ point: 0 }, { point: 1 }, { cut: 0 }],
      [{ cut: 1 }, { point: 3 }, { point: 4 }],
    ]);
  });

  it("shortens it from the end when only one cut is beside the click", () => {
    expect(trimSpline(wave, [70, 5], cuts)).toEqual([[{ point: 0 }, { point: 1 }, { point: 2 }, { cut: 1 }]]);
    expect(trimSpline(wave, [5, 3], cuts)).toEqual([[{ cut: 0 }, { point: 2 }, { point: 3 }, { point: 4 }]]);
  });

  it("removes it all when nothing crosses it", () => {
    expect(trimSpline(wave, [40, -10], [])).toEqual([]);
  });

  it("stays close to the old shape and ends on the cut", () => {
    const [piece] = trimSpline(wave, [70, 5], cuts);
    const through = piece!.map((x) => ("point" in x ? wave.through[x.point]! : cuts[x.cut]!));

    for (const q of splinePoints(through)) {
      const s = splineParam(wave.pts, q);
      const i = Math.min(Math.floor(s), wave.pts.length - 2);
      const [a, b] = [wave.pts[i]!, wave.pts[i + 1]!];
      expect(
        Math.hypot(a[0] + (b[0] - a[0]) * (s - i) - q[0], a[1] + (b[1] - a[1]) * (s - i) - q[1]),
      ).toBeLessThan(1);
    }

    close(through[through.length - 1]!, cuts[1]!);
  });

  it("opens a closed spline between the two cuts around the click", () => {
    const ring = spline(
      [
        [0, -20],
        [20, 0],
        [0, 20],
        [-20, 0],
      ],
      true,
    );
    const cross = (x: number) =>
      intersectionPoints(ring, {
        id: "l",
        kind: "line",
        a: [x, -50],
        b: [x, 50],
        p1: "a",
        p2: "b",
        construction: false,
        external: false,
      });
    const hits = [...cross(10), ...cross(-10)];
    expect(hits).toHaveLength(4);

    // Clicking the right-hand bulge removes it: what stays runs from its top cut around the left to its
    // bottom cut.
    const [piece] = trimSpline(ring, [20, 0], hits);
    const right = hits.map((h, i) => ({ h, i })).filter(({ h }) => h[0] > 0);
    const top = right.find(({ h }) => h[1] > 0)!.i;
    const bottom = right.find(({ h }) => h[1] < 0)!.i;
    expect(piece![0]).toEqual({ cut: top });
    expect(piece![piece!.length - 1]).toEqual({ cut: bottom });
    expect(piece!.filter((x) => "point" in x)).toEqual([{ point: 2 }, { point: 3 }, { point: 0 }]);
    expect(trimSpline(ring, [20, 0], cross(10))).toHaveLength(1);
    expect(trimSpline(ring, [20, 0], [hits[0]!])).toEqual([]);
  });
});

describe("sketch edits refuse what cannot be done", () => {
  const es = rect(0, 0, 40, 30);
  const sk = { entities: es, constraints: [] as SketchConstraint[] };
  it("corners: a size of 0, a corner with no position, lines in line", () => {
    expect(() => cornerEdit(sk, positions(es), "p1", 0, "fillet")).toThrow(
      /radius must be greater than zero/,
    );
    expect(() => cornerEdit(sk, positions(es), "p1", -1, "chamfer")).toThrow(
      /distance must be greater than zero/,
    );
    expect(() => cornerEdit(sk, new Map(), "p1", 2, "fillet")).toThrow(/has no position/);

    const straight: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 10, y: 0 },
      { id: "c", type: "point", x: 20, y: 0 },
      { id: "m", type: "line", p1: "a", p2: "b" },
      { id: "n", type: "line", p1: "b", p2: "c" },
    ];
    expect(() =>
      cornerEdit({ entities: straight, constraints: [] }, positions(straight), "b", 2, "fillet"),
    ).toThrow(/in line/);
  });
  it("a corner joined by a coincident constraint instead of a shared point is still found", () => {
    const split: SketchEntity[] = [
      { id: "a", type: "point", x: 0, y: 0 },
      { id: "b", type: "point", x: 10, y: 0 },
      { id: "b2", type: "point", x: 10, y: 0 },
      { id: "c", type: "point", x: 10, y: 10 },
      { id: "m", type: "line", p1: "a", p2: "b" },
      { id: "n", type: "line", p1: "b2", p2: "c" },
    ];
    const d = cornerEdit(
      { entities: split, constraints: [{ id: "k", type: "coincident", a: "b", b: "b2" }] },
      positions(split),
      "b",
      2,
      "chamfer",
    );
    expect(d.entities.some((e) => e.type === "line" && e.id !== "m" && e.id !== "n")).toBe(true);
  });
  it("offsets: zero, nothing picked, a radius that would vanish", () => {
    expect(() => offsetCurves(sk, positions(es), ["l1"], 0)).toThrow(/must not be zero/);
    expect(() => offsetCurves(sk, positions(es), [], 2)).toThrow(/pick lines, arcs or circles/);

    const c: SketchEntity[] = [
      { id: "o", type: "point", x: 0, y: 0 },
      { id: "k", type: "circle", center: "o", radius: 2 },
    ];
    expect(() => offsetCurves({ entities: c, constraints: [] }, positions(c), ["k"], -3)).toThrow(
      /would vanish/,
    );
    expect(() => offsetCurves(sk, new Map(), ["l1"], 2)).toThrow(/has no position/);
  });
  it("patterns: nothing picked, a count out of range; arcs are repeated too", async () => {
    const { patternCurves } = await import("./index.js");
    expect(() => patternCurves(sk, positions(es), [], { kind: "linear", count: 3, dx: 5, dy: 0 })).toThrow(
      /pick the curves to repeat/,
    );
    expect(() =>
      patternCurves(sk, positions(es), ["l1"], { kind: "linear", count: 1, dx: 5, dy: 0 }),
    ).toThrow(/between 2 and 200/);
    expect(() => patternCurves(sk, new Map(), ["l1"], { kind: "linear", count: 2, dx: 5, dy: 0 })).toThrow(
      /has no position/,
    );

    const a: SketchEntity[] = [
      { id: "c", type: "point", x: 0, y: 0 },
      { id: "s", type: "point", x: 5, y: 0 },
      { id: "e", type: "point", x: 0, y: 5 },
      { id: "a1", type: "arc", center: "c", start: "s", end: "e" },
    ];
    const out = patternCurves({ entities: a, constraints: [] }, positions(a), ["a1"], {
      kind: "linear",
      count: 3,
      dx: 20,
      dy: 0,
    });
    expect(out.entities.filter((e) => e.type === "arc")).toHaveLength(3);

    const centres = out.entities
      .filter((e) => e.type === "arc")
      .map((e) => at(out, (e as { center: string }).center)[0]);
    expect(centres).toEqual([0, 20, 40]);
  });
});
