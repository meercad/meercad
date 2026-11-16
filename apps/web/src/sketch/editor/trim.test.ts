/** The trim tool on lines, circles, arcs and splines, with hand-placed geometry. */
import { describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { splinePoints, type SolvedCurve, type SolvedSketch, type Vec2 } from "@meercad/sketch";
import { trimDraft } from "./trim";

const points: Record<string, Vec2> = {
  p1: [0, 0],
  p2: [30, 0],
  p3: [10, -5],
  p4: [10, 5],
  p5: [20, -5],
  p6: [20, 5],
  p7: [15, -5],
  p8: [15, 5],
  pc: [0, 100],
  q1: [-20, 100],
  q2: [20, 100],
  free: [99, 99],
  s1: [0, 0],
  s2: [20, 20],
  s3: [40, 0],
};
const point = (id: string): SketchEntity => ({ id, type: "point", x: points[id]![0], y: points[id]![1] });
const line = (id: string, p1: string, p2: string, construction = false): SketchEntity => ({
  id,
  type: "line",
  p1,
  p2,
  ...(construction ? { construction } : {}),
});
type SolvedLine = Extract<SolvedCurve, { kind: "line" }>;
const solvedLine = (id: string, p1: string, p2: string, construction = false): SolvedLine => ({
  id,
  kind: "line",
  a: points[p1]!,
  b: points[p2]!,
  p1,
  p2,
  construction,
  external: false,
});

/** A sketch of the entities, and what the solver shows of it (the curves given). */
function sketchOf(entities: SketchEntity[], curves: SolvedCurve[]): [SketchFeature, SolvedSketch] {
  return [
    {
      id: "sk1",
      op: "sketch",
      plane: { ref: "origin.XY" },
      entities,
      constraints: [
        { id: "k1", type: "length", line: "l1", value: 30 },
        { id: "k2", type: "horizontal", line: "l1" },
      ],
    },
    {
      points: new Map(Object.entries(points)),
      curves,
      diagnostics: {} as SolvedSketch["diagnostics"],
    },
  ];
}

const noPoint = () => null;
const ids = (draft: { entities: SketchEntity[] }) => draft.entities.map((e) => e.id);
const byId = (draft: { entities: SketchEntity[] }, id: string) =>
  draft.entities.find((e) => e.id === id) as never;

describe("trimming lines", () => {
  const [sketch, shown] = sketchOf(
    [
      ...["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "free"].map(point),
      line("l1", "p1", "p2"),
      line("l2", "p3", "p4"),
      line("l3", "p5", "p6"),
      line("l4", "p7", "p8", true),
    ],
    [
      solvedLine("l1", "p1", "p2"),
      solvedLine("l2", "p3", "p4"),
      solvedLine("l3", "p5", "p6"),
      solvedLine("l4", "p7", "p8", true),
    ],
  );
  const target = shown.curves[0]!;

  it("splits a line between two crossings, construction lines left out", () => {
    const draft = trimDraft(sketch, shown, target, [15, 0], noPoint)!;

    expect(byId(draft, "l1")).toMatchObject({ p1: "p1", p2: "p9" });
    expect(byId(draft, "l5")).toMatchObject({ type: "line", p1: "p10", p2: "p2" });
    expect(byId(draft, "p9")).toMatchObject({ x: 10, y: 0 });
    expect(draft.constraints.map((c) => c.type)).toEqual(["horizontal", "point_on", "point_on"]);
  });

  it("cuts a line back from its start or its end, dropping the end point left over", () => {
    const fromStart = trimDraft(sketch, shown, target, [5, 0], noPoint)!;

    expect(byId(fromStart, "l1")).toMatchObject({ p1: "p9", p2: "p2" });
    expect(ids(fromStart)).not.toContain("p1");
    expect(ids(fromStart)).toContain("free");

    const fromEnd = trimDraft(sketch, shown, target, [25, 0], noPoint)!;

    expect(byId(fromEnd, "l1")).toMatchObject({ p1: "p1", p2: "p9" });
  });

  it("ends a cut on a point already there, never on the origin", () => {
    const at = (pt: Vec2) => (pt[0] === 10 ? "p3" : pt[0] === 20 ? "origin" : null);
    const draft = trimDraft(sketch, shown, target, [15, 0], at)!;

    expect(byId(draft, "l1")).toMatchObject({ p2: "p3" });
    expect(byId(draft, "l5")).toMatchObject({ p1: "p9" });

    // A point id that is not a point entity is not reused.
    expect(
      byId(
        trimDraft(sketch, shown, target, [5, 0], () => "l2")!,
        "l1",
      ),
    ).toMatchObject({ p1: "p9" });
  });

  it("removes a line of no length", () => {
    const [dot, dotShown] = sketchOf([point("p1"), line("l1", "p1", "p1")], [solvedLine("l1", "p1", "p1")]);

    expect(ids(trimDraft(dot, dotShown, dotShown.curves[0]!, [0, 0], noPoint)!)).toEqual([]);
  });

  it("removes a line nothing crosses, and keeps construction on a split", () => {
    const [lone, loneShown] = sketchOf(
      [point("p1"), point("p2"), line("l1", "p1", "p2", true)],
      [solvedLine("l1", "p1", "p2", true)],
    );

    expect(ids(trimDraft(lone, loneShown, loneShown.curves[0]!, [15, 0], noPoint)!)).toEqual([]);

    const [guide, guideShown] = sketchOf(
      [
        ...["p1", "p2", "p3", "p4", "p5", "p6"].map(point),
        line("l1", "p1", "p2", true),
        line("l2", "p3", "p4"),
        line("l3", "p5", "p6"),
      ],
      [solvedLine("l1", "p1", "p2", true), solvedLine("l2", "p3", "p4"), solvedLine("l3", "p5", "p6")],
    );

    expect(byId(trimDraft(guide, guideShown, guideShown.curves[0]!, [15, 0], noPoint)!, "l4")).toMatchObject({
      construction: true,
    });
  });

  it("does nothing for a curve that is not in the sketch", () => {
    expect(trimDraft(sketch, shown, solvedLine("e1", "p1", "p2"), [15, 0], noPoint)).toBeNull();
    expect(
      trimDraft(
        sketch,
        { ...shown, curves: [{ ...solvedLine("l2", "p1", "p2"), id: "free" }] },
        { ...target, id: "free" },
        [15, 0],
        noPoint,
      ),
    ).toBeNull();
  });
});

describe("trimming circles and arcs", () => {
  const circle = (id: string, construction = false): SolvedCurve => ({
    id,
    kind: "circle",
    center: points.pc!,
    radius: 10,
    c: "pc",
    construction,
    external: false,
  });
  const arc = (id: string, a0: number, a1: number, construction = false): SolvedCurve => ({
    id,
    kind: "arc",
    center: points.pc!,
    radius: 10,
    a0,
    a1,
    c: "pc",
    start: "as",
    end: "ae",
    construction,
    external: false,
  });
  /** A vertical line through x, from y = 80 to 120. */
  const cutter = (x: number): SolvedCurve => ({
    ...solvedLine(`v${x}`, "p1", "p2"),
    a: [x, 80],
    b: [x, 120],
  });
  const cutterEntity = (x: number) => line(`v${x}`, "p1", "p2");
  const base = [point("pc"), point("p1"), point("p2")];

  it("keeps a circle cut twice as the arc away from the click", () => {
    const [sketch, shown] = sketchOf(
      [
        ...base,
        { id: "c1", type: "circle", center: "pc", radius: 10, construction: true },
        cutterEntity(-5),
        cutterEntity(5),
      ],
      [circle("c1", true), cutter(-5), cutter(5)],
    );
    const draft = trimDraft(sketch, shown, shown.curves[0]!, [0, 110], noPoint)!;
    const kept = byId(draft, "a1") as { start: string; end: string; construction?: boolean };

    expect(ids(draft)).not.toContain("c1");

    // Each cutter crosses twice; the two upper crossings bound the piece clicked. The arc kept runs
    // counter-clockwise from the left one round the bottom to the right one.
    const top = 100 + Math.sqrt(75);

    expect(byId(draft, kept.start)).toMatchObject({ x: expect.closeTo(-5), y: expect.closeTo(top) });
    expect(byId(draft, kept.end)).toMatchObject({ x: expect.closeTo(5), y: expect.closeTo(top) });
    expect(kept.construction).toBe(true);

    // Clicked past the last crossing: the circle goes on from the first.
    expect(ids(trimDraft(sketch, shown, shown.curves[0]!, [9, 100], noPoint)!)).toContain("a1");

    const [drawn, drawnShown] = sketchOf(
      [...base, { id: "c1", type: "circle", center: "pc", radius: 10 }, cutterEntity(-5), cutterEntity(5)],
      [circle("c1"), cutter(-5), cutter(5)],
    );

    expect(
      byId(trimDraft(drawn, drawnShown, drawnShown.curves[0]!, [0, 110], noPoint)!, "a1"),
    ).not.toHaveProperty("construction");
  });

  it("removes a circle crossed once or not at all", () => {
    const [sketch, shown] = sketchOf(
      [...base, { id: "c1", type: "circle", center: "pc", radius: 10 }, cutterEntity(10)],
      [circle("c1"), cutter(10)],
    );

    expect(ids(trimDraft(sketch, shown, shown.curves[0]!, [0, 110], noPoint)!)).not.toContain("c1");
    expect(
      ids(trimDraft(sketch, { ...shown, curves: [circle("c1")] }, circle("c1"), [0, 110], noPoint)!),
    ).not.toContain("c1");
  });

  it("cuts an arc back from either end, splits it, or removes it", () => {
    const arcEntity = (construction = false): SketchEntity => ({
      id: "a1",
      type: "arc",
      center: "pc",
      start: "as",
      end: "ae",
      ...(construction ? { construction } : {}),
    });
    const upper = arc("a1", 0, Math.PI);
    const one = sketchOf([...base, arcEntity(), cutterEntity(0)], [upper, cutter(0)]);

    // The crossing is at the top (90°): clicked at 45° the start moves there, at 135° the end.
    expect(byId(trimDraft(one[0], one[1], upper, [7, 107], noPoint)!, "a1")).toMatchObject({
      start: "p3",
      end: "ae",
    });
    expect(byId(trimDraft(one[0], one[1], upper, [-7, 107], noPoint)!, "a1")).toMatchObject({
      start: "as",
      end: "p3",
    });

    const two = sketchOf(
      [...base, arcEntity(true), cutterEntity(-5), cutterEntity(5)],
      [arc("a1", 0, Math.PI, true), cutter(-5), cutter(5)],
    );
    const split = trimDraft(two[0], two[1], two[1].curves[0]!, [0, 110], noPoint)!;

    expect(byId(split, "a1")).toMatchObject({ start: "as" });
    expect(byId(split, "a2")).toMatchObject({ type: "arc", end: "ae", construction: true });

    const none = sketchOf([...base, arcEntity()], [upper]);

    expect(ids(trimDraft(none[0], none[1], upper, [0, 110], noPoint)!)).not.toContain("a1");

    // An arc whose ends meet goes all the way round.
    const full = arc("a1", 1, 1);
    const round = sketchOf(
      [...base, arcEntity(), cutterEntity(-5), cutterEntity(5)],
      [full, cutter(-5), cutter(5)],
    );

    expect(ids(trimDraft(round[0], round[1], full, [0, 90], noPoint)!)).toContain("a2");
  });

  it("does nothing when the sketch holds another kind of curve under that id", () => {
    const [sketch, shown] = sketchOf([...base, line("c1", "p1", "p2")], [circle("c1")]);

    expect(trimDraft(sketch, shown, shown.curves[0]!, [0, 110], noPoint)).toBeNull();

    const [asCircle, circleShown] = sketchOf(
      [...base, { id: "a1", type: "circle", center: "pc", radius: 10 }],
      [arc("a1", 0, Math.PI)],
    );

    expect(trimDraft(asCircle, circleShown, circleShown.curves[0]!, [0, 110], noPoint)).not.toBeNull();
  });
});

describe("trimming splines", () => {
  const through: Vec2[] = [points.s1!, points.s2!, points.s3!];
  const spline = (construction = false): SolvedCurve => ({
    id: "sp1",
    kind: "spline",
    pts: splinePoints(through),
    through,
    points: ["s1", "s2", "s3"],
    closed: false,
    construction,
    external: false,
  });
  const cutter = (x: number): SolvedCurve => ({
    ...solvedLine(`v${x}`, "p1", "p2"),
    a: [x, -10],
    b: [x, 30],
  });
  const entities = (construction = false): SketchEntity[] => [
    ...["s1", "s2", "s3", "p1", "p2"].map(point),
    { id: "sp1", type: "spline", points: ["s1", "s2", "s3"], ...(construction ? { construction } : {}) },
    line("v10", "p1", "p2"),
    line("v30", "p1", "p2"),
  ];

  it("cuts the stretch around the click out, the rest as two splines", () => {
    for (const construction of [false, true]) {
      const [sketch, shown] = sketchOf(entities(construction), [
        spline(construction),
        cutter(10),
        cutter(30),
      ]);
      const draft = trimDraft(sketch, shown, shown.curves[0]!, [20, 20], noPoint)!;

      expect(byId(draft, "sp1")).toMatchObject({ points: ["s1", "p3"] });
      // The through-points are s1 to s3: the new spline is s4.
      expect(byId(draft, "s4")).toMatchObject({ type: "spline", points: ["p4", "s3"] });
      expect((byId(draft, "s4") as { construction?: boolean }).construction).toBe(construction || undefined);
    }
  });

  it("removes a spline nothing bounds", () => {
    const [sketch, shown] = sketchOf(entities(), [spline()]);

    expect(ids(trimDraft(sketch, shown, shown.curves[0]!, [20, 20], noPoint)!)).not.toContain("sp1");
  });

  it("does nothing when the id is not a spline in the sketch", () => {
    const [sketch, shown] = sketchOf([line("sp1", "p1", "p2")], [spline()]);

    expect(trimDraft(sketch, shown, shown.curves[0]!, [20, 20], noPoint)).toBeNull();
  });
});
