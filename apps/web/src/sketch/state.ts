import { create } from "zustand";

export type SketchTool =
  | "select"
  | "line"
  | "rect"
  | "rect_center"
  | "circle"
  | "arc"
  | "arc_center"
  | "polygon"
  | "spline"
  | "point"
  | "trim"
  | "fillet"
  | "chamfer"
  | "offset"
  | "pattern"
  | "dimension"
  | "project"
  | "section";

export type SketchSel =
  { kind: "point"; id: string } | { kind: "curve"; id: string } | { kind: "constraint"; id: string };

interface SketchUi {
  tool: SketchTool;
  construction: boolean;
  selection: SketchSel[];
  /** Radius, chamfer distance or offset for the corner and offset tools (mm; negative offsets go inwards). */
  editSize: number;
  /** How closely traced mesh sections follow the cut (mm). */
  traceTol: number;
  /** Polygon tool: how many corners (and sides) the next polygon gets. */
  polygonSides: number;
  /** Pattern tool: a row (dx, dy apart) or round the origin (angle apart), count in all. */
  pattern: { kind: "linear" | "circular"; count: number; dx: number; dy: number; angle: number };
}

/** The polygon tool's corners: a hexagon to start with, from a triangle up to a near-circle. */
export const POLYGON_SIDES_DEFAULT = 6;
export const POLYGON_SIDES_MIN = 3;
export const POLYGON_SIDES_MAX = 64;

export const useSketchUi = create<SketchUi>(() => ({
  tool: "line",
  construction: false,
  selection: [],
  editSize: 2,
  traceTol: 0.1,
  polygonSides: POLYGON_SIDES_DEFAULT,
  pattern: { kind: "linear", count: 3, dx: 10, dy: 0, angle: 60 },
}));

export const setTool = (tool: SketchTool) => useSketchUi.setState({ tool });
export const setSketchSelection = (selection: SketchSel[]) => useSketchUi.setState({ selection });
export const sameSel = (a: SketchSel, b: SketchSel) => a.kind === b.kind && a.id === b.id;
