/**
 * New sketch geometry as drafts: each drawing tool's shape with the points it reuses and the
 * constraints that keep it as drawn. Nothing here touches the document; the editor commits the draft.
 */
import type { Expr, SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import { distance2, type Vec2 } from "@meercad/sketch";
import { freshId } from "../actions";
import { arcThrough } from "./geometry";
import type { Draft, NewConstraint, NewEntity, Snap } from "./types";

/** Adds points, entities and constraints to a copy of `base`, each with a fresh id. */
export function draftBuilder(base: Draft) {
  const draft: Draft = { entities: [...base.entities], constraints: [...base.constraints] };
  const taken = new Set<string>();
  const isEntityPoint = (id: string) =>
    draft.entities.some((entity) => entity.id === id && entity.type === "point");

  return {
    draft,
    /** The point a snap lands on: reused if it is one, otherwise new and tied to what it snapped to. */
    point(snap: Snap, construction = false): string {
      if (snap.point && isEntityPoint(snap.point)) return snap.point;

      const id = freshId(draft, "p", taken);
      draft.entities.push({
        id,
        type: "point",
        x: snap.pos[0],
        y: snap.pos[1],
        ...(construction ? { construction } : {}),
      });

      if (snap.point) {
        draft.constraints.push({
          id: freshId(draft, "c", taken),
          type: "coincident",
          a: id,
          b: snap.point,
        });
      } else if (snap.mid) {
        draft.constraints.push({
          id: freshId(draft, "c", taken),
          type: "midpoint",
          point: id,
          line: snap.mid,
        });
      } else if (snap.curve) {
        draft.constraints.push({
          id: freshId(draft, "c", taken),
          type: "point_on",
          point: id,
          curve: snap.curve,
        });

        if (snap.curve2) {
          draft.constraints.push({
            id: freshId(draft, "c", taken),
            type: "point_on",
            point: id,
            curve: snap.curve2,
          });
        }
      }

      return id;
    },
    entity(e: NewEntity, prefix: string): string {
      const id = freshId(draft, prefix, taken);
      draft.entities.push({ ...e, id } as SketchEntity);

      return id;
    },
    constraint(c: NewConstraint): string {
      const id = freshId(draft, "c", taken);
      draft.constraints.push({ ...c, id } as SketchConstraint);

      return id;
    },
  };
}

export type DraftBuilder = ReturnType<typeof draftBuilder>;

/** How a new shape is drawn: shorter than `minSize` (sketch units) it is a slip, not a shape. */
export interface ShapeStyle {
  minSize: number;
  construction: boolean;
}

/** The construction flag as the new curves carry it (absent when false). */
const flagOf = (style: ShapeStyle) => (style.construction ? { construction: true } : {});

/** Lines within this angle of the axes are made horizontal or vertical (radians). */
const AXIS_TOLERANCE = (3 * Math.PI) / 180;

/** A line from `a` to `b`, horizontal or vertical when drawn nearly so. */
export function lineDraft(
  sketch: SketchFeature,
  a: Snap,
  b: Snap,
  length: Expr | undefined,
  style: ShapeStyle,
): { draft: Draft; line: string; ends: [string, string] } | null {
  if (distance2(a.pos, b.pos) < style.minSize) return null;

  const builder = draftBuilder(sketch);
  const p1 = builder.point(a);
  const p2 = builder.point(b);
  const line = builder.entity({ type: "line", p1, p2, ...flagOf(style) }, "l");
  if (length !== undefined) builder.constraint({ type: "length", line, value: length });

  const ang = Math.abs(Math.atan2(b.pos[1] - a.pos[1], b.pos[0] - a.pos[0]));
  // Not when both ends already lie on that origin axis: the constraint would be redundant.
  const onAxis = (pt: string, axis: "origin.x" | "origin.y") =>
    pt === "origin" ||
    builder.draft.constraints.some(
      (constraint) =>
        (constraint.type === "point_on" && constraint.point === pt && constraint.curve === axis) ||
        (constraint.type === "coincident" &&
          ((constraint.a === pt && constraint.b === "origin") ||
            (constraint.b === pt && constraint.a === "origin"))),
    );

  if (ang < AXIS_TOLERANCE || Math.abs(ang - Math.PI) < AXIS_TOLERANCE) {
    if (!(onAxis(p1, "origin.x") && onAxis(p2, "origin.x"))) builder.constraint({ type: "horizontal", line });
  } else if (Math.abs(ang - Math.PI / 2) < AXIS_TOLERANCE) {
    if (!(onAxis(p1, "origin.y") && onAxis(p2, "origin.y"))) builder.constraint({ type: "vertical", line });
  }

  return { draft: builder.draft, line, ends: [p1, p2] };
}

/** A rectangle from corner `a` (or its centre) to corner `b`, with typed sizes as dimensions. */
export function rectDraft(
  sketch: SketchFeature,
  a: Snap,
  b: Snap,
  centered: boolean,
  size: { w?: Expr | undefined; h?: Expr | undefined } | undefined,
  style: ShapeStyle,
): Draft | null {
  const [cx, cy] = a.pos;
  const [x0, y0, x1, y1] = centered
    ? [2 * cx - b.pos[0], 2 * cy - b.pos[1], b.pos[0], b.pos[1]]
    : [a.pos[0], a.pos[1], b.pos[0], b.pos[1]];
  if (Math.abs(x1 - x0) < style.minSize || Math.abs(y1 - y0) < style.minSize) return null;

  const builder = draftBuilder(sketch);
  const corners: Snap[] = [{ pos: [x0, y0] }, { pos: [x1, y0] }, { pos: [x1, y1] }, { pos: [x0, y1] }];
  if (!centered) corners[0] = a;

  corners[2] = b;

  const ids = corners.map((snap) => builder.point(snap));
  const lines = ids.map((p, i) =>
    builder.entity({ type: "line", p1: p, p2: ids[(i + 1) % 4]!, ...flagOf(style) }, "l"),
  );
  builder.constraint({ type: "horizontal", line: lines[0]! });
  builder.constraint({ type: "horizontal", line: lines[2]! });
  builder.constraint({ type: "vertical", line: lines[1]! });
  builder.constraint({ type: "vertical", line: lines[3]! });
  if (size?.w !== undefined) builder.constraint({ type: "length", line: lines[0]!, value: size.w });
  if (size?.h !== undefined) builder.constraint({ type: "length", line: lines[1]!, value: size.h });

  if (centered) {
    const center = builder.point(a, true);
    const diag = builder.entity({ type: "line", p1: ids[0]!, p2: ids[2]!, construction: true }, "l");
    builder.constraint({ type: "midpoint", point: center, line: diag });
  }

  return builder.draft;
}

/** A circle round `center`, with a typed diameter as a dimension. */
export function circleDraft(
  sketch: SketchFeature,
  center: Snap,
  r: number,
  diameter: Expr | undefined,
  style: ShapeStyle,
): { draft: Draft; circle: string } | null {
  if (r < style.minSize) return null;

  const builder = draftBuilder(sketch);
  const centerId = builder.point(center);
  const circle = builder.entity({ type: "circle", center: centerId, radius: r, ...flagOf(style) }, "c");
  if (diameter !== undefined) builder.constraint({ type: "diameter", curve: circle, value: diameter });

  return { draft: builder.draft, circle };
}

/** An arc round `center` from `s` to the ray toward `e`, counter-clockwise or not. */
export function centerArcDraft(
  sketch: SketchFeature,
  center: Snap,
  s: Snap,
  e: Snap,
  ccw: boolean,
  angle: Expr | undefined,
  style: ShapeStyle,
): { draft: Draft; arc: string } | null {
  const r = distance2(center.pos, s.pos);
  if (r < style.minSize) return null;

  const builder = draftBuilder(sketch);
  const centerId = builder.point(center);
  const a = Math.atan2(e.pos[1] - center.pos[1], e.pos[0] - center.pos[0]);
  const endOnCircle: Snap = {
    ...e,
    pos: [center.pos[0] + r * Math.cos(a), center.pos[1] + r * Math.sin(a)],
  };
  const start = builder.point(ccw ? s : endOnCircle);
  const end = builder.point(ccw ? endOnCircle : s);
  const arc = builder.entity({ type: "arc", center: centerId, start, end, ...flagOf(style) }, "a");
  if (angle !== undefined) builder.constraint({ type: "arc_angle", curve: arc, value: angle });

  return { draft: builder.draft, arc };
}

/**
 * An arc through its two ends and a third point that sets bulge and radius; typed values become
 * dimensions.
 */
export function threePointArcDraft(
  sketch: SketchFeature,
  a: Snap,
  b: Snap,
  m: Vec2,
  dims: { radius?: Expr | undefined; angle?: Expr | undefined },
  style: ShapeStyle,
): { draft: Draft; arc: string } | null {
  const circle = arcThrough(a.pos, b.pos, m);
  if (!circle || circle.radius < style.minSize) return null;

  const builder = draftBuilder(sketch);
  const center = builder.point({ pos: circle.center });
  const [first, second] = circle.swapped ? [b, a] : [a, b];
  const start = builder.point(first);
  const end = builder.point(second);
  const arc = builder.entity({ type: "arc", center, start, end, ...flagOf(style) }, "a");
  if (dims.radius !== undefined) builder.constraint({ type: "radius", curve: arc, value: dims.radius });
  if (dims.angle !== undefined) builder.constraint({ type: "arc_angle", curve: arc, value: dims.angle });

  return { draft: builder.draft, arc };
}

/** A regular polygon inscribed in a construction circle; equal sides keep it regular. */
export function polygonDraft(
  sketch: SketchFeature,
  center: Snap,
  corner: Vec2,
  sides: number,
  style: ShapeStyle,
): Draft | null {
  const r = distance2(center.pos, corner);
  if (r < style.minSize) return null;

  const builder = draftBuilder(sketch);
  const centerId = builder.point(center);
  const circle = builder.entity({ type: "circle", center: centerId, radius: r, construction: true }, "c");
  const a0 = Math.atan2(corner[1] - center.pos[1], corner[0] - center.pos[0]);
  const pts = Array.from({ length: sides }, (_, i) => {
    const a = a0 + (i * 2 * Math.PI) / sides;
    const id = builder.point({ pos: [center.pos[0] + r * Math.cos(a), center.pos[1] + r * Math.sin(a)] });
    builder.constraint({ type: "point_on", point: id, curve: circle });

    return id;
  });
  const lines = pts.map((p, i) =>
    builder.entity({ type: "line", p1: p, p2: pts[(i + 1) % sides]!, ...flagOf(style) }, "l"),
  );
  for (let i = 1; i < lines.length; i++) builder.constraint({ type: "equal", a: lines[0]!, b: lines[i]! });

  return builder.draft;
}

/** A spline through the clicked points (at least two), open or closed. */
export function splineDraft(
  sketch: SketchFeature,
  pts: Snap[],
  closed: boolean,
  construction: boolean,
): Draft {
  const builder = draftBuilder(sketch);
  const ids = pts.map((snap) => builder.point(snap, construction));
  builder.entity(
    {
      type: "spline",
      points: ids,
      ...(closed ? { closed: true } : {}),
      ...(construction ? { construction: true } : {}),
    },
    "s",
  );

  return builder.draft;
}
