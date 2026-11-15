/** Exact values typed while drawing: where they put the shape's free end, and how keys fill the fields. */
import { distance2, type Vec2 } from "@meercad/sketch";
import type { SketchTool } from "../state";
import { arcMidFor } from "./geometry";
import { isAngleField } from "./tools";
import type { Entry, ToolState } from "./types";

/** A typed field's value (lengths in the design's unit, angles in degrees), or null if it is unusable. */
export type ValueOf = (text: string | undefined, angle?: boolean) => number | null;

/** Where the typed values put the shape's free end or corner; null while nothing usable is typed. */
export function entryTarget(
  tool: SketchTool,
  entry: Entry | null,
  ts: Pick<ToolState, "points" | "cursor" | "sweep">,
  valueOf: ValueOf,
): Vec2 | null {
  if (!entry || !ts.points.length) return null;

  const a = ts.points[0]!.pos;
  const cur = ts.cursor && distance2(a, ts.cursor) > 1e-9 ? ts.cursor : ([a[0] + 1, a[1]] as Vec2);
  const toward = Math.atan2(cur[1] - a[1], cur[0] - a[0]);
  const [f0, f1] = [
    valueOf(entry.fields[0], isAngleField(tool, 0)),
    valueOf(entry.fields[1], isAngleField(tool, 1)),
  ];

  switch (tool) {
    case "line":
      return typedLineEnd(a, toward, f0, f1, !!entry.fields[1]?.trim());
    case "rect":
    case "rect_center":
      return typedRectCorner(a, cur, f0, f1, tool === "rect_center");
    case "circle":
      return typedCircleEdge(a, toward, f0);
    case "arc": {
      // Two ends placed: radius and/or angle give the arc's middle, on the cursor's side.
      const b = ts.points[1]?.pos;
      if (!b || (f0 === null && f1 === null)) return null;

      return arcMidFor(a, b, ts.cursor ?? b, f0 !== null && f0 > 0 ? f0 : null, f1);
    }
    case "arc_center": {
      const start = ts.points[1]?.pos;

      return start ? typedArcEnd(a, start, f0, ts.sweep) : null;
    }
    default:
      return null;
  }
}

/** A line's end from its length and angle; without a typed angle it points toward the cursor. */
function typedLineEnd(
  a: Vec2,
  toward: number,
  length: number | null,
  angleDeg: number | null,
  angleTyped: boolean,
): Vec2 | null {
  if (length === null || length <= 0) return null;

  const ang = angleTyped ? (angleDeg === null ? null : (angleDeg * Math.PI) / 180) : toward;

  return ang === null ? null : [a[0] + length * Math.cos(ang), a[1] + length * Math.sin(ang)];
}

/** A rectangle's free corner from width and height, toward the cursor; an untyped side follows it. */
function typedRectCorner(
  a: Vec2,
  cur: Vec2,
  width: number | null,
  height: number | null,
  centered: boolean,
): Vec2 | null {
  if ((width === null || width <= 0) && (height === null || height <= 0)) return null;

  const k = centered ? 0.5 : 1;
  const sx = Math.sign(cur[0] - a[0]) || 1;
  const sy = Math.sign(cur[1] - a[1]) || 1;

  return [
    width && width > 0 ? a[0] + sx * width * k : cur[0],
    height && height > 0 ? a[1] + sy * height * k : cur[1],
  ];
}

/** A point on the circle with the typed diameter, toward the cursor. */
function typedCircleEdge(center: Vec2, toward: number, diameter: number | null): Vec2 | null {
  return diameter === null || diameter <= 0
    ? null
    : [center[0] + (diameter / 2) * Math.cos(toward), center[1] + (diameter / 2) * Math.sin(toward)];
}

/** The end of an arc round `center` from `start` over the typed angle, in the direction moved so far. */
function typedArcEnd(center: Vec2, start: Vec2, angleDeg: number | null, sweep: number): Vec2 | null {
  if (angleDeg === null || angleDeg <= 0 || angleDeg >= 360) return null;

  const r = distance2(center, start);
  const end =
    Math.atan2(start[1] - center[1], start[0] - center[0]) +
    (sweep >= 0 ? 1 : -1) * ((angleDeg * Math.PI) / 180);

  return [center[0] + r * Math.cos(end), center[1] + r * Math.sin(end)];
}

/**
 * A key typed while drawing: the first one opens the fields (a digit goes into the first), Tab moves
 * between them and later digits go into the field that has the focus.
 */
export function typeIntoEntry(cur: Entry | null, key: string, shiftKey: boolean, fields: string[]): Entry {
  if (!cur) {
    return {
      fields: fields.map((_, i) => (i === 0 && key !== "Tab" ? key : "")),
      active: 0,
    };
  }

  if (key === "Tab") {
    return {
      ...cur,
      active: (cur.active + (shiftKey ? fields.length - 1 : 1)) % fields.length,
    };
  }

  return { ...cur, fields: cur.fields.map((f, i) => (i === cur.active ? f + key : f)) };
}
