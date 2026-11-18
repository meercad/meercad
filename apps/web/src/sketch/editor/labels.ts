/** Text in the sketch: dimension values and constraint glyphs, and the size chips of a new shape. */
import type { Expr, SketchFeature } from "@meercad/schema";
import { distance2, type SolvedCurve, type SolvedSketch, type Vec2 } from "@meercad/sketch";
import { t } from "../../lib/i18n";
import { docUnit, fmtLen } from "../../lib/units";
import { GLYPH } from "../icons";
import { angleArc } from "../../lib/angleDim";
import { extentOf, middleOf, sizesFor } from "../../lib/dimStyle";
import { dimensionDrawing, fmt, linePair, sweepOf } from "./geometry";
import type { QuickDim } from "./types";

export interface Label {
  id: string;
  at: Vec2;
  text: string;
  title: string;
  dimension: boolean;
  /** Drawn in the plane on its dimension line: the way its text runs, and the side it stands on. */
  along?: Vec2;
  up?: Vec2;
  /** A length's dimension line (its two ends): dragged, the dimension moves parallel to itself. */
  line?: [Vec2, Vec2];
}

/** Constraint type names for the label tooltips (English shows the type id as before). */
const CONSTRAINT_NAMES: Record<string, string> = {
  length: t("constraint::length"),
  distance: t("constraint::distance"),
  radius: t("constraint::radius"),
  diameter: t("constraint::diameter"),
  angle: t("constraint::angle"),
  arc_angle: t("constraint::arc_angle"),
  horizontal: t("constraint::horizontal"),
  vertical: t("constraint::vertical"),
  horizontal_points: t("constraint::horizontal_points"),
  vertical_points: t("constraint::vertical_points"),
  parallel: t("constraint::parallel"),
  perpendicular: t("constraint::perpendicular"),
  tangent: t("constraint::tangent"),
  equal: t("constraint::equal"),
  midpoint: t("constraint::midpoint"),
  point_on: t("constraint::point_on"),
  fix: t("constraint::fix"),
  symmetric: t("constraint::symmetric"),
  collinear: t("constraint::collinear"),
  coincident: t("constraint::coincident"),
};
const constraintName = (type: string) => CONSTRAINT_NAMES[type] ?? type;

/** Positions for dimension values and constraint glyphs (sketch coordinates). */
export function constraintLabels(
  sketch: SketchFeature,
  solved: SolvedSketch,
  onFace?: ((p: Vec2) => boolean) | null,
): Label[] {
  const out: Label[] = [];
  const P = (r: string) => solved.points.get(r);
  const curve = (id: string) => solved.curves.find((curve) => curve.id === id);

  const mid = (id: string): Vec2 | null => {
    const c = curve(id);
    if (!c) return null;
    if (c.kind === "line") return [(c.a[0] + c.b[0]) / 2, (c.a[1] + c.b[1]) / 2];
    if (c.kind === "circle") return [c.center[0], c.center[1] + c.radius];
    if (c.kind === "spline") return c.pts[Math.floor(c.pts.length / 2)] ?? null;

    const m = (c.a0 + c.a1) / 2 + (c.a1 < c.a0 ? Math.PI : 0);

    return [c.center[0] + c.radius * Math.cos(m), c.center[1] + c.radius * Math.sin(m)];
  };

  // Glyphs sharing a spot are fanned out along x (in sketch units, scaled by the sketch size).
  const size = Math.max(
    10,
    ...solved.curves.map((curve) =>
      curve.kind === "line" ? distance2(curve.a, curve.b) : curve.kind === "spline" ? 10 : curve.radius * 2,
    ),
  );
  const used = new Map<string, number>();

  const offset = (p: Vec2, key: string): Vec2 => {
    const n = used.get(key) ?? 0;
    used.set(key, n + 1);

    return [p[0] + n * size * 0.04, p[1] - size * 0.03];
  };

  // Lengths in an inch design are converted and say so; mm designs keep the bare number.
  const valueText = (expr: Expr, unit: string) =>
    typeof expr !== "number"
      ? `${expr}`
      : unit === "" && docUnit() === "in"
        ? fmtLen(expr)
        : `${fmt(expr)}${unit}`;

  // Lengths, distances and angles are drawn like a technical drawing's; their text sits on the line.
  const sizes = sizesFor(extentOf(solved.points.values()));
  const inside = middleOf(solved.points.values());

  for (const constraint of sketch.constraints) {
    if ("value" in constraint) {
      const drawing = dimensionDrawing(constraint, solved, sizes, inside, onFace);
      let at: Vec2 | null = drawing?.text.at ?? constraint.label ?? null;

      if (!at) {
        if (constraint.type === "length") {
          at = mid(constraint.line);
        } else if (constraint.type === "radius" || constraint.type === "diameter") {
          at = mid(constraint.curve);
        } else if (constraint.type === "angle") {
          // Between the two lines, on the arc of the angle.
          const pair = linePair(solved, constraint.a, constraint.b);
          const value = typeof constraint.value === "number" ? constraint.value : undefined;
          at = (pair && angleArc(pair[0], pair[1], null, value)?.label) ?? mid(constraint.a);
        } else if (constraint.type === "arc_angle") {
          // Inside the arc, halfway between its centre and its middle.
          const cv = curve(constraint.curve);
          const m = mid(constraint.curve);
          at =
            cv && (cv.kind === "arc" || cv.kind === "circle") && m
              ? [(cv.center[0] + m[0]) / 2, (cv.center[1] + m[1]) / 2]
              : m;
        } else if (constraint.type === "distance") {
          const a = P(constraint.a);
          const b = P(constraint.b) ?? mid(constraint.b);
          at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
        }
      }

      if (!at) continue;

      const unit = constraint.type === "angle" || constraint.type === "arc_angle" ? "°" : "";
      const prefix =
        constraint.type === "diameter"
          ? "⌀"
          : constraint.type === "radius"
            ? "R"
            : constraint.type === "arc_angle"
              ? "∠"
              : "";
      out.push({
        id: constraint.id,
        at,
        text: `${prefix}${valueText(constraint.value, unit)}`,
        title: t("{type} {id} — double-click to edit, Del to remove", {
          type: constraintName(constraint.type),
          id: constraint.id,
        }),
        dimension: true,
        ...(drawing
          ? {
              along: drawing.text.along,
              up: drawing.text.up,
              // A length's line drags; an angle's arc stays where it is.
              ...(constraint.type === "angle"
                ? {}
                : { line: [drawing.lines[0]!.a, drawing.lines[0]!.b] as [Vec2, Vec2] }),
            }
          : {}),
      });
      continue;
    }

    const g = GLYPH[constraint.type] ?? "?";
    let at: Vec2 | null = null;

    if (constraint.type === "horizontal" || constraint.type === "vertical") {
      at = mid(constraint.line);
    } else if (
      constraint.type === "parallel" ||
      constraint.type === "perpendicular" ||
      constraint.type === "tangent" ||
      constraint.type === "equal" ||
      constraint.type === "collinear"
    ) {
      at = mid(constraint.a);
    } else if (constraint.type === "midpoint") {
      at = P(constraint.point) ?? null;
    } else if (constraint.type === "point_on" || constraint.type === "fix") {
      at = P(constraint.type === "fix" ? constraint.point : constraint.point) ?? null;
    } else if (constraint.type === "symmetric") {
      at = mid(constraint.axis);
    } else if (constraint.type === "horizontal_points" || constraint.type === "vertical_points") {
      const a = P(constraint.a);
      const b = P(constraint.b);
      at = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
    } else if (constraint.type === "coincident") {
      continue;
    }

    if (!at) continue;

    const key = `${at[0].toFixed(3)},${at[1].toFixed(3)}`;
    out.push({
      id: constraint.id,
      at: offset(at, key),
      text: g,
      title: t("{type} ({id}) — click to select, Del to remove", {
        type: constraintName(constraint.type),
        id: constraint.id,
      }),
      dimension: false,
    });
  }

  return out;
}

/** Whether a constraint of one of these types already sits on the curve. */
type HasConstraint = (types: string[]) => boolean;

/** The chips with a new shape's size and angle, for the values that no constraint fixes yet. */
export function quickDimensions(sketch: SketchFeature, lastCurve: SolvedCurve): QuickDim[] {
  const has: HasConstraint = (types) =>
    sketch.constraints.some(
      (constraint) =>
        types.includes(constraint.type) &&
        ("line" in constraint
          ? constraint.line
          : "curve" in constraint
            ? constraint.curve
            : "a" in constraint
              ? constraint.a
              : "") === lastCurve.id,
    );

  if (lastCurve.kind === "line") return lineChips(lastCurve, has);
  // A spline is shaped by its points; dimension those.
  if (lastCurve.kind === "spline") return [];
  if (lastCurve.kind === "circle") return circleChips(lastCurve, has);

  return arcChips(lastCurve, has);
}

/** A line's length at its middle and its angle at its start. */
function lineChips(line: Extract<SolvedCurve, { kind: "line" }>, has: HasConstraint): QuickDim[] {
  const quick: QuickDim[] = [];
  const id = line.id;
  const [a, b] = [line.a, line.b];
  const len = distance2(a, b);
  const deg = ((((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI) % 180) + 180) % 180;

  if (!has(["length"])) {
    quick.push({
      key: "len",
      at: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
      text: fmtLen(len),
      value: len,
      length: true,
      make: (expr) => ({ type: "length", line: id, value: expr }),
    });
  }

  if (!has(["horizontal", "vertical", "angle"])) {
    quick.push({
      key: "ang",
      at: a,
      text: `∠ ${fmt(deg)}°`,
      value: +deg.toFixed(2),
      length: false,
      make: (expr) => ({ type: "angle", a: id, b: "origin.x", value: expr }),
    });
  }

  return quick;
}

/** A circle's diameter at its top. */
function circleChips(circle: Extract<SolvedCurve, { kind: "circle" }>, has: HasConstraint): QuickDim[] {
  if (has(["radius", "diameter"])) return [];

  const id = circle.id;

  return [
    {
      key: "dia",
      at: [circle.center[0], circle.center[1] + circle.radius],
      text: `⌀ ${fmtLen(circle.radius * 2)}`,
      value: circle.radius * 2,
      length: true,
      make: (expr: Expr) => ({ type: "diameter", curve: id, value: expr }),
    },
  ];
}

/** An arc's radius at its middle and its sweep at its centre. */
function arcChips(arc: Extract<SolvedCurve, { kind: "arc" }>, has: HasConstraint): QuickDim[] {
  const quick: QuickDim[] = [];
  const id = arc.id;
  const mid = arc.a0 + sweepOf(arc.a0, arc.a1) / 2;
  const sw = (sweepOf(arc.a0, arc.a1) * 180) / Math.PI;

  if (!has(["radius", "diameter"])) {
    quick.push({
      key: "rad",
      at: [arc.center[0] + arc.radius * Math.cos(mid), arc.center[1] + arc.radius * Math.sin(mid)],
      text: `R ${fmtLen(arc.radius)}`,
      value: arc.radius,
      length: true,
      make: (expr) => ({ type: "radius", curve: id, value: expr }),
    });
  }

  if (!has(["arc_angle"])) {
    quick.push({
      key: "sweep",
      at: arc.center,
      text: `∠ ${fmt(sw)}°`,
      value: +sw.toFixed(2),
      length: false,
      make: (expr) => ({ type: "arc_angle", curve: id, value: expr }),
    });
  }

  return quick;
}

/** Constraint types that already fix the angle between two lines. */
const ANGLE_FIXING = new Set(["angle", "parallel", "perpendicular", "collinear"]);

/**
 * The angle between two lines as a chip on its arc, for two lines picked together while nothing fixes
 * their angle yet; typing a value adds that angle dimension (with its value where the chip was). The
 * chip dragged to `label` measures the corner it lies in.
 */
export function pairAngle(
  sketch: SketchFeature,
  solved: Pick<SolvedSketch, "curves">,
  a: string,
  b: string,
  label?: Vec2 | null,
): QuickDim | null {
  const pair = linePair(solved, a, b);
  // The corner the value was dragged into (inside, outside, beside) is the angle measured.
  const arc = pair && angleArc(pair[0], pair[1], label);
  if (!arc) return null;

  const fixed = sketch.constraints.some(
    (constraint) =>
      ANGLE_FIXING.has(constraint.type) &&
      "a" in constraint &&
      "b" in constraint &&
      [constraint.a, constraint.b].sort().join() === [a, b].sort().join(),
  );
  if (fixed) return null;

  const degrees = +arc.degrees.toFixed(2);
  const placed: [number, number] = [+arc.label[0].toFixed(2), +arc.label[1].toFixed(2)];

  return {
    key: "pair-angle",
    at: arc.label,
    text: `${fmt(degrees)}°`,
    value: degrees,
    length: false,
    make: (expr) => ({ type: "angle", a, b, value: expr, label: placed }),
    angle: { arc, p: pair![0], q: pair![1] },
  };
}
