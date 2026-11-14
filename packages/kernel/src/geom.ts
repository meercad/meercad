/** OCCT construction helpers: points, frames, sketch regions → faces, transforms. */

import type { LoopEdge, PlaneFrame, Region, Vec3 } from "@meercad/sketch";
import { toWorld } from "@meercad/sketch";
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex, gp_Trsf } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import type { OC } from "./occt.js";

export class Geom {
  /**
   * How closely (mm) spline edges follow the sketch's curve. 1 µm is far below anything printable;
   * a tighter fit gives about one pole per sample point, and lofts through such curves come out
   * broken. A loft that still fails tries again with a looser fit (see `loft` in the backend).
   */
  splineTolerance = 1e-3;

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
    return this.arena.track(
      new this.oc.gp_Ax2(this.pnt(frame.origin), this.dir(frame.normal), this.dir(frame.u)),
    );
  }

  vertex(p: Vec3): TopoDS_Vertex {
    return this.arena.track(this.arena.track(new this.oc.BRepBuilderAPI_MakeVertex(this.pnt(p))).Vertex());
  }

  /**
   * Faces for sketch regions. Returns, per face, the OCCT edge created for each named loop piece so
   * extrude/revolve history can name the side faces.
   */
  regionFaces(
    frame: PlaneFrame,
    regions: readonly Region[],
  ): { face: TopoDS_Face; edges: { edge: TopoDS_Edge; name: string }[] }[] {
    return regions.map((region) => {
      const named: { edge: TopoDS_Edge; name: string }[] = [];
      const outer = this.wire(frame, region.outer, named);
      const pln = this.arena.track(new this.oc.gp_Pln(this.ax3(frame)));
      const faceBuilder = this.arena.track(new this.oc.BRepBuilderAPI_MakeFace(pln, outer, true));
      for (const h of region.holes) faceBuilder.Add(this.wire(frame, h, named));
      if (!faceBuilder.IsDone()) throw new Error(`could not build a face for region ${region.key}`);

      return { face: this.arena.track(faceBuilder.Face()), edges: named };
    });
  }

  private ax3(frame: PlaneFrame) {
    return this.arena.track(
      new this.oc.gp_Ax3(this.pnt(frame.origin), this.dir(frame.normal), this.dir(frame.u)),
    );
  }

  /** A smooth B-spline edge through sketch points (fitted closely), between two vertices. */
  splineEdge(
    frame: PlaneFrame,
    pts: readonly [number, number][],
    vertex: TopoDS_Vertex,
    v1: TopoDS_Vertex,
  ): TopoDS_Edge {
    const oc = this.oc;
    const arr = this.arena.track(new oc.NCollection_Array1_gp_Pnt(1, pts.length));
    pts.forEach((p, k) => arr.SetValue(k + 1, this.pnt(toWorld(frame, p))));

    const fit = this.arena.track(
      new oc.GeomAPI_PointsToBSpline(arr, 3, 8, "GeomAbs_C2" as never, this.splineTolerance),
    );

    return this.arena.track(
      this.arena.track(new oc.BRepBuilderAPI_MakeEdge(this.arena.track(fit.Curve()), vertex, v1)).Edge(),
    );
  }

  private wire(frame: PlaneFrame, loop0: readonly LoopEdge[], named: { edge: TopoDS_Edge; name: string }[]) {
    const oc = this.oc;
    const wireBuilder = this.arena.track(new oc.BRepBuilderAPI_MakeWire());
    // Splines arrive as runs of short lines ("s1~0", "s1~1", …): each run becomes one smooth edge.
    // The loop is turned so that it does not start in the middle of a run.
    const base = (edge: LoopEdge) => (edge.curve.includes("~") ? edge.curve.split("~")[0]! : null);
    const cut = loop0.findIndex(
      (edge, i) => base(edge) === null || base(edge) !== base(loop0[(i - 1 + loop0.length) % loop0.length]!),
    );
    const loop = cut > 0 ? [...loop0.slice(cut), ...loop0.slice(0, cut)] : [...loop0];
    // Shared vertices so consecutive edges connect without MakeWire rebuilding them.
    const starts = loop.map((edge) => this.vertex(toWorld(frame, segStart(edge))));

    for (let i = 0; i < loop.length;) {
      const e = loop[i]!;
      const b = base(e);

      if (b !== null) {
        let j = i;
        while (j + 1 < loop.length && base(loop[j + 1]!) === b) j++;

        const pts = loop.slice(i, j + 1).map(segStart);
        const last = loop[j]!.seg;
        pts.push(last.kind === "line" ? last.b : segStart(loop[(j + 1) % loop.length]!));

        // A spline that is the whole loop goes in as two halves: an edge from a vertex back to itself
        // needs an exactly closed curve, which a fitted one is not.
        const halves: [number, number][] =
          i === 0 && j === loop.length - 1
            ? [
                [0, Math.floor(pts.length / 2)],
                [Math.floor(pts.length / 2), pts.length - 1],
              ]
            : [[0, pts.length - 1]];
        // One vertex where the halves meet, shared by both.
        const mid = halves.length > 1 ? this.vertex(toWorld(frame, pts[halves[0]![1]]!)) : null;

        for (const [from, to] of halves) {
          const vertex = from === 0 ? starts[i]! : mid!;
          const v1 = to === pts.length - 1 ? starts[(j + 1) % loop.length]! : mid!;
          const edge = this.splineEdge(frame, pts.slice(from, to + 1), vertex, v1);
          wireBuilder.Add(edge);
          named.push({ edge, name: b });
        }

        i = j + 1;
        continue;
      }

      const vertex = starts[i]!;
      const v1 = starts[(i + 1) % loop.length]!;
      let edge: TopoDS_Edge;
      const segment = e.seg;

      if (segment.kind === "line") {
        edge = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(vertex, v1)).Edge());
      } else {
        const center = toWorld(frame, segment.center);
        const circ = this.arena.track(
          new oc.gp_Circ(
            this.arena.track(new oc.gp_Ax2(this.pnt(center), this.dir(frame.normal), this.dir(frame.u))),
            segment.radius,
          ),
        );

        if (segment.kind === "circle") {
          edge = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
          if (!segment.ccw) edge = this.arena.track(oc.TopoDS.Edge(this.arena.track(edge.Reversed())));
        } else if (segment.ccw) {
          edge = this.arena.track(this.arena.track(new oc.BRepBuilderAPI_MakeEdge(circ, vertex, v1)).Edge());
        } else {
          // Build the CCW arc v1 → v0 and traverse it backwards.
          const fwd = this.arena.track(
            this.arena.track(new oc.BRepBuilderAPI_MakeEdge(circ, v1, vertex)).Edge(),
          );
          edge = this.arena.track(oc.TopoDS.Edge(this.arena.track(fwd.Reversed())));
        }
      }

      wireBuilder.Add(edge);
      named.push({ edge, name: e.name });
      i++;
    }

    if (!wireBuilder.IsDone()) throw new Error("profile loop is not closed");

    return this.arena.track(wireBuilder.Wire());
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

    return {
      shape: this.arena.track(tr.Shape()),
      map: (shape: TopoDS_Shape) => this.arena.track(tr.ModifiedShape(shape)),
    };
  }
}

function segStart(edge: LoopEdge): [number, number] {
  const segment = edge.seg;
  if (segment.kind === "line") return segment.a;
  if (segment.kind === "circle") return [segment.center[0] + segment.radius, segment.center[1]];

  return [
    segment.center[0] + segment.radius * Math.cos(segment.from),
    segment.center[1] + segment.radius * Math.sin(segment.from),
  ];
}
