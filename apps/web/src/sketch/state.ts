import { create } from "zustand";

export type SketchTool = "select" | "line" | "rect" | "rect_center" | "circle" | "arc" | "point" | "dimension" | "project";

export type SketchSel = { kind: "point"; id: string } | { kind: "curve"; id: string } | { kind: "constraint"; id: string };

interface SketchUi {
  tool: SketchTool;
  construction: boolean;
  selection: SketchSel[];
}

export const useSketchUi = create<SketchUi>(() => ({ tool: "line", construction: false, selection: [] }));

export const setTool = (tool: SketchTool) => useSketchUi.setState({ tool });
export const setSketchSelection = (selection: SketchSel[]) => useSketchUi.setState({ selection });
export const sameSel = (a: SketchSel, b: SketchSel) => a.kind === b.kind && a.id === b.id;
