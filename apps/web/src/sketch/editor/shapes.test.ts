/** New sketch geometry as drafts: points reused and tied, shapes and their constraints. */
import { describe, expect, it } from "vitest";
import type { SketchFeature } from "@meercad/schema";
import type { Vec2 } from "@meercad/sketch";
import {
  centerArcDraft,
  circleDraft,
  draftBuilder,
  lineDraft,
  polygonDraft,
  rectDraft,
  splineDraft,
  threePointArcDraft,
} from "./shapes";
import type { Draft, Snap } from "./types";

const sketch: SketchFeature = {
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities: [
    { id: "p1", type: "point", x: 0, y: 0 },
    { id: "l1", type: "line", p1: "p1", p2: "p1" },
  ],
  constraints: [],
};
const style = { minSize: 0.5, construction: false };
const guides = { minSize: 0.5, construction: true };
const at = (pos: Vec2, more: Partial<Snap> = {}): Snap => ({ pos, ...more });
const types = (draft: Draft) => draft.constraints.map((c) => c.type);
const added = (draft: Draft) => draft.entities.slice(sketch.entities.length);

describe("draftBuilder", () => {
  it("reuses a snapped point and ties new points to what they snapped to", () => {
    const builder = draftBuilder(sketch);

    expect(builder.point(at([0, 0], { point: "p1" }))).toBe("p1");
    expect(builder.point(at([0, 0], { point: "l1.p2" }))).toBe("p2");
    expect(builder.point(at([1, 0], { mid: "l1" }))).toBe("p3");
    expect(builder.point(at([2, 0], { curve: "l1" }))).toBe("p4");
    expect(builder.point(at([3, 0], { curve: "l1", curve2: "c9" }))).toBe("p5");
    expect(builder.point(at([4, 0]), true)).toBe("p6");
    expect(builder.draft.constraints).toEqual([
      { id: "c1", type: "coincident", a: "p2", b: "l1.p2" },
      { id: "c2", type: "midpoint", point: "p3", line: "l1" },
      { id: "c3", type: "point_on", point: "p4", curve: "l1" },
      { id: "c4", type: "point_on", point: "p5", curve: "l1" },
      { id: "c5", type: "point_on", point: "p5", curve: "c9" },
    ]);
    expect(builder.draft.entities.at(-1)).toEqual({
      id: "p6",
      type: "point",
      x: 4,
      y: 0,
      construction: true,
    });
    expect(sketch.entities).toHaveLength(2);
  });
});

describe("lineDraft", () => {
  it("draws a line with its typed length, horizontal when drawn nearly so", () => {
    const result = lineDraft(sketch, at([0, 1]), at([10, 1.2]), 10, style)!;

    expect(result.line).toBe("l2");
    expect(result.ends).toEqual(["p2", "p3"]);
    expect(types(result.draft)).toEqual(["length", "horizontal"]);
    expect(added(result.draft)[2]).toEqual({ id: "l2", type: "line", p1: "p2", p2: "p3" });
  });

  it("makes lines vertical, leaves slanted ones and too short ones", () => {
    expect(types(lineDraft(sketch, at([1, 0]), at([1.1, -10]), undefined, guides)!.draft)).toEqual([
      "vertical",
    ]);
    expect(types(lineDraft(sketch, at([10, 0]), at([0, 0.2]), undefined, style)!.draft)).toEqual([
      "horizontal",
    ]);
    expect(types(lineDraft(sketch, at([0, 0]), at([5, 5]), undefined, style)!.draft)).toEqual([]);
    expect(lineDraft(sketch, at([0, 0]), at([0.1, 0]), undefined, style)).toBeNull();
    expect(added(lineDraft(sketch, at([0, 0]), at([5, 5]), undefined, guides)!.draft)[2]).toMatchObject({
      construction: true,
    });
  });

  it("adds no axis constraint when both ends already lie on that axis", () => {
    const onX = lineDraft(
      sketch,
      at([0, 0], { point: "origin" }),
      at([5, 0], { curve: "origin.x" }),
      undefined,
      style,
    )!;

    expect(types(onX.draft)).toEqual(["coincident", "point_on"]);

    const onY = lineDraft(
      sketch,
      at([0, 5], { curve: "origin.y" }),
      at([0, 0], { point: "origin" }),
      undefined,
      style,
    )!;

    expect(types(onY.draft)).toEqual(["point_on", "coincident"]);

    // One end on the axis only: still held.
    expect(
      types(lineDraft(sketch, at([0, 5], { curve: "origin.y" }), at([0, 9]), undefined, style)!.draft),
    ).toEqual(["point_on", "vertical"]);
  });

  it("counts a corner coincident with the origin either way round as on the axis", () => {
    const base: SketchFeature = {
      ...sketch,
      entities: [...sketch.entities, { id: "p7", type: "point", x: 0, y: 0 }],
      constraints: [{ id: "k1", type: "coincident", a: "origin", b: "p7" }],
    };

    expect(
      types(
        lineDraft(base, at([0, 0], { point: "p7" }), at([0, 0.1], { point: "origin" }), undefined, {
          ...style,
          minSize: 0,
        })!.draft,
      ),
    ).toEqual(["coincident", "coincident"]);
  });
});

describe("rectDraft", () => {
  it("draws a rectangle from a corner with its typed sizes", () => {
    const draft = rectDraft(
      sketch,
      at([0, 0], { point: "p1" }),
      at([20, 10]),
      false,
      { w: 20, h: "h" },
      style,
    )!;

    expect(added(draft).map((e) => e.type)).toEqual([
      "point",
      "point",
      "point",
      "line",
      "line",
      "line",
      "line",
    ]);
    expect(types(draft)).toEqual(["horizontal", "horizontal", "vertical", "vertical", "length", "length"]);
  });

  it("draws one round its centre with a construction diagonal", () => {
    const draft = rectDraft(sketch, at([0, 0]), at([5, 5]), true, undefined, guides)!;

    expect(added(draft).filter((e) => e.type === "point")).toHaveLength(5);
    expect(types(draft).at(-1)).toBe("midpoint");
    expect(added(draft).at(-1)).toMatchObject({ type: "line", construction: true });
    expect(draft.entities.find((e) => e.id === "p2")).toMatchObject({ x: -5, y: -5 });
  });

  it("refuses a rectangle too thin", () => {
    expect(rectDraft(sketch, at([0, 0]), at([0.1, 10]), false, {}, style)).toBeNull();
    expect(rectDraft(sketch, at([0, 0]), at([10, 0.1]), false, {}, style)).toBeNull();
  });
});

describe("circles and arcs", () => {
  it("draws a circle with its typed diameter", () => {
    const result = circleDraft(sketch, at([0, 0]), 5, 10, guides)!;

    expect(result.circle).toBe("c1");
    expect(types(result.draft)).toEqual(["diameter"]);
    expect(circleDraft(sketch, at([0, 0]), 5, undefined, style)!.draft.constraints).toEqual([]);
    expect(circleDraft(sketch, at([0, 0]), 0.1, undefined, style)).toBeNull();
  });

  it("draws a centre arc either way round, its end on the circle", () => {
    const ccw = centerArcDraft(sketch, at([0, 0]), at([5, 0]), at([0, 9]), true, 90, style)!;
    const arc = ccw.draft.entities.find((e) => e.id === ccw.arc) as { start: string; end: string };
    const point = (draft: Draft, id: string) =>
      draft.entities.find((e) => e.id === id) as { x: number; y: number };

    expect(point(ccw.draft, arc.start)).toMatchObject({ x: 5, y: 0 });
    expect(point(ccw.draft, arc.end).y).toBeCloseTo(5);
    expect(types(ccw.draft)).toEqual(["arc_angle"]);

    const cw = centerArcDraft(sketch, at([0, 0]), at([5, 0]), at([0, 9]), false, undefined, guides)!;
    const cwArc = cw.draft.entities.find((e) => e.id === cw.arc) as { start: string; end: string };

    expect(point(cw.draft, cwArc.end)).toMatchObject({ x: 5, y: 0 });
    expect(centerArcDraft(sketch, at([0, 0]), at([0.1, 0]), at([0, 9]), true, undefined, style)).toBeNull();
  });

  it("draws an arc through three points with its typed radius and angle", () => {
    const result = threePointArcDraft(
      sketch,
      at([-5, 0]),
      at([5, 0]),
      [0, 5],
      { radius: 5, angle: 180 },
      style,
    )!;
    const arc = result.draft.entities.find((e) => e.id === result.arc) as { start: string; end: string };

    expect(types(result.draft)).toEqual(["radius", "arc_angle"]);
    expect(result.draft.entities.find((e) => e.id === arc.start)).toMatchObject({ x: 5 });

    // The middle below: the ends swap so the arc still runs counter-clockwise.
    const below = threePointArcDraft(sketch, at([-5, 0]), at([5, 0]), [0, -5], {}, guides)!;
    const belowArc = below.draft.entities.find((e) => e.id === below.arc) as { start: string };

    expect(below.draft.entities.find((e) => e.id === belowArc.start)).toMatchObject({ x: -5 });
    expect(threePointArcDraft(sketch, at([0, 0]), at([2, 0]), [1, 0], {}, style)).toBeNull();
    expect(threePointArcDraft(sketch, at([0, 0]), at([0.2, 0]), [0.1, 0.1], {}, style)).toBeNull();
  });
});

describe("polygons and splines", () => {
  it("draws a regular polygon on a construction circle, its sides held equal", () => {
    const draft = polygonDraft(sketch, at([0, 0]), [10, 0], 6, guides)!;

    expect(added(draft).filter((e) => e.type === "line")).toHaveLength(6);
    expect(types(draft).filter((t) => t === "equal")).toHaveLength(5);
    expect(types(draft).filter((t) => t === "point_on")).toHaveLength(6);
    expect(polygonDraft(sketch, at([0, 0]), [10, 0], 3, style)!.entities.at(-1)).not.toHaveProperty(
      "construction",
    );
    expect(polygonDraft(sketch, at([0, 0]), [0.1, 0], 6, style)).toBeNull();
  });

  it("draws a spline through the points, open or closed", () => {
    const open = splineDraft(sketch, [at([0, 0]), at([1, 1]), at([2, 0])], false, false);

    expect(open.entities.at(-1)).toEqual({ id: "s1", type: "spline", points: ["p2", "p3", "p4"] });

    const closed = splineDraft(sketch, [at([0, 0], { point: "p1" }), at([1, 1])], true, true);

    expect(closed.entities.at(-1)).toEqual({
      id: "s1",
      type: "spline",
      points: ["p1", "p2"],
      closed: true,
      construction: true,
    });
  });
});
