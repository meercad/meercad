/** What the sketch tools do with clicks and typed values, and the hints and tips they show. */
import type { Vec2 } from "@meercad/sketch";
import { distance2 } from "@meercad/sketch";
import { t } from "../../lib/i18n";
import { fmtLen, inUnit } from "../../lib/units";
import { POLYGON_SIDES_DEFAULT, type SketchTool } from "../state";
import { arcThrough, fmt, normalizeAngle } from "./geometry";
import type { Snap } from "./types";

/** Tools that act on existing geometry under the cursor. */
export const EDIT_TOOLS = new Set<SketchTool>(["trim", "fillet", "chamfer", "offset"]);
/** Tools whose clicks place points (they show a dot where the next point lands). */
export const POINT_TOOLS = new Set<SketchTool>([
  "spline",
  "line",
  "rect",
  "rect_center",
  "circle",
  "arc",
  "arc_center",
  "polygon",
  "point",
]);
/** Tools that draw on press-drag-release as well as on two clicks. */
export const DRAG_TOOLS = new Set<SketchTool>(["line", "rect", "rect_center", "circle", "arc", "polygon"]);
/** Values that can be typed while drawing (start typing a number, Tab moves to the next field). */
export const ANGLE_FIELD = t("Angle °");
export const ENTRY_FIELDS: Partial<Record<SketchTool, string[]>> = {
  line: [t("Length"), ANGLE_FIELD],
  rect: [t("Width"), t("Height")],
  rect_center: [t("Width"), t("Height")],
  circle: [t("Diameter")],
  arc: [t("Radius"), ANGLE_FIELD],
  arc_center: [ANGLE_FIELD],
};
/** Tools whose typed values only apply once two points are placed (an arc's ends, or centre and start). */
export const ENTRY_AFTER_TWO = new Set<SketchTool>(["arc", "arc_center"]);
export const isAngleField = (tool: SketchTool, i: number) => ENTRY_FIELDS[tool]?.[i] === ANGLE_FIELD;

export const SNAP_LABEL: Record<NonNullable<Snap["kind"]>, string> = {
  point: t("Endpoint"),
  mid: t("Midpoint"),
  cross: t("Intersection"),
  curve: t("On curve"),
  align: t("Aligned"),
  grid: "",
  center: t("Center"),
  edge: t("On edge"),
};

export function toolHint(
  tool: SketchTool,
  n: number,
  dimFirst: boolean,
  sides = POLYGON_SIDES_DEFAULT,
): string {
  switch (tool) {
    case "line":
      return n
        ? t(
            "Click to continue · type a number for an exact length · double-click or Esc ends · click the start point to close",
          )
        : t("Click to start a line, or drag one out. Hold Alt (⌥) to place freely.");
    case "rect":
      return n
        ? t("Click the opposite corner, or type the width (Tab for the height)")
        : t("Click the first corner, or drag the rectangle out");
    case "rect_center":
      return n
        ? t("Click a corner, or type the width (Tab for the height)")
        : t("Click the center, or drag from the center out");
    case "circle":
      return n
        ? t("Click to set the size, or type the diameter")
        : t("Click the center, or drag the circle out");
    case "arc":
      return n === 0
        ? t("Click where the arc starts, or drag to its end")
        : n === 1
          ? t("Click where the arc ends")
          : t("Move to bend the arc and click · type the radius (Tab for the angle)");
    case "arc_center":
      return n === 0
        ? t("Click the arc center")
        : n === 1
          ? t("Click the start point")
          : t("Click the end point (move clockwise to flip) · type the angle");
    case "point":
      return t("Click to place a point");
    case "polygon":
      return n
        ? t("Click a corner ({n} corners; constraints keep it regular)", { n: sides })
        : t("Click the center · set the number of corners in the panel");
    case "spline":
      return n
        ? t("Click the next point · double-click, Enter or Esc finishes · click the first point to close")
        : t("Click where the smooth curve starts");
    case "trim":
      return t("Click the piece of a curve to cut away up to its nearest intersections");
    case "fillet":
      return t("Click a corner where two lines meet to round it with this radius");
    case "chamfer":
      return t("Click a corner where two lines meet to bevel it by this distance along each line");
    case "pattern":
      return t("Select the curves to repeat (Shift adds), set the pattern, then Repeat selection");
    case "offset":
      return t(
        "Click a line, arc or circle: its whole chain is copied at this distance (outwards for closed shapes, negative goes inwards)",
      );
    case "dimension":
      return dimFirst
        ? t(
            "Click a second entity, or click empty space to place the dimension (an arc: near its centre for the angle)",
          )
        : t("Click a line, circle, arc or point");
    case "project":
      return t("Click model edges to use them as fixed reference geometry");
    case "section":
      return t(
        "Click the orange line where the plane cuts a mesh: it becomes lines, arcs and circles within the tolerance. Raise it for rough scans.",
      );
    default:
      return t("Drag to move · Shift-click to multi-select · drag empty space to box-select · Del removes");
  }
}

/** Tools that pick existing geometry: they highlight what is under the cursor and do not snap. */
export const picksGeometry = (tool: SketchTool) =>
  tool === "select" || tool === "pattern" || tool === "dimension" || EDIT_TOOLS.has(tool);

/** The text beside the cursor while drawing: the shape's size so far, or what the cursor snapped to. */
export function drawingTip(
  tool: SketchTool,
  points: Snap[],
  snap: Snap,
  sides = POLYGON_SIDES_DEFAULT,
): string | null {
  if (tool === "line" && points.length) {
    const a = points[0]!.pos;
    const len = distance2(a, snap.pos);
    const ang = (Math.atan2(snap.pos[1] - a[1], snap.pos[0] - a[0]) * 180) / Math.PI;

    return `${fmtLen(len)}  ${fmt(((ang % 360) + 360) % 360)}°`;
  }

  if (tool === "arc" && points.length === 2) {
    const arc = arcThrough(points[0]!.pos, points[1]!.pos, snap.pos);

    return arc ? `R ${fmtLen(arc.radius)}  ∠ ${fmt((arc.sweep * 180) / Math.PI)}°` : null;
  }

  if (tool === "arc" && points.length === 1) return fmtLen(distance2(points[0]!.pos, snap.pos));

  if ((tool === "circle" || tool === "arc_center") && points.length) {
    return `R ${fmtLen(distance2(points[0]!.pos, snap.pos))}`;
  }

  if (tool === "polygon" && points.length) {
    return t("{n}-gon R {r}", { n: sides, r: fmtLen(distance2(points[0]!.pos, snap.pos)) });
  }

  if ((tool === "rect" || tool === "rect_center") && points.length) {
    const a = points[0]!.pos;
    const k = tool === "rect_center" ? 2 : 1;

    return `${inUnit(Math.abs(snap.pos[0] - a[0]) * k)} × ${fmtLen(Math.abs(snap.pos[1] - a[1]) * k)}`;
  }

  return snap.kind && snap.kind !== "grid" ? SNAP_LABEL[snap.kind] : null;
}

/**
 * The arc-centre tool's sweep once the cursor moved to `pos`, from the centre and the start point.
 * Unwrapped against the previous sweep, so arcs larger than 180° keep their direction.
 */
export function unwrapSweep(previous: number, center: Vec2, start: Vec2, pos: Vec2): number {
  const a0 = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const a1 = Math.atan2(pos[1] - center[1], pos[0] - center[0]);
  let d = a1 - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;

  const next = previous + (((d - normalizeAngle(previous) + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);

  return Math.abs(next) > 2 * Math.PI ? previous : next;
}
