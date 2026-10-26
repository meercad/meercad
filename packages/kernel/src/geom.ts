/** OCCT construction helpers: points, frames, sketch regions → faces, transforms. */

import type { LoopEdge, PlaneFrame, Region, Vec3 } from "@opencad/sketch";
import { toWorld } from "@opencad/sketch";
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex, gp_Trsf } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import type { OC } from "./occt.js";

export class Geom {
  constructor(
    readonly oc: OC,
    readonly arena: Arena,
  ) {}

  pnt(p: Vec3) {
    return this.arena.track(new this.oc.gp_Pnt(p[0], p[1], p[2]));
  }
  vec(v: Vec3) {
    return this.arena.track(new this.oc.gp_Vec(v[0], v[1], v[2]));
  }
  dir(v: Vec3) {
    return this.arena.track(new this.oc.gp_Dir(v[0], v[1], v[2]));
  }
  ax1(origin: Vec3, dir: Vec3) {
    return this.arena.track(new this.oc.gp_Ax1(this.pnt(origin), this.dir(dir)));
  }
  ax2(frame: PlaneFrame) {
    return this.arena.track(new this.oc.gp_Ax2(this.pnt(frame.origin), this.dir(frame.normal), this.dir(frame.u)));
  }
  vertex(p: Vec3): TopoDS_Vertex {
    return this.arena.track(this.arena.track(new this.oc.BRepBuilderAPI_MakeVertex(this.pnt(p))).Vertex());
  }

  /**
   * Faces for sketch regions. Returns, per face, the OCCT edge created for each named loop piece so
   * extrude/revolve history can name the side faces.
   */
  regionFaces(frame: PlaneFrame, regions: readonly Region[]): { face: TopoDS_Face; edges: { edge: TopoDS_Edge; name: string }[] }[] {
    return regions.map((r) => {
      const named: { edge: TopoDS_Edge; name: string }[] = [];
      const outer = this.wire(frame, r.outer, named);
      const pln = this.arena.track(new this.oc.gp_Pln(this.ax3(frame)));
      const mf = this.arena.track(new this.oc.BRepBuilderAPI_MakeFace(pln, outer, true));
      for (const h of r.holes) mf.Add(this.wire(frame, h, named));
      if (!mf.IsDone()) throw new Error(`could not build a face for region ${r.key}`);
      return { face: this.arena.track(mf.Face()), edges: named };
    });
  }

  private ax3(frame: PlaneFrame) {
    return this.arena.track(new this.oc.gp_Ax3(this.pnt(frame.origin), this.dir(frame.normal), this.dir(frame.u)));
  }

  private wire(frame: PlaneFrame, loop: readonly LoopEdge[], named: { edge: TopoDS_Edge; name: string }[]) {
    const oc = this.oc;
    const mw = this.arena.track(new oc.BRepBuilderAPI_MakeWire());
    // Shared vertices so consecutive edges connect without MakeWire rebuilding them.
    const starts = loop.map((e) => this.vertex(toWorld(frame, segStart(e))));
    loop.forEach((e, i) => {
      const v0 = starts[i]!;
      const v1 = starts[(i + 1) % loop.length]!;
      let edge: TopoDS_Edge;
      const s = e.seg;
      if (s.kind === "line") {
        edge = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(v0, v1)).Edge());
      } else {
        const center = toWorld(frame, s.center);
        const circ = this.arena.track(new oc.gp_Circ(this.arena.track(new oc.gp_Ax2(this.pnt(center), this.dir(frame.normal), this.dir(frame.u))), s.radius));
        if (s.kind === "circle") {
          edge = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
          if (!s.ccw) edge = this.arena.track(oc.TopoDS.Edge(this.arena.track(edge.Reversed())));
        } else if (s.ccw) {
          edge = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(circ, v0, v1)).Edge());
        } else {
          // Build the CCW arc v1 → v0 and traverse it backwards.
          const fwd = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(circ, v1, v0)).Edge());
          edge = this.arena.track(oc.TopoDS.Edge(this.arena.track(fwd.Reversed())));
        }
      }
      mw.Add(edge);
      named.push({ edge, name: e.name });
    });
    if (!mw.IsDone()) throw new Error("profile loop is not closed");
    return this.arena.track(mw.Wire());
  }

  translation(v: Vec3): gp_Trsf {
    const t = this.arena.track(new this.oc.gp_Trsf());
    t.SetTranslation(this.vec(v));
    return t;
  }
  rotation(origin: Vec3, axis: Vec3, deg: number): gp_Trsf {
    const t = this.arena.track(new this.oc.gp_Trsf());
    t.SetRotation(this.ax1(origin, axis), (deg * Math.PI) / 180);
    return t;
  }
  mirror(frame: PlaneFrame): gp_Trsf {
    const t = this.arena.track(new this.oc.gp_Trsf());
    t.SetMirror(this.ax2(frame));
    return t;
  }
  /** Transformed copy of a shape plus a mapping function for its sub-shapes. */
  transform(shape: TopoDS_Shape, trsf: gp_Trsf) {
    const tr = this.arena.track(new this.oc.BRepBuilderAPI_Transform(shape, trsf, true, false));
    return { shape: this.arena.track(tr.Shape()), map: (s: TopoDS_Shape) => this.arena.track(tr.ModifiedShape(s)) };
  }
}

function segStart(e: LoopEdge): [number, number] {
  const s = e.seg;
  if (s.kind === "line") return s.a;
  if (s.kind === "circle") return [s.center[0] + s.radius, s.center[1]];
  return [s.center[0] + s.radius * Math.cos(s.from), s.center[1] + s.radius * Math.sin(s.from)];
}
