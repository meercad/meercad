/** Plane geometry of the sketch editor, checked with hand-computed values. */
import { describe, expect, it } from "vitest";
import type { SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { SolvedCurve, SolvedSketch, Vec2 } from "@meercad/sketch";
import {
  applySolution,
  arcMidFor,
  arcThrough,
  connectedCurves,
  curveDistance,
  curvePointIds,
  curveSamples,
  dimensionGeometry,
  fmt,
  joinedChain,
  nearestLineEnd,
  nearestOnPolyline,
  normalizeAngle,
  parseSel,
  planeEdges,
  pointEntries,
  projectOnCurve,
  refsOf,
  refsOfEntity,
  round,
  sweepOf,
} from "./geometry";

const close = (actual: Vec2 | null | undefined, expected: Vec2, digits = 9) => {
  expect(actual).not.toBeNull();
  expect(actual![0]).toBeCloseTo(expected[0], digits);
  expect(actual![1]).toBeCloseTo(expected[1], digits);
};

const sketch = (entities: SketchEntity[]): SketchFeature => ({
  id: "sk",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities,
  constraints: [],
});

const line = (id: string, a: Vec2, b: Vec2, external = false): SolvedCurve => ({
  id,
  kind: "line",
  a,
  b,
  p1: `${id}a`,
  p2: `${id}b`,
  construction: false,
  external,
});

const circle = (id: string, center: Vec2, radius: number, external = false): SolvedCurve => ({
  id,
  kind: "circle",
  center,
  radius,
  c: `${id}c`,
  construction: false,
  external,
});

const arc = (
  id: string,
  center: Vec2,
  radius: number,
  a0: number,
  a1: number,
  external = false,
): SolvedCurve => ({
  id,
  kind: "arc",
  center,
  radius,
  a0,
  a1,
  c: `${id}c`,
  start: `${id}s`,
  end: `${id}e`,
  construction: false,
  external,
});

const spline = (pts: Vec2[]): SolvedCurve => ({
  id: "sp",
  kind: "spline",
  pts,
  through: pts,
  points: [],
  closed: false,
  construction: false,
  external: false,
});

const solved = (points: [string, Vec2][], curves: SolvedCurve[] = []): SolvedSketch => ({
  points: new Map(points),
  curves,
  diagnostics: {} as SolvedSketch["diagnostics"],
});

describe("angles", () => {
  it("sweepOf runs counter-clockwise and gives a full turn for equal angles", () => {
    expect(sweepOf(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(sweepOf(Math.PI / 2, 0)).toBeCloseTo((3 * Math.PI) / 2);
    expect(sweepOf(1, 1)).toBe(2 * Math.PI);
  });

  it("normalizeAngle folds into (-π, π]", () => {
    expect(normalizeAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(normalizeAngle(-Math.PI / 2 - 2 * Math.PI)).toBeCloseTo(-Math.PI / 2);
  });
});

describe("arcThrough", () => {
  it("finds the circle through three points, start→end counter-clockwise through the middle", () => {
    const result = arcThrough([1, 0], [-1, 0], [0, 1])!;

    close(result.center, [0, 0]);
    expect(result.radius).toBeCloseTo(1);
    expect(result.swapped).toBe(false);
    expect(result.start).toEqual([1, 0]);
    expect(result.sweep).toBeCloseTo(Math.PI);
  });

  it("swaps the ends when the middle point lies on the clockwise side", () => {
    const result = arcThrough([1, 0], [-1, 0], [0, -1])!;

    expect(result.swapped).toBe(true);
    expect(result.start).toEqual([-1, 0]);
    expect(result.end).toEqual([1, 0]);
    expect(result.sweep).toBeCloseTo(Math.PI);
  });

  it("gives null for three points on a line", () => {
    expect(arcThrough([0, 0], [2, 0], [1, 0])).toBeNull();
  });
});

describe("arcMidFor", () => {
  it("takes the shorter arc for a radius alone, bulging to the side given", () => {
    close(arcMidFor([-1, 0], [1, 0], [0, 5], 1, null), [0, 1]);
    close(arcMidFor([-1, 0], [1, 0], [0, -5], 1, null), [0, -1]);
  });

  it("derives the radius from a sweep angle", () => {
    // 90° over a chord of 2: radius √2, the middle stands √2 − 1 off the chord.
    close(arcMidFor([-1, 0], [1, 0], [0, 1], null, 90), [0, Math.SQRT2 - 1]);
  });

  it("goes past half a circle when the angle says so", () => {
    close(arcMidFor([-1, 0], [1, 0], [0, 1], null, 270), [0, Math.SQRT2 + 1]);
  });

  it("uses both radius and angle as given", () => {
    close(arcMidFor([-1, 0], [1, 0], [0, 1], 2, 60), [0, 2 - 2 * Math.cos(Math.PI / 6)]);
  });

  it("gives null when no arc fits", () => {
    expect(arcMidFor([0, 0], [0, 0], [0, 1], 1, null)).toBeNull();
    expect(arcMidFor([-1, 0], [1, 0], [0, 1], null, 0)).toBeNull();
    expect(arcMidFor([-1, 0], [1, 0], [0, 1], null, 360)).toBeNull();
    expect(arcMidFor([-1, 0], [1, 0], [0, 1], null, null)).toBeNull();
    expect(arcMidFor([-1, 0], [1, 0], [0, 1], 0.5, null)).toBeNull();
  });
});

describe("numbers and selections", () => {
  it("rounds to thousandths and formats without trailing zeros", () => {
    expect(round(1.23456)).toBe(1.235);
    expect(fmt(12.5)).toBe("12.5");
    expect(fmt(3)).toBe("3");
    expect(fmt(123.45)).toBe("123.5");
    expect(fmt(100)).toBe("100");
  });

  it("parseSel keeps colons inside the id", () => {
    expect(parseSel("point:p1")).toEqual({ kind: "point", id: "p1" });
    expect(parseSel("curve:ext:e1")).toEqual({ kind: "curve", id: "ext:e1" });
  });
});

describe("solution and point lists", () => {
  const entities: SketchEntity[] = [
    { id: "p1", type: "point", x: 0, y: 0 },
    { id: "p2", type: "point", x: 0, y: 0 },
    { id: "c1", type: "circle", center: "p1", radius: 1 },
    { id: "c2", type: "circle", center: "p1", radius: 1 },
    { id: "l1", type: "line", p1: "p1", p2: "p2" },
  ];

  it("applySolution writes solved positions and radii, rounded, and leaves the rest", () => {
    const result = applySolution(
      entities,
      solved([["p1", [1.00049, 2]]], [circle("c1", [0, 0], 2.71828), line("c2", [0, 0], [1, 0])]),
    );

    expect(result[0]).toMatchObject({ x: 1, y: 2 });
    expect(result[1]).toBe(entities[1]);
    expect(result[2]).toMatchObject({ radius: 2.718 });
    expect(result[3]).toBe(entities[3]);
    expect(result[4]).toBe(entities[4]);
  });

  it("pointEntries lists the origin, solved sketch points and the ends of model edges", () => {
    const result = pointEntries(
      sketch(entities),
      solved(
        [
          ["p1", [1, 1]],
          ["e1.p1", [0, 0]],
          ["e1.p2", [5, 0]],
          ["e2.center", [2, 2]],
          ["e2.start", [3, 2]],
          ["e3.center", [7, 7]],
        ],
        [
          line("own", [0, 0], [1, 1]),
          line("e1", [0, 0], [5, 0], true),
          arc("e2", [2, 2], 1, 0, 1, true),
          circle("e3", [7, 7], 1, true),
        ],
      ),
    );

    expect(result).toEqual([
      ["origin", [0, 0]],
      ["p1", [1, 1]],
      ["e1.p1", [0, 0]],
      ["e1.p2", [5, 0]],
      ["e2.center", [2, 2]],
      ["e2.start", [3, 2]],
      ["e3.center", [7, 7]],
    ]);
  });

  it("pointEntries without a sketch has the origin only", () => {
    expect(pointEntries(undefined, solved([]))).toEqual([["origin", [0, 0]]]);
  });
});

describe("curve topology", () => {
  const entities: SketchEntity[] = [
    { id: "l1", type: "line", p1: "a", p2: "b" },
    { id: "a1", type: "arc", center: "c", start: "b", end: "d" },
    { id: "l2", type: "line", p1: "d", p2: "e", construction: true },
    { id: "l3", type: "line", p1: "x", p2: "y" },
    { id: "c1", type: "circle", center: "c", radius: 1 },
    { id: "a2", type: "arc", center: "c", start: "q", end: "r" },
    { id: "s1", type: "spline", points: ["a", "x"] },
    { id: "pt", type: "point", x: 0, y: 0 },
  ];
  const sk = sketch(entities);

  it("curvePointIds names a curve's defining points", () => {
    expect(curvePointIds(sk, "l1")).toEqual(["a", "b"]);
    expect(curvePointIds(sk, "c1")).toEqual(["c"]);
    expect(curvePointIds(sk, "a1")).toEqual(["c", "b", "d"]);
    expect(curvePointIds(sk, "s1")).toEqual([]);
    expect(curvePointIds(sk, "nope")).toEqual([]);
  });

  it("refsOfEntity and refsOf name the points an entity or constraint uses", () => {
    expect(entities.map(refsOfEntity)).toEqual([
      ["a", "b"],
      ["c", "b", "d"],
      ["d", "e"],
      ["x", "y"],
      ["c"],
      ["c", "q", "r"],
      ["a", "x"],
      [],
    ]);
    expect(refsOf({ id: "k", type: "distance", a: "p1", b: "e1.p2", value: 3 } as SketchConstraint)).toEqual([
      "p1",
      "e1",
    ]);
  });

  it("connectedCurves follows shared ends, construction included, but not shared centres", () => {
    expect(connectedCurves(sk, "l1").sort()).toEqual(["a1", "l1", "l2"]);
    expect(connectedCurves(sk, "c1")).toEqual(["c1"]);
  });

  it("joinedChain leaves construction geometry out", () => {
    expect(joinedChain(sk, "l1").sort()).toEqual(["a1", "l1"]);
    expect(joinedChain(sk, "l3")).toEqual(["l3"]);
  });

  it("nearestLineEnd finds the closest end of a drawn line within reach", () => {
    const points = new Map<string, Vec2>([
      ["a", [0, 0]],
      ["b", [10, 0]],
      ["d", [10.5, 0]],
      ["x", [20, 0]],
    ]);

    expect(nearestLineEnd(sk, points, [9.8, 0], 1)).toBe("b");
    // d is only on a construction line; y has no position.
    expect(nearestLineEnd(sk, points, [10.6, 0], 0.5)).toBeNull();
    expect(nearestLineEnd(sk, points, [50, 0], 1)).toBeNull();
  });
});

describe("distances and projections", () => {
  it("curveSamples follows lines, splines, circles and arcs", () => {
    expect(curveSamples(line("l", [0, 0], [1, 0]))).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(
      curveSamples(
        spline([
          [0, 0],
          [1, 1],
          [2, 0],
        ]),
      ),
    ).toHaveLength(3);

    const full = curveSamples(circle("c", [0, 0], 2));

    expect(full).toHaveLength(17);
    close(full[4], [0, 2]);
    close(full[16], [2, 0]);

    const quarter = curveSamples(arc("a", [0, 0], 1, 0, Math.PI / 2));

    close(quarter[16], [0, 1]);
    // Start and end at the same angle: a full turn.
    close(curveSamples(arc("a", [0, 0], 1, 1, 1))[8], [Math.cos(1 + Math.PI), Math.sin(1 + Math.PI)]);
  });

  it("curveDistance measures to segments, infinite lines, circles and arcs", () => {
    const l = line("l", [0, 0], [10, 0]);

    expect(curveDistance(l, [5, 3])).toBeCloseTo(3);
    expect(curveDistance(l, [13, 4])).toBeCloseTo(5);
    expect(curveDistance(l, [13, 4], true)).toBeCloseTo(4);
    // A line of no length counts as its point.
    expect(curveDistance(line("z", [1, 1], [1, 1]), [4, 5])).toBeCloseTo(5);

    expect(curveDistance(circle("c", [0, 0], 2), [5, 0])).toBeCloseTo(3);
    expect(curveDistance(circle("c", [0, 0], 2), [1, 0])).toBeCloseTo(1);

    const upper = arc("a", [0, 0], 1, 0, Math.PI);

    expect(curveDistance(upper, [0, 3])).toBeCloseTo(2);
    // Below the upper half: the nearer end.
    expect(curveDistance(upper, [1, -1])).toBeCloseTo(1);
    expect(curveDistance(upper, [-2, -0.5])).toBeCloseTo(Math.hypot(1, 0.5));
    // Start and end at the same angle: a full circle.
    expect(curveDistance(arc("f", [0, 0], 1, 2, 2), [0, -3])).toBeCloseTo(2);

    const zigzag = spline([
      [0, 0],
      [2, 0],
      [2, 2],
    ]);

    expect(curveDistance(zigzag, [3, 1])).toBeCloseTo(1);
    expect(
      curveDistance(
        spline([
          [1, 1],
          [1, 1],
        ]),
        [1, 3],
      ),
    ).toBeCloseTo(2);
  });

  it("projectOnCurve finds the nearest point on lines, splines and round curves", () => {
    close(projectOnCurve(line("l", [0, 0], [10, 0]), [4, 7]), [4, 0]);
    close(projectOnCurve(line("l", [0, 0], [10, 0]), [-3, 1]), [0, 0]);
    close(projectOnCurve(line("z", [2, 2], [2, 2]), [5, 5]), [2, 2]);
    close(projectOnCurve(circle("c", [1, 1], 2), [1, 5]), [1, 3]);
    close(projectOnCurve(arc("a", [0, 0], 1, 0, 1), [3, 0]), [1, 0]);

    const zigzag = spline([
      [0, 0],
      [2, 0],
      [2, 2],
    ]);

    close(projectOnCurve(zigzag, [3, 1.5]), [2, 1.5]);
    close(projectOnCurve(zigzag, [1, -1]), [1, 0]);
    close(projectOnCurve(spline([[4, 4]]), [0, 0]), [4, 4]);
  });

  it("nearestOnPolyline gives the closest point and its distance", () => {
    const result = nearestOnPolyline(
      [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
      [5, 2],
    );

    close(result.pos, [4, 2]);
    expect(result.dist).toBeCloseTo(1);
    expect(
      nearestOnPolyline(
        [
          [0, 0],
          [4, 0],
          [4, 4],
        ],
        [1, -1],
      ),
    ).toEqual({ pos: [1, 0], dist: 1 });
    expect(nearestOnPolyline([[1, 1]], [0, 0])).toEqual({ pos: [1, 1], dist: Infinity });
    expect(
      nearestOnPolyline(
        [
          [1, 1],
          [1, 1],
        ],
        [1, 2],
      ).dist,
    ).toBeCloseTo(1);
  });
});

describe("planeEdges", () => {
  const frame = { origin: [0, 0, 5], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };

  const mesh = (polylines: number[][][]) => {
    const coords: number[] = [];
    const ranges: number[] = [];

    for (const polyline of polylines) {
      ranges.push(coords.length / 3, polyline.length, 0);
      coords.push(...polyline.flat());
    }

    return { edgeLines: new Float32Array(coords), edgeRanges: new Int32Array(ranges) };
  };

  const ring = (n: number, radius: number, z: number) =>
    Array.from({ length: n }, (_, i) => [
      3 + radius * Math.cos((2 * Math.PI * i) / n),
      4 + radius * Math.sin((2 * Math.PI * i) / n),
      z,
    ]);

  it("keeps edges in the plane, in sketch coordinates, with the centre of round ones", () => {
    const edges = planeEdges(
      [
        mesh([
          [
            [0, 0, 5],
            [10, 0, 5],
          ],
          [
            [0, 0, 5],
            [0, 0, 9],
          ],
          [[1, 1, 5]],
          ring(12, 2, 5),
        ]),
      ],
      frame,
      1e-3,
    );

    expect(edges).toHaveLength(2);
    expect(edges[0]).toEqual({
      pts: [
        [0, 0],
        [10, 0],
      ],
    });
    close(edges[1]!.center, [3, 4], 4);
  });

  it("finds no centre for straight or uneven polylines", () => {
    const straight = Array.from({ length: 6 }, (_, i) => [i, 0, 5]);
    const bent = [
      [0, 0, 5],
      [1, 0, 5],
      [2, 0, 5],
      [3, 1, 5],
      [3, 3, 5],
      [9, 9, 5],
    ];
    const edges = planeEdges([mesh([straight, bent])], frame, 1e-3);

    expect(edges.map((edge) => edge.center)).toEqual([undefined, undefined]);
  });
});

describe("dimensionGeometry", () => {
  const sk = solved(
    [
      ["a", [0, 0]],
      ["b", [4, 0]],
      ["c", [4, 3]],
    ],
    [
      line("l1", [0, 0], [4, 0]),
      line("l2", [0, 2], [4, 2]),
      circle("c1", [0, 0], 2),
      arc("a1", [0, 0], 1, 0, Math.PI / 2),
    ],
  );
  const dim = (constraint: object) =>
    dimensionGeometry({ id: "k", value: 1, ...constraint } as SketchConstraint, sk);

  it("needs a label and a value", () => {
    expect(dimensionGeometry({ id: "k", type: "length", line: "l1", value: 1 }, sk)).toBeNull();
    expect(dimensionGeometry({ id: "k", type: "horizontal", line: "l1" } as SketchConstraint, sk)).toBeNull();
  });

  it("draws a length as two witness lines and the offset dimension line", () => {
    expect(dim({ type: "length", line: "l1", label: [2, -1] })).toEqual([
      [0, 0],
      [0, -1],
      [4, 0],
      [4, -1],
      [0, -1],
      [4, -1],
    ]);
    expect(dim({ type: "length", line: "c1", label: [0, 0] })).toBeNull();
  });

  it("draws a distance between points, to a line, along an axis", () => {
    expect(dim({ type: "distance", a: "a", b: "c", axis: "x", label: [0, 5] })).toEqual([
      [0, 0],
      [0, 5],
      [4, 3],
      [4, 5],
      [0, 5],
      [4, 5],
    ]);
    expect(dim({ type: "distance", a: "a", b: "c", axis: "y", label: [6, 0] })).toEqual([
      [0, 0],
      [6, 0],
      [4, 3],
      [6, 3],
      [6, 0],
      [6, 3],
    ]);

    const toLine = dim({ type: "distance", a: "a", b: "l2", label: [1, 1] })!;

    close(toLine[1], [1, 0]);
    close(toLine[3], [1, 2]);
    expect(dim({ type: "distance", a: "a", b: "c1", label: [1, 1] })).toBeNull();
    expect(dim({ type: "distance", a: "nope", b: "l2", label: [1, 1] })).toBeNull();

    // Two equal points: the dimension line still has a direction.
    expect(dim({ type: "distance", a: "a", b: "a", label: [0, 0] })).toHaveLength(6);
  });

  it("draws radius, diameter and arc angle from the centre", () => {
    expect(dim({ type: "radius", curve: "c1", label: [4, 0] })).toEqual([
      [0, 0],
      [4, 0],
      [2, 0],
      [4, 0],
    ]);

    const diameter = dim({ type: "diameter", curve: "c1", label: [0, 4] })!;

    close(diameter[0], [0, -2]);
    expect(diameter[1]).toEqual([0, 4]);
    expect(dim({ type: "radius", curve: "l1", label: [0, 0] })).toBeNull();
    expect(dim({ type: "radius", curve: "nope", label: [0, 0] })).toBeNull();

    const angle = dim({ type: "arc_angle", curve: "a1", label: [1, 1] })!;

    close(angle[1], [1, 0]);
    close(angle[3], [0, 1]);
    expect(dim({ type: "arc_angle", curve: "c1", label: [0, 0] })).toBeNull();
  });

  it("draws nothing for other dimensions", () => {
    expect(dim({ type: "angle", a: "l1", b: "l2", label: [0, 0] })).toBeNull();
  });
});
