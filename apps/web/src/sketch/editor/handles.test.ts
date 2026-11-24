/** Tangent handles of splines (handles.ts): which splines show them, where knobs sit, hits, tangents. */
import { describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { splineArms, type SolvedCurve, type SolvedSketch, type Vec2 } from "@meercad/sketch";
import { activeSplines, hitHandle, MIN_ARM_PIXELS, splineHandles, tangentFor, withTangent } from "./handles";

const through: Vec2[] = [
  [0, 0],
  [20, 20],
  [40, 0],
];
const pointIds = ["s1", "s2", "s3"];
const points: SketchEntity[] = through.map((p, i) => ({ id: pointIds[i]!, type: "point", x: p[0], y: p[1] }));

function spline(extra: Partial<Extract<SketchEntity, { type: "spline" }>> = {}): SketchEntity {
  return { id: "sp", type: "spline", points: pointIds, ...extra } as SketchEntity;
}

function solved(
  closed = false,
  tangents?: (Vec2 | null)[],
  at: Vec2[] = through,
): Extract<SolvedCurve, { kind: "spline" }> {
  return {
    id: "sp",
    kind: "spline",
    pts: at,
    through: at,
    ...(tangents ? { tangents } : {}),
    points: pointIds,
    closed,
    construction: false,
    external: false,
  };
}

function sketchOf(
  entities: SketchEntity[],
  curves: SolvedCurve[],
  constraints: SketchFeature["constraints"] = [],
): [SketchFeature, SolvedSketch] {
  return [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities, constraints },
    { points: new Map(), curves, diagnostics: { dof: 0, conflicting: [] } } as unknown as SolvedSketch,
  ];
}

describe("activeSplines", () => {
  it("lists splines that are selected or have a selected point; nothing without a sketch", () => {
    const [sk] = sketchOf([...points, spline(), { id: "l1", type: "line", p1: "s1", p2: "s3" }], []);

    expect(activeSplines(undefined, [{ kind: "curve", id: "sp" }])).toEqual([]);
    expect(activeSplines(sk, [])).toEqual([]);
    expect(activeSplines(sk, [{ kind: "curve", id: "sp" }])).toEqual(["sp"]);
    expect(activeSplines(sk, [{ kind: "point", id: "s2" }])).toEqual(["sp"]);
    expect(activeSplines(sk, [{ kind: "curve", id: "l1" }])).toEqual([]);
  });
});

describe("splineHandles", () => {
  it("open spline: the ends have only the arm into the curve, the middle both", () => {
    const [sk, shown] = sketchOf([...points, spline()], [solved()]);
    const hs = splineHandles(sk, shown, ["sp"], 0.001);

    expect(hs.map((h) => [h.index, h.side])).toEqual([
      [0, "ahead"],
      [1, "back"],
      [1, "ahead"],
      [2, "back"],
    ]);

    // Long arms: the knob is at the arm's end.
    const arms = splineArms(through);
    const mid = hs.find((h) => h.index === 1 && h.side === "ahead")!;
    expect(mid.knob[0]).toBeCloseTo(20 + arms[1]!.ahead[0], 9);
    expect(mid.knob[1]).toBeCloseTo(20 + arms[1]!.ahead[1], 9);
    expect(mid.own).toBe(false);
  });

  it("short arms are drawn at least MIN_ARM_PIXELS long", () => {
    const [sk, shown] = sketchOf([...points, spline()], [solved()]);
    const px = 1; // one pixel is a millimetre: every arm here is shorter than the minimum
    const h = splineHandles(sk, shown, ["sp"], px)[0]!;

    expect(Math.hypot(h.knob[0] - h.at[0], h.knob[1] - h.at[1])).toBeCloseTo(MIN_ARM_PIXELS * px, 9);
  });

  it("closed spline: every point has both knobs; an own tangent is marked", () => {
    const [sk, shown] = sketchOf([...points, spline({ closed: true })], [solved(true, [null, [5, 0], null])]);
    const hs = splineHandles(sk, shown, ["sp"], 0.001);

    expect(hs).toHaveLength(6);
    expect(hs.filter((h) => h.own).map((h) => h.index)).toEqual([1, 1]);
    expect(hs.find((h) => h.index === 1 && h.side === "ahead")!.knob).toEqual([25, 20]);
  });

  it("an end tangent to another curve has no knob; zero-length arms and unknown ids none either", () => {
    const line: SketchEntity = { id: "l1", type: "line", p1: "s3", p2: "q" };
    const [sk, shown] = sketchOf(
      [...points, { id: "q", type: "point", x: 60, y: 0 }, line, spline()],
      [solved()],
      [{ id: "c1", type: "tangent", a: "sp", b: "l1" }],
    );
    const hs = splineHandles(sk, shown, ["sp", "nothing", "l1"], 0.001);

    expect(hs.some((h) => h.index === 2)).toBe(false);
    expect(hs.length).toBe(3);

    // All points on one spot: no arm has a length.
    const same: Vec2[] = [
      [1, 1],
      [1, 1],
    ];
    const [sk2, shown2] = sketchOf([...points, spline()], [solved(false, undefined, same)]);
    expect(splineHandles(sk2, shown2, ["sp"], 0.001)).toEqual([]);
    expect(splineHandles(undefined, shown2, ["sp"], 0.001)).toEqual([]);
  });
});

describe("hitHandle", () => {
  const [sk, shown] = sketchOf([...points, spline()], [solved()]);
  const hs = splineHandles(sk, shown, ["sp"], 0.001);
  const k = hs[1]!.knob;

  it("finds the nearest knob within the tolerance", () => {
    expect(hitHandle(hs, [k[0] + 0.1, k[1]], 1)).toBe(hs[1]);
    expect(hitHandle(hs, [k[0] + 5, k[1]], 1)).toBeNull();
  });

  it("leaves a nearer sketch point to be dragged", () => {
    expect(hitHandle(hs, [k[0] + 0.5, k[1]], 1, 0.2)).toBeNull();
    expect(hitHandle(hs, [k[0] + 0.1, k[1]], 1, 0.5)).toBe(hs[1]);
  });
});

describe("tangentFor", () => {
  it("is the forward arm; a backward knob mirrors; none on the point itself", () => {
    expect(tangentFor({ at: [1, 1], side: "ahead" }, [4, 5])).toEqual([3, 4]);
    expect(tangentFor({ at: [1, 1], side: "back" }, [4, 5])).toEqual([-3, -4]);
    expect(tangentFor({ at: [1, 1], side: "ahead" }, [1, 1])).toBeNull();
    // Stored to a millionth.
    expect(tangentFor({ at: [0, 0], side: "ahead" }, [1 / 3, 0])).toEqual([0.333333, 0]);
  });
});

describe("withTangent", () => {
  it("sets a point's tangent and drops the field once no point has one", () => {
    const entities = [...points, spline()];
    const set = withTangent(entities, "sp", 1, [2, 0]);
    const sp = set.find((e) => e.id === "sp") as Extract<SketchEntity, { type: "spline" }>;

    expect(sp.tangents).toEqual([null, [2, 0], null]);
    // The other entities are the same objects.
    expect(set[0]).toBe(entities[0]);

    const cleared = withTangent(set, "sp", 1, null).find((e) => e.id === "sp")!;
    expect("tangents" in cleared).toBe(false);
    // Another spline id, or a point with that id, is left alone.
    expect(withTangent(entities, "s1", 0, [1, 0])).toEqual(entities);
  });
});
