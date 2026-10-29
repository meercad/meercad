/**
 * Views for technical drawings: the parts projected along a view direction with hidden-line
 * removal (OCCT's exact HLR), split into visible and hidden lines, each line a polyline in the
 * view's plane (mm, x to the right, y up). Sharp edges and silhouettes (outlines of round faces)
 * are both drawn; tangent edges between smoothly joined faces are left out, as drawings do.
 */

import type { TopoDS_Shape } from "replicad-opencascadejs";
import { Arena } from "./arena.js";
import type { OC } from "./occt.js";
import type { ModelState } from "./state.js";

export type ViewName = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";
export type Polyline = [number, number][];

export interface DrawingView {
  name: ViewName;
  visible: Polyline[];
  hidden: Polyline[];
  /** Bounds of the visible lines in the view's plane. */
  min: [number, number];
  max: [number, number];
}

type V3 = [number, number, number];
/** Direction from the part towards the viewer, and the view's right-hand direction. */
const VIEWS: Record<ViewName, { eye: V3; right: V3 }> = {
  front: { eye: [0, -1, 0], right: [1, 0, 0] },
  back: { eye: [0, 1, 0], right: [-1, 0, 0] },
  top: { eye: [0, 0, 1], right: [1, 0, 0] },
  bottom: { eye: [0, 0, -1], right: [1, 0, 0] },
  left: { eye: [-1, 0, 0], right: [0, -1, 0] },
  right: { eye: [1, 0, 0], right: [0, 1, 0] },
  iso: { eye: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], right: [1 / Math.SQRT2, 1 / Math.SQRT2, 0] },
};

export function drawingViews(oc: OC, state: ModelState, names: readonly ViewName[], bodyIds?: string[]): DrawingView[] {
  const arena = new Arena();
  try {
    const bodies = [...state.bodies.values()].filter((b) => !bodyIds || bodyIds.includes(b.bodyId));
    if (!bodies.length) throw new Error("nothing to draw");
    // Hidden-line removal is exact and grows fast with the number of faces: imported meshes (a face
    // per triangle) would take minutes.
    const faces = bodies.reduce((n, b) => n + b.faces.length, 0);
    if (faces > 3000) throw new Error(`the parts have ${faces} faces, too many for a drawing (imported meshes are drawn after converting them to editable bodies)`);
    const builder = arena.track(new oc.TopoDS_Builder());
    const compound = arena.track(new oc.TopoDS_Compound());
    builder.MakeCompound(compound);
    for (const b of bodies) builder.Add(compound, b.shape);
    return names.map((name) => view(oc, arena, compound, name));
  } finally {
    arena.dispose();
  }
}

function view(oc: OC, arena: Arena, shape: TopoDS_Shape, name: ViewName): DrawingView {
  const { eye, right } = VIEWS[name];
  const ax = arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(0, 0, 0)), arena.track(new oc.gp_Dir(...eye)), arena.track(new oc.gp_Dir(...right))));
  const algo = arena.track(new oc.HLRBRep_Algo());
  algo.Add(shape, 0);
  algo.Projector(arena.track(new oc.HLRAlgo_Projector(ax)));
  algo.Update();
  algo.Hide();
  const hlr = arena.track(new oc.HLRBRep_HLRToShape(algo));
  const lines = (s: TopoDS_Shape | null) => (s && !s.IsNull() ? polylines(oc, arena, s) : []);
  const visible = [...lines(arena.track(hlr.VCompound())), ...lines(arena.track(hlr.OutLineVCompound()))];
  // Edges at the back that lie exactly behind visible ones would only draw dashes over solid lines.
  const hidden = [...lines(arena.track(hlr.HCompound())), ...lines(arena.track(hlr.OutLineHCompound()))].filter((h) => !covered(h, visible));
  const all = visible.flat();
  const min: [number, number] = all.length ? [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1]))] : [0, 0];
  const max: [number, number] = all.length ? [Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))] : [0, 0];
  return { name, visible, hidden, min, max };
}

/** The edges of a projected shape as polylines: straight edges by their ends, curves sampled finely. */
function polylines(oc: OC, arena: Arena, s: TopoDS_Shape): Polyline[] {
  const out: Polyline[] = [];
  for (const e = arena.track(new oc.TopExp_Explorer(s, "TopAbs_EDGE")); e.More(); e.Next()) {
    const edge = oc.TopoDS.Edge(arena.track(e.Current()));
    const c = arena.track(new oc.BRepAdaptor_Curve(edge));
    const [t0, t1] = [c.FirstParameter(), c.LastParameter()];
    const at = (t: number): [number, number] => {
      const p = arena.track(c.Value(t));
      return [p.X(), p.Y()];
    };
    if (c.GetType() === "GeomAbs_Line") {
      out.push([at(t0), at(t1)]);
      continue;
    }
    // About 0.2 mm per piece, at least 8 and at most 400 pieces.
    const a = at(t0), m = at((t0 + t1) / 2), b = at(t1);
    const approx = Math.hypot(m[0] - a[0], m[1] - a[1]) + Math.hypot(b[0] - m[0], b[1] - m[1]);
    const n = Math.max(8, Math.min(400, Math.ceil(approx / 0.2)));
    out.push(Array.from({ length: n + 1 }, (_, i) => at(t0 + ((t1 - t0) * i) / n)));
  }
  return out;
}

/** Whether every point of a line lies on one of the visible lines (within a hundredth of a millimetre). */
function covered(line: Polyline, visible: Polyline[]): boolean {
  const segs = visible.flatMap((v) => v.slice(1).map((b, k) => [v[k]!, b] as const));
  const probes = line.length === 2 ? [line[0]!, [(line[0]![0] + line[1]![0]) / 2, (line[0]![1] + line[1]![1]) / 2] as [number, number], line[1]!] : line;
  return probes.every((p) =>
    segs.some(([a, b]) => {
      const d: [number, number] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1)));
      return Math.hypot(a[0] + d[0] * t - p[0], a[1] + d[1] * t - p[1]) < 0.01;
    }),
  );
}
