import { create } from "zustand";

export type SketchTool = "select" | "line" | "rect" | "rect_center" | "circle" | "arc" | "arc_center" | "polygon" | "point" | "trim" | "fillet" | "chamfer" | "offset" | "dimension" | "project";

export type SketchSel = { kind: "point"; id: string } | { kind: "curve"; id: string } | { kind: "constraint"; id: string };

interface SketchUi {
  tool: SketchTool;
  construction: boolean;
  selection: SketchSel[];
  /** Radius, chamfer distance or offset for the corner and offset tools (mm; negative offsets go inwards). */
  editSize: number;
}

export const useSketchUi = create<SketchUi>(() => ({ tool: "line", construction: false, selection: [], editSize: 2 }));

export const setTool = (tool: SketchTool) => useSketchUi.setState({ tool });
export const setSketchSelection = (selection: SketchSel[]) => useSketchUi.setState({ selection });
export const sameSel = (a: SketchSel, b: SketchSel) => a.kind === b.kind && a.id === b.id;
