/**
 * Standard parts as solids: the stacked rings of a StandardShape turned about the part's axis
 * (round, or hexagonal for nuts), their holes cut out, and a hex socket in a screw's head.
 * Faces are tagged by role: np1.head, np1.shank, np1.side, np1.top, np1.bottom, np1.bore, np1.socket.
 */

import { FeatureError, type StandardShape } from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import type { OC } from "./occt.js";

export function standardPartBody(oc: OC, arena: Arena, id: string, frame: PlaneFrame, at: [number, number], shape: StandardShape, flip: boolean): Body {
  const a: Vec3 = flip ? [-frame.normal[0], -frame.normal[1], -frame.normal[2]] : frame.normal;
  const c = toWorld(frame, at);
  const along = (t: number): Vec3 => [c[0] + a[0] * t, c[1] + a[1] * t, c[2] + a[2] * t];
  const pnt = (p: Vec3) => arena.track(new oc.gp_Pnt(...p));
  const ax = (t: number) => arena.track(new oc.gp_Ax2(pnt(along(t)), arena.track(new oc.gp_Dir(...a)), arena.track(new oc.gp_Dir(...frame.u))));
  const cylinder = (r: number, from: number, to: number): TopoDS_Shape => arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax(from), r, to - from)).Shape());
  // A hexagonal prism, flats parallel to the plane's u axis.
  const hexPrism = (across: number, from: number, to: number): TopoDS_Shape => {
    const R = across / Math.sqrt(3);
    const v = frame.v;
    const base = along(from);
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = Array.from({ length: 6 }, (_, k) => {
      const ang = (k * Math.PI) / 3;
      const p: Vec3 = [0, 1, 2].map((i) => base[i]! + R * (Math.cos(ang) * frame.u[i]! + Math.sin(ang) * v[i]!)) as Vec3;
      return arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt(p))).Vertex());
    });
    vs.forEach((x, k) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(x, vs[(k + 1) % 6]!)).Edge())));
    const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face());
    const h = to - from;
    return arena.track(arena.track(new oc.BRepPrimAPI_MakePrism(face, arena.track(new oc.gp_Vec(a[0] * h, a[1] * h, a[2] * h)), false, true)).Shape());
  };
  const bool = (kind: "fuse" | "cut", x: TopoDS_Shape, y: TopoDS_Shape): TopoDS_Shape => {
    const op = kind === "fuse" ? arena.track(new oc.BRepAlgoAPI_Fuse(x, y)) : arena.track(new oc.BRepAlgoAPI_Cut(x, y));
    if (!op.IsDone() || op.HasErrors()) throw new FeatureError(`could not build the ${shape.label}`);
    return arena.track(op.Shape());
  };
  let solid: TopoDS_Shape | null = null;
  shape.rings.forEach((ring, k) => {
    let s = shape.hex?.ring === k ? hexPrism(shape.hex.across, ring.from, ring.to) : cylinder(ring.r, ring.from, ring.to);
    if (ring.hole > 0) s = bool("cut", s, cylinder(ring.hole, ring.from - 1, ring.to + 1));
    solid = solid ? bool("fuse", solid, s) : s;
  });
  if (shape.socket) solid = bool("cut", solid!, hexPrism(shape.socket.key, shape.socket.top - shape.socket.depth, shape.socket.top + 1));
  // Faces sharing a solid's plane get merged (head and shank meet in one plane).
  const unify = arena.track(new oc.ShapeUpgrade_UnifySameDomain(solid!, true, true, false));
  unify.Build();
  const body = new Body(oc, arena, id, arena.track(unify.Shape()));
  const top = Math.max(...shape.rings.map((r) => r.to)), bottom = Math.min(...shape.rings.map((r) => r.from));
  body.faceTags = body.faces.map((f, i) => {
    const p = body.facePoints[i]!;
    const t = (p[0] - c[0]) * a[0] + (p[1] - c[1]) * a[1] + (p[2] - c[2]) * a[2];
    const radial = Math.hypot(p[0] - c[0] - a[0] * t, p[1] - c[1] - a[1] * t, p[2] - c[2] - a[2] * t);
    const info = body.faceInfo[i]!;
    const flat = info.planar && info.normal && Math.abs(info.normal[0] * a[0] + info.normal[1] * a[1] + info.normal[2] * a[2]) > 0.99;
    const name = (part: string) => [`${id}.${part}`];
    if (flat) {
      if (Math.abs(t - top) < 1e-6) return name("top");
      if (Math.abs(t - bottom) < 1e-6) return name("bottom");
      return name(shape.socket && Math.abs(t - (shape.socket.top - shape.socket.depth)) < 1e-6 ? "socket" : "seat");
    }
    if (shape.socket && t > shape.socket.top - shape.socket.depth - 1e-6 && radial < shape.socket.key) return name("socket");
    const ring = shape.rings.find((r) => t >= r.from - 1e-6 && t <= r.to + 1e-6);
    if (ring && ring.hole > 0 && radial < (ring.hole + ring.r) / 2) return name("bore");
    if (shape.socket) return name(t > 1e-6 ? "head" : "shank");
    void f;
    return name("side");
  });
  return body;
}
