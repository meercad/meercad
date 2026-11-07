/**
 * Small solid-building helpers shared by the generators (storage bins, labels, boxes, snap hooks):
 * everything is built in a local frame (z up from the plane) and then placed on the feature's plane,
 * the face names carried along.
 */

import { FeatureError } from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape, TopoDS_Wire, gp_Trsf } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import type { OC } from "./occt.js";

export type Box3 = { min: Vec3; max: Vec3 };

export class Builder {
  constructor(
    readonly oc: OC,
    readonly arena: Arena,
  ) {}
  private t<T>(x: T): T {
    return this.arena.track(x as never) as T;
  }
  pnt(x: number, y: number, z: number) {
    return this.t(new this.oc.gp_Pnt(x, y, z));
  }
  vertex(x: number, y: number, z: number) {
    return this.t(this.t(new this.oc.BRepBuilderAPI_MakeVertex(this.pnt(x, y, z))).Vertex());
  }
  /** Counter-clockwise rounded rectangle centred on (cx, cy) at height z. */
  roundedRect(cx: number, cy: number, w: number, h: number, r: number, z: number): TopoDS_Wire {
    const { oc } = this;
    r = Math.max(0, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4));
    const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
    const mw = this.t(new oc.BRepBuilderAPI_MakeWire());
    if (r < 1e-4) {
      const vs = [this.vertex(x0, y0, z), this.vertex(x1, y0, z), this.vertex(x1, y1, z), this.vertex(x0, y1, z)];
      vs.forEach((v, i) => mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % 4]!)).Edge())));
      return this.t(mw.Wire());
    }
    // Corners: centre, then the two ends of the arc (counter-clockwise).
    const corners: [number, number, [number, number], [number, number]][] = [
      [x1 - r, y0 + r, [x1 - r, y0], [x1, y0 + r]],
      [x1 - r, y1 - r, [x1, y1 - r], [x1 - r, y1]],
      [x0 + r, y1 - r, [x0 + r, y1], [x0, y1 - r]],
      [x0 + r, y0 + r, [x0, y0 + r], [x0 + r, y0]],
    ];
    const vs = corners.map(([, , a, b]) => [this.vertex(a[0], a[1], z), this.vertex(b[0], b[1], z)] as const);
    const dz = this.t(new oc.gp_Dir(0, 0, 1));
    const dx = this.t(new oc.gp_Dir(1, 0, 0));
    corners.forEach(([ccx, ccy], k) => {
      const circ = this.t(new oc.gp_Circ(this.t(new oc.gp_Ax2(this.pnt(ccx, ccy, z), dz, dx)), r));
      mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(circ, vs[k]![0], vs[k]![1])).Edge()));
      mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(vs[k]![1], vs[(k + 1) % 4]![0])).Edge()));
    });
    if (!mw.IsDone()) throw new FeatureError("could not build an outline");
    return this.t(mw.Wire());
  }
  /** Ruled loft through rounded rectangles: `profile` is [z, inset] pairs from the bottom up. */
  profileSolid(cx: number, cy: number, w: number, h: number, r: number, profile: [number, number][]): TopoDS_Shape {
    const { oc } = this;
    const loft = this.t(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
    for (const [z, d] of profile) loft.AddWire(this.roundedRect(cx, cy, w - 2 * d, h - 2 * d, r - d, z));
    loft.Build(this.t(new oc.Message_ProgressRange()));
    if (!loft.IsDone()) throw new FeatureError("could not build a sloped profile");
    return this.t(loft.Shape());
  }
  /** A rounded rectangle extruded from z0 to z1. */
  block(cx: number, cy: number, w: number, h: number, r: number, z0: number, z1: number): TopoDS_Shape {
    const face = this.t(this.t(new this.oc.BRepBuilderAPI_MakeFace(this.roundedRect(cx, cy, w, h, r, z0), true)).Face());
    return this.t(this.t(new this.oc.BRepPrimAPI_MakePrism(face, this.t(new this.oc.gp_Vec(0, 0, z1 - z0)), false, true)).Shape());
  }
  /** A closed polygon in the plane x = x0 (points as [y, z]) extruded along x to x1. */
  prismX(pts: [number, number][], x0: number, x1: number): TopoDS_Shape {
    const { oc } = this;
    const mw = this.t(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map(([y, z]) => this.vertex(x0, y, z));
    vs.forEach((v, i) => mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    const face = this.t(this.t(new oc.BRepBuilderAPI_MakeFace(this.t(mw.Wire()), true)).Face());
    return this.t(this.t(new oc.BRepPrimAPI_MakePrism(face, this.t(new oc.gp_Vec(x1 - x0, 0, 0)), false, true)).Shape());
  }  /** A closed polygon in the plane y = y0 (points as [x, z]) extruded along y to y1. */
  prismY(pts: [number, number][], y0: number, y1: number): TopoDS_Shape {
    const { oc } = this;
    const mw = this.t(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map(([x, z]) => this.vertex(x, y0, z));
    vs.forEach((v, i) => mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    const face = this.t(this.t(new oc.BRepBuilderAPI_MakeFace(this.t(mw.Wire()), true)).Face());
    return this.t(this.t(new oc.BRepPrimAPI_MakePrism(face, this.t(new oc.gp_Vec(0, y1 - y0, 0)), false, true)).Shape());
  }
  /** A closed polygon at height z as a wire. */
  polyWire(loop: [number, number][], z: number): TopoDS_Wire {
    const { oc } = this;
    const mw = this.t(new oc.BRepBuilderAPI_MakeWire());
    const vs = loop.map(([x, y]) => this.vertex(x, y, z));
    vs.forEach((v, i) => mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    return this.t(mw.Wire());
  }
  /** Ruled loft through polygons with the same number of corners, from the bottom up. */
  polyLoft(sections: { z: number; loop: [number, number][] }[]): TopoDS_Shape {
    const { oc } = this;
    const loft = this.t(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
    for (const s of sections) loft.AddWire(this.polyWire(s.loop, s.z));
    loft.Build(this.t(new oc.Message_ProgressRange()));
    if (!loft.IsDone()) throw new FeatureError("could not build a sloped profile");
    return this.t(loft.Shape());
  }
  /** A copy of a shape moved by (dx, dy, dz). */
  moved(s: TopoDS_Shape, dx: number, dy: number, dz: number): TopoDS_Shape {
    const tr = this.t(new this.oc.gp_Trsf());
    tr.SetTranslation(this.t(new this.oc.gp_Vec(dx, dy, dz)));
    return this.t(this.t(new this.oc.BRepBuilderAPI_Transform(s, tr, true, false)).Shape());
  }
  /** A copy of a shape turned about the x axis by `deg` degrees, then moved by (0, dy, dz). */
  turnedX(s: TopoDS_Shape, deg: number, dy: number, dz: number): TopoDS_Shape {
    const { oc } = this;
    const r = this.t(new oc.gp_Trsf());
    r.SetRotation(this.t(new oc.gp_Ax1(this.pnt(0, 0, 0), this.t(new oc.gp_Dir(1, 0, 0)))), (deg * Math.PI) / 180);
    const turned = this.t(this.t(new oc.BRepBuilderAPI_Transform(s, r, true, false)).Shape());
    return this.moved(turned, 0, dy, dz);
  }
  /** A cylinder along y through (x, z), from y0 to y1. */
  cylinderY(x: number, z: number, r: number, y0: number, y1: number): TopoDS_Shape {
    const ax = this.t(new this.oc.gp_Ax2(this.pnt(x, y0, z), this.t(new this.oc.gp_Dir(0, 1, 0))));
    return this.t(this.t(new this.oc.BRepPrimAPI_MakeCylinder(ax, r, y1 - y0)).Shape());
  }

  /** A cylinder along x through (y, z), from x0 to x1. */
  cylinderX(y: number, z: number, r: number, x0: number, x1: number): TopoDS_Shape {
    const ax = this.t(new this.oc.gp_Ax2(this.pnt(x0, y, z), this.t(new this.oc.gp_Dir(1, 0, 0))));
    return this.t(this.t(new this.oc.BRepPrimAPI_MakeCylinder(ax, r, x1 - x0)).Shape());
  }
  cylinderZ(x: number, y: number, r: number, z0: number, z1: number): TopoDS_Shape {
    const ax = this.t(new this.oc.gp_Ax2(this.pnt(x, y, z0), this.t(new this.oc.gp_Dir(0, 0, 1))));
    return this.t(this.t(new this.oc.BRepPrimAPI_MakeCylinder(ax, r, z1 - z0)).Shape());
  }
  /** A cone frustum about a vertical axis: its section turned once round. */
  coneZ(x: number, y: number, r0: number, r1: number, z0: number, z1: number): TopoDS_Shape {
    const { oc } = this;
    const vs = [this.vertex(x, y, z0), this.vertex(x + r0, y, z0), this.vertex(x + r1, y, z1), this.vertex(x, y, z1)];
    const mw = this.t(new oc.BRepBuilderAPI_MakeWire());
    vs.forEach((v, i) => mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % 4]!)).Edge())));
    const face = this.t(this.t(new oc.BRepBuilderAPI_MakeFace(this.t(mw.Wire()), true)).Face());
    const axis = this.t(new oc.gp_Ax1(this.pnt(x, y, z0), this.t(new oc.gp_Dir(0, 0, 1))));
    const rev = this.t(new oc.BRepPrimAPI_MakeRevol(face, axis, 2 * Math.PI, false));
    if (!rev.IsDone()) throw new FeatureError("could not build a countersink");
    return this.t(rev.Shape());
  }
  /** A polygon face at height z (points as [x, y]), with holes. */
  polyFace(outer: [number, number][], holes: [number, number][][], z: number) {
    const { oc } = this;
    const wire = (loop: [number, number][]) => {
      const mw = this.t(new oc.BRepBuilderAPI_MakeWire());
      const vs = loop.map(([x, y]) => this.vertex(x, y, z));
      vs.forEach((v, i) => mw.Add(this.t(this.t(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
      return this.t(mw.Wire());
    };
    const mf = this.t(new oc.BRepBuilderAPI_MakeFace(wire(outer), true));
    for (const h of holes) mf.Add(wire(h));
    if (!mf.IsDone()) return null;
    return this.t(mf.Face());
  }
  prismZ(face: TopoDS_Shape, h: number): TopoDS_Shape {
    return this.t(this.t(new this.oc.BRepPrimAPI_MakePrism(face, this.t(new this.oc.gp_Vec(0, 0, h)), false, true)).Shape());
  }
  /** One boolean of a shape with many tools. */
  bool(kind: "fuse" | "cut", target: TopoDS_Shape, tools: TopoDS_Shape[]): TopoDS_Shape {
    if (!tools.length) return target;
    const { oc } = this;
    const algo = this.t(kind === "fuse" ? new oc.BRepAlgoAPI_Fuse() : new oc.BRepAlgoAPI_Cut());
    const list = (shapes: TopoDS_Shape[]) => {
      const l = this.t(new oc.NCollection_List_TopoDS_Shape());
      for (const s of shapes) l.Append(s);
      return l;
    };
    algo.SetArguments(list([target]));
    algo.SetTools(list(tools));
    algo.SetFuzzyValue(1e-5);
    algo.Build(this.t(new oc.Message_ProgressRange()));
    if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(`could not ${kind === "fuse" ? "join" : "cut"} the shape`);
    return this.t(algo.Shape());
  }
  unify(s: TopoDS_Shape): TopoDS_Shape {
    const u = this.t(new this.oc.ShapeUpgrade_UnifySameDomain(s, true, true, false));
    u.Build();
    return this.t(u.Shape());
  }
  compound(shapes: TopoDS_Shape[]): TopoDS_Shape {
    const b = this.t(new this.oc.TopoDS_Builder());
    const c = this.t(new this.oc.TopoDS_Compound());
    b.MakeCompound(c);
    for (const s of shapes) b.Add(c, s);
    return c;
  }
  /** Moves a shape built in the local frame (z up) onto the plane at `position`, turned by `angle`. */
  placement(frame: PlaneFrame, position: [number, number], angle = 0): gp_Trsf {
    const { oc } = this;
    const a = (angle * Math.PI) / 180;
    const o = toWorld(frame, position);
    const u: Vec3 = [0, 1, 2].map((i) => Math.cos(a) * frame.u[i]! + Math.sin(a) * frame.v[i]!) as Vec3;
    const to = this.t(new oc.gp_Ax3(this.pnt(...o), this.t(new oc.gp_Dir(...frame.normal)), this.t(new oc.gp_Dir(...u))));
    const from = this.t(new oc.gp_Ax3(this.pnt(0, 0, 0), this.t(new oc.gp_Dir(0, 0, 1)), this.t(new oc.gp_Dir(1, 0, 0))));
    const tr = this.t(new oc.gp_Trsf());
    tr.SetDisplacement(from, to);
    return tr;
  }
  /** The local body moved by `trsf`, its face names carried along. */
  place(local: Body, trsf: gp_Trsf, id: string): Body {
    const tr = this.t(new this.oc.BRepBuilderAPI_Transform(local.shape, trsf, true, false));
    const out = new Body(this.oc, this.arena, id, this.t(tr.Shape()));
    const tags: string[][] = out.faces.map(() => []);
    local.faces.forEach((face, i) => {
      const j = out.faceIndex(this.t(tr.ModifiedShape(face)));
      if (j >= 0) tags[j] = [...(local.faceTags[i] ?? [])];
    });
    out.faceTags = tags.map((t, i) => (t.length ? t : [`${id}.face[${i}]`]));
    return out;
  }
}
