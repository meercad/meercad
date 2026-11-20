/**
 * Moving a sketch dimension's value (its line, parallel to itself) by dragging: while the drag goes
 * on, only the picture follows (the sketch shown with the value at its new place); the document gets
 * the new place once, when the drag ends. Writing it on every move would solve the sketch and build
 * the whole model again for each pointer move, though a value's place changes no geometry.
 */
import type { SketchConstraint, SketchFeature } from "@meercad/schema";

type Vec2 = readonly [number, number];

/** A value's place as stored: sketch coordinates to 0.01 mm. */
export function storedLabel(at: Vec2): [number, number] {
  return [+at[0].toFixed(2), +at[1].toFixed(2)];
}

/** The constraints with `id`'s value placed at `at` (stored precision). */
export function withLabel(constraints: SketchConstraint[], id: string, at: Vec2): SketchConstraint[] {
  const label = storedLabel(at);

  return constraints.map((x) => (x.id === id ? ({ ...x, label } as SketchConstraint) : x));
}

/** A value being dragged: which dimension, and where it is now. */
export interface MovingLabel {
  id: string;
  at: Vec2;
}

/** The sketch as shown while `moving` is dragged (the same sketch when nothing is). */
export function shownWithLabel<S extends Pick<SketchFeature, "constraints">>(
  sketch: S,
  moving: MovingLabel | null,
): S {
  if (!moving) return sketch;

  return { ...sketch, constraints: withLabel(sketch.constraints, moving.id, moving.at) };
}
