import type { AngleArc, Segment } from "../../lib/angleDim";
/** Types the sketch editor's parts share. */
import type { Expr, SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { Vec2 } from "@meercad/sketch";
import type { SketchSel } from "../state";

export type Draft = Pick<SketchFeature, "entities" | "constraints">;
export type NewEntity = SketchEntity extends infer E ? (E extends unknown ? Omit<E, "id"> : never) : never;
export type NewConstraint = SketchConstraint extends infer C
  ? C extends unknown
    ? Omit<C, "id">
    : never
  : never;

export interface Snap {
  pos: Vec2;
  /** Existing point reference to reuse / constrain to. */
  point?: string;
  /** Curve the point lies on. */
  curve?: string;
  /** Second curve, for a snap onto the crossing of two curves. */
  curve2?: string;
  /** Line whose midpoint this is. */
  mid?: string;
  /** What the cursor locked onto, for the marker. */
  kind?: "point" | "mid" | "cross" | "curve" | "align" | "grid" | "center" | "edge";
  /** Dashed alignment guides, in sketch coordinates. */
  guides?: [Vec2, Vec2][];
}

/** What the active tool has collected so far; it lives in a ref and survives re-renders. */
export interface ToolState {
  points: Snap[];
  cursor: Vec2 | null;
  snap: Snap | null;
  sweep: number;
  dimFirst: SketchSel | null;
}

/** Values typed while drawing, and which field has the focus. */
export interface Entry {
  fields: string[];
  active: number;
}

/** The shape just drawn, whose size and angle show as chips. */
export interface LastShape {
  kind: "line" | "arc" | "circle";
  id: string;
}

/** A chip with a new shape's size or angle; tapping it fixes that value as a dimension. */
export interface QuickDim {
  key: string;
  at: Vec2;
  text: string;
  value: number;
  length: boolean;
  make: (expr: Expr) => NewConstraint;
  /** For an angle between two lines: its arc and the two lines, to draw it. */
  angle?: { arc: AngleArc; p: Segment; q: Segment };
}
