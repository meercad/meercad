import { describe, expect, it } from "vitest";
import type { SketchEntity } from "@meercad/schema";
import {
  SPLINE_SAMPLES,
  splineArms,
  splineDisplayPoints,
  splinePoints,
  splineSpans,
  type Vec2,
} from "./geometry.js";
import { ownTangents, tangentEnds } from "./solve.js";

/** The spline as it was sampled before points could have their own tangents (Barry-Goldman). */
function catmullRom(through: readonly Vec2[], closed = false): Vec2[] {
  const n = through.length;
  if (n < 2) return [...through];
  if (n === 2 && !closed) return [through[0]!, through[1]!];

  const at = (i: number): Vec2 => {
    if (closed) return through[((i % n) + n) % n]!;
    if (i < 0) return [2 * through[0]![0] - through[1]![0], 2 * through[0]![1] - through[1]![1]];

    if (i >= n) {
      return [2 * through[n - 1]![0] - through[n - 2]![0], 2 * through[n - 1]![1] - through[n - 2]![1]];
    }

    return through[i]!;
  };

  const out: Vec2[] = [through[0]!];
  const spans = closed ? n : n - 1;

  for (let i = 0; i < spans; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const dt = (a: Vec2, b: Vec2) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9);
    const [t0, t1] = [0, dt(p0, p1)];
    const t2 = t1 + dt(p1, p2);
    const t3 = t2 + dt(p2, p3);

    for (let k = 1; k <= SPLINE_SAMPLES; k++) {
      const t = t1 + ((t2 - t1) * k) / SPLINE_SAMPLES;

      const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
        const w = (t - ta) / (tb - ta);

        return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
      };

      const [a1, a2, a3] = [lerp(p0, p1, t0, t1), lerp(p1, p2, t1, t2), lerp(p2, p3, t2, t3)];
      const [b1, b2] = [lerp(a1, a2, t0, t2), lerp(a2, a3, t1, t3)];
      out.push(k === SPLINE_SAMPLES ? (closed && i === spans - 1 ? through[0]! : p2) : lerp(b1, b2, t1, t2));
    }
  }

  return out;
}

const near = (a: Vec2, b: Vec2, eps = 1e-9) => {
  expect(Math.abs(a[0] - b[0])).toBeLessThan(eps);
  expect(Math.abs(a[1] - b[1])).toBeLessThan(eps);
};

const wave: Vec2[] = [
  [0, 0],
  [10, 10],
  [12, -3],
  [30, 10],
  [31, 10],
];

describe("spline without own tangents", () => {
  it("is the same curve as before, sample for sample (files keep their shape and regions)", () => {
    for (const closed of [false, true]) {
      for (const through of [
        wave,
        wave.slice(0, 3),
        [
          [0, 0],
          [5, 5],
          [5, 5],
          [9, 0],
        ] as Vec2[],
      ]) {
        const before = catmullRom(through, closed);
        const now = splinePoints(through, closed);
        expect(now).toHaveLength(before.length);
        now.forEach((p, i) => near(p, before[i]!));
        // Null tangents are automatic too.
        expect(
          splinePoints(
            through,
            closed,
            through.map(() => null),
          ),
        ).toEqual(now);
      }
    }
  });

  it("keeps a two-point open spline as its two ends, and a single point as it is", () => {
    expect(
      splinePoints([
        [0, 0],
        [4, 0],
      ]),
    ).toEqual([
      [0, 0],
      [4, 0],
    ]);
    expect(
      splineDisplayPoints([
        [0, 0],
        [4, 0],
      ]),
    ).toEqual([
      [0, 0],
      [4, 0],
    ]);
    expect(splinePoints([[1, 2]])).toEqual([[1, 2]]);
    expect(splineSpans([[1, 2]])).toEqual([]);
    expect(splineArms([[1, 2]])).toEqual([{ back: [0, 0], ahead: [0, 0] }]);
  });

  it("has handles along the curve: open ends point at their neighbour", () => {
    const arms = splineArms(wave);
    // The open end leaves straight towards the next point.
    const a = arms[0]!.ahead;
    expect(Math.abs(a[0] * 10 - a[1] * 10)).toBeLessThan(1e-9);

    // Backward and forward arms of a point are collinear and opposite.
    for (const { back, ahead } of arms.slice(1, -1)) {
      expect(Math.abs(back[0] * ahead[1] - back[1] * ahead[0])).toBeLessThan(1e-9);
      expect(back[0] * ahead[0] + back[1] * ahead[1]).toBeLessThan(0);
    }
  });
});

describe("spline with own tangents", () => {
  it("leaves a point along its tangent and still passes through every point", () => {
    const tangents: (Vec2 | null)[] = [null, [6, 0], null, null, null];
    const pts = splinePoints(wave, false, tangents);
    expect(pts).toHaveLength(4 * SPLINE_SAMPLES + 1);
    wave.forEach((p, i) => near(pts[i * SPLINE_SAMPLES]!, p));

    // Just after the point the curve heads along +x, just before it comes from -x.
    const after = pts[SPLINE_SAMPLES + 1]!;
    const before = pts[SPLINE_SAMPLES - 1]!;
    expect(after[0]).toBeGreaterThan(10);
    expect(Math.abs(after[1] - 10)).toBeLessThan(0.3);
    expect(before[0]).toBeLessThan(10);

    // The handle is the tangent forwards and mirrored backwards; other points stay automatic.
    const arms = splineArms(wave, false, tangents);
    expect(arms[1]).toEqual({ back: [-6, -0], ahead: [6, 0] });
    expect(arms[2]).toEqual(splineArms(wave)[2]);

    // The spans' control points are the arms' ends.
    const span = splineSpans(wave, false, tangents)[1]!;
    expect(span[0]).toEqual([10, 10]);
    expect(span[1]).toEqual([16, 10]);
  });

  it("bends a two-point spline, and closed splines too", () => {
    const pts = splinePoints(
      [
        [0, 0],
        [10, 0],
      ],
      false,
      [[0, 5], null],
    );
    expect(pts).toHaveLength(SPLINE_SAMPLES + 1);
    expect(Math.max(...pts.map((p) => p[1]))).toBeGreaterThan(1);

    const loop = splinePoints(wave.slice(0, 3), true, [[3, 3], null, null]);
    expect(loop).toHaveLength(3 * SPLINE_SAMPLES + 1);
    near(loop[loop.length - 1]!, wave[0]!);
  });
});

describe("splineDisplayPoints", () => {
  it("draws bends finer than the model's samples, straight stretches no coarser", () => {
    const sharp: Vec2[] = [
      [0, 0],
      [50, 50],
      [100, 0],
    ];
    const fine = splineDisplayPoints(sharp);
    expect(fine.length).toBeGreaterThan(splinePoints(sharp).length);
    // It still goes through the points, first and last exactly.
    expect(fine[0]).toEqual(sharp[0]);
    expect(fine[fine.length - 1]).toEqual(sharp[2]);

    // No more than ~1.5° turn between two samples.
    for (let i = 1; i + 1 < fine.length; i++) {
      const [a, b, c] = [fine[i - 1]!, fine[i]!, fine[i + 1]!];
      const u = [b[0] - a[0], b[1] - a[1]];
      const w = [c[0] - b[0], c[1] - b[1]];
      const turn = Math.abs(Math.atan2(u[0]! * w[1]! - u[1]! * w[0]!, u[0]! * w[0]! + u[1]! * w[1]!));
      expect(turn).toBeLessThan((2 * Math.PI) / 180);
    }

    // Nearly straight: the model's own count.
    const flat: Vec2[] = [
      [0, 0],
      [10, 0.01],
      [20, 0],
    ];
    expect(splineDisplayPoints(flat)).toHaveLength(splinePoints(flat).length);
  });

  it("copes with repeated points", () => {
    const pts = splineDisplayPoints(
      [
        [0, 0],
        [0, 0],
        [5, 0],
      ],
      false,
      [null, null, [0, 0]],
    );
    expect(pts[pts.length - 1]).toEqual([5, 0]);
    expect(pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);
  });
});

describe("tangentEnds and ownTangents", () => {
  const entities: SketchEntity[] = [
    { id: "a", type: "point", x: 0, y: 0 },
    { id: "b", type: "point", x: 5, y: 5 },
    { id: "c", type: "point", x: 10, y: 0 },
    { id: "d", type: "point", x: 20, y: 0 },
    { id: "e", type: "point", x: 0, y: 9 },
    {
      id: "s",
      type: "spline",
      points: ["a", "b", "c"],
      tangents: [
        [1, 0],
        [2, 0],
        [3, 0],
      ],
    },
    { id: "l", type: "line", p1: "c", p2: "d" },
    { id: "r", type: "arc", center: "e", start: "a", end: "b" },
    { id: "t", type: "spline", points: ["d", "e"] },
    { id: "loop", type: "spline", points: ["a", "b", "c"], closed: true, tangents: [[1, 0], null, null] },
  ];
  const spline = (id: string) =>
    entities.find((x) => x.id === id) as Extract<SketchEntity, { type: "spline" }>;

  it("finds the ends that are tangent to a line, an arc or another spline", () => {
    expect([...tangentEnds(spline("s"), entities, [])]).toEqual([]);
    expect([...tangentEnds(spline("s"), entities, [{ type: "tangent", a: "s", b: "l" }])]).toEqual([2]);
    expect([...tangentEnds(spline("s"), entities, [{ type: "tangent", a: "r", b: "s" }])]).toEqual([0]);
    expect([...tangentEnds(spline("t"), entities, [{ type: "tangent", a: "t", b: "l" }])]).toEqual([0]);
    expect([...tangentEnds(spline("s"), entities, [{ type: "tangent", a: "s", b: "t" }])]).toEqual([]);
    // Other constraints, other curves, closed splines and unknown ids count for nothing.
    expect([
      ...tangentEnds(spline("s"), entities, [
        { type: "parallel", a: "s", b: "l" },
        { type: "tangent", a: "l", b: "r" },
        { type: "tangent", a: "s", b: "loop" },
        { type: "tangent", a: "s", b: "zz" },
      ]),
    ]).toEqual([]);
    expect([...tangentEnds(spline("loop"), entities, [{ type: "tangent", a: "loop", b: "l" }])]).toEqual([]);
  });

  it("keeps the own tangents except at tangent ends", () => {
    expect(ownTangents(spline("t"), entities, [])).toBeUndefined();
    expect(ownTangents(spline("s"), entities, [])).toEqual([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(ownTangents(spline("s"), entities, [{ type: "tangent", a: "s", b: "l" }])).toEqual([
      [1, 0],
      [2, 0],
      null,
    ]);
    expect(ownTangents(spline("loop"), entities, [])).toEqual([[1, 0], null, null]);

    const ends: Extract<SketchEntity, { type: "spline" }> = {
      id: "s",
      type: "spline",
      points: ["a", "c"],
      tangents: [null, [1, 1]],
    };
    expect(ownTangents(ends, entities, [{ type: "tangent", a: "s", b: "l" }])).toBeUndefined();
  });
});

describe("splines as the solver gives them", () => {
  it("a closed spline comes with its fine drawing, closed as well", async () => {
    const { SketchSolver } = await import("./index.js");
    const solver = await SketchSolver.create();
    const s = solver.solve({
      entities: [
        { id: "a", type: "point", x: 0, y: 0 },
        { id: "b", type: "point", x: 20, y: 0 },
        { id: "c", type: "point", x: 10, y: 15 },
        { id: "sp", type: "spline", points: ["a", "b", "c"], closed: true },
      ],
      constraints: [],
    });
    const sp = s.curves.find((c) => c.id === "sp")!;

    expect(sp.kind === "spline" && sp.closed).toBe(true);
    if (sp.kind !== "spline") return;

    expect(sp.fine!.length).toBeGreaterThan(sp.pts.length);
    // The fine drawing ends where it starts, like the curve.
    expect(sp.fine![sp.fine!.length - 1]).toEqual(sp.fine![0]);
    expect(sp.tangents).toBeUndefined();

    // A point with its own tangent: the solved curve carries the tangents.
    const own = solver.solve({
      entities: [
        { id: "a", type: "point", x: 0, y: 0 },
        { id: "b", type: "point", x: 20, y: 0 },
        { id: "sp", type: "spline", points: ["a", "b"], tangents: [[0, 10], null] },
      ],
      constraints: [],
    });
    const bent = own.curves.find((c) => c.id === "sp")!;
    expect(bent.kind === "spline" && bent.tangents).toEqual([[0, 10], null]);
  });
});

describe("splineDisplayPoints on a point given twice", () => {
  it("adds nothing where two samples coincide (no direction to bend from)", () => {
    const through: Vec2[] = [
      [0, 0],
      [0, 0],
      [10, 10],
    ];
    const fine = splineDisplayPoints(through);

    expect(fine[0]).toEqual([0, 0]);
    expect(fine[fine.length - 1]).toEqual([10, 10]);
    expect(fine.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))).toBe(true);

    // A closed spline of one spot twice: no direction anywhere, only the samples.
    const spot = splineDisplayPoints(
      [
        [1, 1],
        [1, 1],
      ],
      true,
    );
    expect(spot.every((p) => p[0] === 1 && p[1] === 1)).toBe(true);
  });
});
