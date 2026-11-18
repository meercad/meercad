/**
 * Dragging a line of a sketch on the model: the line moves across itself in the sketch plane, its
 * neighbours stay joined (the solver keeps every constraint), and a dimension that holds the line in
 * place changes with the drag instead of being broken: a length or distance from a point that moves
 * to one that stays (a rectangle's width when its side is dragged) is let go while dragging and set to
 * what it measures afterwards.
 */
import type { SketchConstraint, SketchFeature } from "@meercad/schema";
import { distance2, sub2, type Vec2 } from "@meercad/sketch";
import { pointsOf } from "./sketchEdge";

/** Decimal places a dimension changed by a drag is rounded to (0.01 mm). */
const DIMENSION_DECIMALS = 2;

/** The point id a constraint's point reference names: "l1.p2" is line l1's second point. */
export function pointIdOf(ref: string, sketch: SketchFeature): string {
  const [entityId, field] = ref.split(".");
  if (!field || entityId === "origin") return ref;

  const entity = sketch.entities.find((x) => x.id === entityId) as Record<string, unknown> | undefined;
  const id = entity?.[field];

  return typeof id === "string" ? id : ref;
}

/** A point's position: the origin, or a solved point. */
function at(id: string, points: ReadonlyMap<string, Vec2>): Vec2 | null {
  return id === "origin" ? [0, 0] : (points.get(id) ?? null);
}

/** The line entity with this id, if it is one. */
function lineOf(sketch: SketchFeature, id: string) {
  const entity = sketch.entities.find((x) => x.id === id);

  return entity?.type === "line" ? entity : null;
}

type Dimension = Extract<SketchConstraint, { type: "length" | "distance" }>;

/** The points whose positions a length or distance measures between. */
export function pointsMeasured(constraint: Dimension, sketch: SketchFeature): string[] {
  if (constraint.type === "length") {
    const line = lineOf(sketch, constraint.line);

    return line ? [line.p1, line.p2] : [];
  }

  const line = lineOf(sketch, constraint.b);
  const to = line ? [line.p1, line.p2] : [pointIdOf(constraint.b, sketch)];

  return [pointIdOf(constraint.a, sketch), ...to];
}

/**
 * The dimensions a move of the points `moving` changes: lengths and plain-number distances between a
 * moving and a still point. A value written as a variable or expression is kept (it may drive more).
 */
export function freedDimensions(sketch: SketchFeature, moving: ReadonlySet<string>): Dimension[] {
  return sketch.constraints.filter((constraint): constraint is Dimension => {
    if (constraint.type !== "length" && constraint.type !== "distance") return false;
    if (typeof constraint.value !== "number") return false;

    const points = pointsMeasured(constraint, sketch);

    return points.some((id) => moving.has(id)) && points.some((id) => !moving.has(id));
  });
}

/** What a length or distance measures with the points where they are; null if one is missing. */
export function measure(
  constraint: Dimension,
  sketch: SketchFeature,
  points: ReadonlyMap<string, Vec2>,
): number | null {
  const ids = pointsMeasured(constraint, sketch);
  const spots = ids.map((id) => at(id, points));
  if (!spots.length || spots.some((spot) => !spot)) return null;

  const [a, b, c] = spots as Vec2[];

  // From a point to a line: straight across to it, however long the line is.
  if (c) return Math.abs(cross(sub2(c, b!), sub2(a!, b!))) / (distance2(b!, c) || 1);

  if (constraint.type === "distance" && constraint.axis) {
    return Math.abs(b![constraint.axis === "x" ? 0 : 1] - a![constraint.axis === "x" ? 0 : 1]);
  }

  return distance2(a!, b!);
}

const cross = (u: Vec2, v: Vec2) => u[0] * v[1] - u[1] * v[0];

/** The constraints with each freed dimension set to what it measures now (rounded). */
export function withMeasured(
  sketch: SketchFeature,
  freed: readonly Dimension[],
  points: ReadonlyMap<string, Vec2>,
): SketchConstraint[] {
  const ids = new Set(freed.map((x) => x.id));

  return sketch.constraints.map((constraint) => {
    if (!ids.has(constraint.id)) return constraint;

    const value = measure(constraint as Dimension, sketch, points);

    return value === null ? constraint : { ...constraint, value: +value.toFixed(DIMENSION_DECIMALS) };
  });
}

/** The unit direction across a line from `a` to `b`, in the sketch plane (left of its way). */
export function across(a: Vec2, b: Vec2): Vec2 {
  const along = sub2(b, a);
  const length = Math.hypot(along[0], along[1]) || 1;

  return [-along[1] / length, along[0] / length];
}

/** Where the points `ids` go when moved by `offset` across the line; drag targets for the solver. */
export function shiftedTargets(
  ids: readonly string[],
  points: ReadonlyMap<string, Vec2>,
  normal: Vec2,
  offset: number,
): Record<string, Vec2> {
  const targets: Record<string, Vec2> = {};

  for (const id of ids) {
    const p = points.get(id);
    if (p) targets[id] = [p[0] + normal[0] * offset, p[1] + normal[1] * offset];
  }

  return targets;
}

/** The points a dragged line moves (its two ends). */
export function movingPoints(sketch: SketchFeature, lineId: string): string[] {
  const line = lineOf(sketch, lineId);

  return line ? pointsOf(line) : [];
}
