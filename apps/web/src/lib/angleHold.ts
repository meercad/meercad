/**
 * Changing an angle between two lines turns one of them, not both: the line that stays is held where
 * it is while the sketch is solved (its ends become drag targets at their current places). It is the
 * first line of the angle (the one picked first), unless the other one is more firmly placed by the
 * rest of the sketch: then that one stays and the free one turns.
 */
import type { SketchFeature } from "@meercad/schema";
import type { Vec2 } from "@meercad/sketch";
import { constraintRefs, pointsOf } from "./sketchEdge";

/** How firmly the rest of the sketch places a line: constraints on it or its ends, the angle aside. */
export function firmness(sketch: SketchFeature, lineId: string, other: string): number {
  const line = sketch.entities.find((x) => x.id === lineId);
  const own = new Set([lineId, ...(line ? pointsOf(line) : [])]);

  return sketch.constraints.filter((constraint) => {
    const refs = constraintRefs(constraint);
    if (constraint.type === "angle" && refs.includes(other)) return false;

    return refs.some((ref) => own.has(ref));
  }).length;
}

/** The line that stays when the angle between `first` and `second` changes. */
export function anchorLine(sketch: SketchFeature, first: string, second: string): string {
  return firmness(sketch, second, first) > firmness(sketch, first, second) ? second : first;
}

/** Drag targets that hold a line's ends where they are now. */
export function holdLine(
  sketch: SketchFeature,
  lineId: string,
  points: ReadonlyMap<string, Vec2>,
): Record<string, Vec2> {
  const line = sketch.entities.find((x) => x.id === lineId);
  const targets: Record<string, Vec2> = {};

  for (const id of line ? pointsOf(line) : []) {
    const at = points.get(id);
    if (at) targets[id] = at;
  }

  return targets;
}

/** Solved entities with the held line's ends kept exactly as they were stored (not just nearly). */
export function keepLine(
  original: SketchFeature["entities"],
  solved: SketchFeature["entities"],
  lineId: string,
): SketchFeature["entities"] {
  const line = original.find((x) => x.id === lineId);
  const ends = new Set(line ? pointsOf(line) : []);

  return solved.map((entity) => (ends.has(entity.id) ? original.find((x) => x.id === entity.id)! : entity));
}

/** The two lines of an angle constraint that changed between two constraint lists, if one did. */
export function changedAngle(
  before: SketchFeature["constraints"],
  after: SketchFeature["constraints"],
): [string, string] | null {
  for (const constraint of after) {
    if (constraint.type !== "angle") continue;

    const old = before.find((x) => x.id === constraint.id);
    if (!old || (old as { value: unknown }).value !== constraint.value) return [constraint.a, constraint.b];
  }

  return null;
}
