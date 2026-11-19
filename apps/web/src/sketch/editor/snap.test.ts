/** Hit testing and where a new point lands, at one sketch unit per pixel. */
import { describe, expect, it } from "vitest";
import type { SketchFeature } from "@meercad/schema";
import type { SolvedCurve, SolvedSketch, Vec2 } from "@meercad/sketch";
import { hitCurve, hitPoint, snapPoint, snapTargetsOf, type SnapScene } from "./snap";

const line = (id: string, a: Vec2, b: Vec2): SolvedCurve => ({
  id,
  kind: "line",
  a,
  b,
  p1: `${id}.p1`,
  p2: `${id}.p2`,
  construction: false,
  external: false,
});
const sketch: SketchFeature = {
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities: [
    { id: "pa", type: "point", x: 50, y: 50 },
    { id: "pb", type: "point", x: 100, y: 50 },
    { id: "p0", type: "point", x: 0, y: 0 },
  ],
  constraints: [],
};
const curves = [
  line("l1", [50, 50], [100, 50]),
  line("l2", [75, 20], [75, 80]),
  { id: "c1", kind: "circle", center: [200, 200], radius: 20, c: "pc", construction: false, external: false },
] as SolvedCurve[];
const shown: SolvedSketch = {
  points: new Map<string, Vec2>([
    ["pa", [50, 50]],
    ["pb", [100, 50]],
    ["p0", [0, 0]],
  ]),
  curves,
  diagnostics: {} as SolvedSketch["diagnostics"],
};
const scene = (more: Partial<SnapScene> = {}): SnapScene => ({
  sketch,
  shown,
  unit: 1,
  snapGrid: false,
  snapGeometry: true,
  targets: snapTargetsOf(curves),
  modelEdges: [],
  sections: [],
  gridStep: () => 10,
  ...more,
});

describe("hit testing", () => {
  it("finds the nearest point within reach; a sketch point on the origin wins over it", () => {
    expect(hitPoint(sketch, shown, [52, 51], 5)).toBe("pa");
    expect(hitPoint(sketch, shown, [52, 51], 5, new Set(["pa"]))).toBeNull();
    expect(hitPoint(sketch, shown, [0.5, 0], 5)).toBe("p0");
    expect(hitPoint(sketch, null, [0, 0], 5)).toBeNull();
  });

  it("finds the nearest curve within reach", () => {
    expect(hitCurve(shown, [76, 30], 5)!.id).toBe("l2");
    expect(hitCurve(shown, [76, 30], 5, new Set(["l2"]))).toBeNull();
    expect(hitCurve(shown, [60, 52], 5)!.id).toBe("l1");
    expect(hitCurve(null, [0, 0], 5)).toBeNull();
  });

  it("works out midpoints and crossings once", () => {
    const targets = snapTargetsOf(curves);

    expect(targets.mids).toEqual([
      { id: "l1", pt: [75, 50] },
      { id: "l2", pt: [75, 50] },
    ]);
    expect(targets.crosses).toEqual([{ pt: [75, 50], a: "l1", b: "l2" }]);
  });
});

describe("snapPoint", () => {
  it("lands on points first, then midpoints, crossings and curves", () => {
    expect(snapPoint(scene(), [51, 51])).toEqual({ pos: [50, 50], point: "pa", kind: "point" });
    expect(snapPoint(scene(), [76, 51])).toMatchObject({ pos: [75, 50], kind: "mid" });
    expect(snapPoint(scene(), [76, 51], new Set(["l1", "l2"])).kind).not.toBe("mid");
    expect(snapPoint(scene({ targets: { ...snapTargetsOf(curves), mids: [] } }), [76, 51])).toMatchObject({
      kind: "cross",
      curve: "l1",
      curve2: "l2",
    });
    expect(snapPoint(scene(), [221, 200])).toMatchObject({ pos: [220, 200], curve: "c1", kind: "curve" });
  });

  it("takes the nearer of two midpoints or crossings", () => {
    const two = {
      mids: [
        { id: "a", pt: [30, 30] as Vec2 },
        { id: "b", pt: [33, 30] as Vec2 },
      ],
      crosses: [],
    };

    expect(snapPoint(scene({ targets: two }), [32, 30]).mid).toBe("b");

    const crosses = {
      mids: [],
      crosses: [
        { pt: [30, 30] as Vec2, a: "a", b: "b" },
        { pt: [33, 30] as Vec2, a: "c", b: "d" },
      ],
    };

    expect(snapPoint(scene({ targets: crosses }), [32, 30]).curve).toBe("c");
    expect(snapPoint(scene({ targets: crosses }), [32, 30], new Set(["d"])).curve).toBe("a");
  });

  it("lands on the model's corners, circle centres, edges and mesh sections", () => {
    const modelEdges = [
      {
        pts: [
          [300, 300],
          [400, 300],
        ] as Vec2[],
      },
      {
        pts: [
          [304, 302],
          [304, 400],
        ] as Vec2[],
      },
      { pts: [[500, 520] as Vec2, [520, 500] as Vec2], center: [500, 500] as Vec2 },
      { pts: [[503, 503] as Vec2, [510, 510] as Vec2], center: [502, 501] as Vec2 },
    ];
    const at = (p: Vec2, more: Partial<SnapScene> = {}) => snapPoint(scene({ modelEdges, ...more }), p);

    expect(at([301, 301])).toEqual({ pos: [300, 300], kind: "point" });
    expect(at([304, 303])).toEqual({ pos: [304, 302], kind: "point" });
    expect(at([501, 500])).toEqual({ pos: [500, 500], kind: "center" });
    expect(at([503, 502])).toEqual({ pos: [502, 501], kind: "center" });
    expect(at([350, 303])).toEqual({ pos: [350, 300], kind: "edge" });
    expect(at([304.5, 350])).toEqual({ pos: [304, 350], kind: "edge" });

    // Two edges within reach: the nearer one.
    const parallel = [
      {
        pts: [
          [200, 300],
          [400, 300],
        ] as Vec2[],
      },
      {
        pts: [
          [200, 305],
          [400, 305],
        ] as Vec2[],
      },
    ];

    expect(snapPoint(scene({ modelEdges: parallel }), [350, 303])).toEqual({ pos: [350, 305], kind: "edge" });

    const sections = [
      {
        points: [
          [600, 600],
          [700, 600],
          [700, 700],
        ] as Vec2[],
        closed: true,
      },
      {
        points: [
          [800, 800],
          [900, 800],
        ] as Vec2[],
        closed: false,
      },
      {
        points: [
          [650, 603],
          [690, 603],
        ] as Vec2[],
        closed: false,
      },
    ];

    expect(at([650, 652], { sections })).toEqual({ pos: [651, 651], kind: "edge" });
    expect(at([850, 803], { sections })).toEqual({ pos: [850, 800], kind: "edge" });
    expect(at([650, 602], { sections })).toEqual({ pos: [650, 603], kind: "edge" });
  });

  it("snaps to the origin axes, on the grid when it is on", () => {
    expect(snapPoint(scene(), [33, 2])).toEqual({ pos: [33, 0], curve: "origin.x", kind: "curve" });
    expect(snapPoint(scene({ snapGrid: true }), [33, 2])).toEqual({
      pos: [30, 0],
      curve: "origin.x",
      kind: "grid",
    });
    expect(snapPoint(scene({ snapGrid: true }), [-3, 37])).toEqual({
      pos: [0, 40],
      curve: "origin.y",
      kind: "grid",
    });
  });

  it("lines up with other points, the one drawn from and model corners, else the grid", () => {
    expect(snapPoint(scene(), [52, 133])).toEqual({
      pos: [50, 133],
      kind: "align",
      guides: [
        [
          [50, 50],
          [50, 133],
        ],
      ],
    });
    expect(snapPoint(scene(), [133, 52], undefined, [130, 10])).toEqual({
      pos: [130, 50],
      kind: "align",
      guides: [
        [
          [130, 10],
          [130, 50],
        ],
        // pa and pb are level: the first one found stays.
        [
          [50, 50],
          [130, 50],
        ],
      ],
    });
    expect(
      snapPoint(scene({ modelEdges: [{ pts: [[140, 400] as Vec2, [180, 400] as Vec2] }] }), [178, 133]).pos,
    ).toEqual([180, 133]);
    expect(
      snapPoint(scene({ modelEdges: [{ pts: [[1, 1] as Vec2], center: [160, 400] as Vec2 }] }), [162, 133])
        .pos,
    ).toEqual([160, 133]);
    // Two points within reach along x: the nearer one.
    expect(
      snapPoint(scene({ modelEdges: [{ pts: [[52, 400] as Vec2, [52, 500] as Vec2] }] }), [51.5, 133]).pos,
    ).toEqual([52, 133]);
    expect(snapPoint(scene({ snapGrid: true }), [133, 137])).toEqual({ pos: [130, 140], kind: "grid" });
    expect(snapPoint(scene(), [133, 137])).toEqual({ pos: [133, 137] });
  });

  it("skips geometry and alignments with smart snaps off", () => {
    expect(snapPoint(scene({ snapGeometry: false }), [76, 51])).toEqual({ pos: [76, 51] });
    expect(snapPoint(scene({ snapGeometry: false }), [52, 133])).toEqual({ pos: [52, 133] });
  });
});
