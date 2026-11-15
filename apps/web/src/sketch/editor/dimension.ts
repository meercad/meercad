/** The dimension tool: which dimension the picked geometry gets, set to its current size. */
import { distance2, type SolvedSketch, type Vec2 } from "@meercad/sketch";
import type { SketchSel } from "../state";
import { curveDistance, round, sweepOf } from "./geometry";
import type { NewConstraint } from "./types";

/** Lines whose directions differ by less than this (sine of the angle) count as parallel. */
const PARALLEL = 1e-3;

/**
 * The dimension between the picks `a` and `b` (or of `a` alone), with its label at `at`; null when
 * the picks have no dimension (two circles, a point and an arc, …).
 */
export function dimensionFor(
  shown: SolvedSketch,
  a: SketchSel,
  b: SketchSel | null,
  at: Vec2,
): NewConstraint | null {
  const label: [number, number] = [round(at[0]), round(at[1])];

  if (a.kind === "curve" && !b) return curveDimension(shown, a.id, at, label);
  if (a.kind === "point" && b?.kind === "point") return pointsDimension(shown, a.id, b.id, at, label);

  if (b && ((a.kind === "point" && b.kind === "curve") || (a.kind === "curve" && b.kind === "point"))) {
    const [pt, cv] = a.kind === "point" ? [a.id, b.id] : [b.id, a.id];

    return pointLineDimension(shown, pt, cv, label);
  }

  if (a.kind === "curve" && b?.kind === "curve") return linesDimension(shown, a.id, b.id, label);

  return null;
}

/** A line's length, a circle's diameter, an arc's radius or (placed near its centre) its angle. */
function curveDimension(
  shown: SolvedSketch,
  id: string,
  at: Vec2,
  label: [number, number],
): NewConstraint | null {
  const curve = shown.curves.find((x) => x.id === id)!;

  if (curve.kind === "line") {
    return {
      type: "length",
      line: id,
      value: round(distance2(curve.a, curve.b)),
      label,
    };
  }

  if (curve.kind === "circle") return { type: "diameter", curve: id, value: round(curve.radius * 2), label };
  if (curve.kind !== "arc") return null;

  // Placed inside the arc, near its centre: the angle it sweeps; further out: its radius.
  const inside = distance2(curve.center, at) < curve.radius * 0.6;

  return inside
    ? {
        type: "arc_angle",
        curve: id,
        value: round((sweepOf(curve.a0, curve.a1) * 180) / Math.PI),
        label,
      }
    : { type: "radius", curve: id, value: round(curve.radius), label };
}

/**
 * Two points: the label beside them measures across (x or y only), the label between or diagonal
 * from them their straight distance.
 */
function pointsDimension(
  shown: SolvedSketch,
  a: string,
  b: string,
  at: Vec2,
  label: [number, number],
): NewConstraint {
  const pa = shown.points.get(a)!;
  const pb = shown.points.get(b)!;
  const [minX, maxX] = [Math.min(pa[0], pb[0]), Math.max(pa[0], pb[0])];
  const [minY, maxY] = [Math.min(pa[1], pb[1]), Math.max(pa[1], pb[1])];
  const outX = at[0] < minX || at[0] > maxX;
  const outY = at[1] < minY || at[1] > maxY;

  if (outX && !outY) {
    return { type: "distance", a, b, axis: "y", value: round(Math.abs(pb[1] - pa[1])), label };
  }

  if (outY && !outX) {
    return { type: "distance", a, b, axis: "x", value: round(Math.abs(pb[0] - pa[0])), label };
  }

  return {
    type: "distance",
    a,
    b,
    value: round(distance2(pa, pb)),
    label,
  };
}

/** A point's distance from a line (as if the line went on forever). */
function pointLineDimension(
  shown: SolvedSketch,
  pt: string,
  cv: string,
  label: [number, number],
): NewConstraint | null {
  const curve = shown.curves.find((x) => x.id === cv);
  if (curve?.kind !== "line") return null;

  return {
    type: "distance",
    a: pt,
    b: cv,
    value: round(curveDistance(curve, shown.points.get(pt)!, true)),
    label,
  };
}

/** Two lines: their distance when parallel, otherwise the angle between them. */
function linesDimension(
  shown: SolvedSketch,
  a: string,
  b: string,
  label: [number, number],
): NewConstraint | null {
  const curve = shown.curves.find((x) => x.id === a);
  const cb = shown.curves.find((x) => x.id === b);
  if (curve?.kind !== "line" || cb?.kind !== "line") return null;

  const d1: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
  const d2: Vec2 = [cb.b[0] - cb.a[0], cb.b[1] - cb.a[1]];
  const cross = d1[0] * d2[1] - d1[1] * d2[0];
  const dotp = d1[0] * d2[0] + d1[1] * d2[1];
  const ang = (Math.abs(Math.atan2(cross, dotp)) * 180) / Math.PI;

  if (Math.abs(cross) / (Math.hypot(...d1) * Math.hypot(...d2)) < PARALLEL) {
    return {
      type: "distance",
      a: `${b}.p1`,
      b: a,
      value: round(curveDistance(curve, cb.a, true)),
      label,
    };
  }

  return { type: "angle", a, b, value: round(ang), label };
}
