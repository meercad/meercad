/**
 * Standard parts as solids: the stacked rings of a StandardShape turned about the part's axis
 * (round, a cone for a countersunk head, or hexagonal for nuts and hex heads), their holes cut out,
 * and a hex socket in a screw's head.
 * Faces are tagged by role: np1.head, np1.shank, np1.side, np1.top, np1.bottom, np1.bore, np1.socket;
 * parts lying along u (rails, brackets) also np1.end and np1.left / np1.right (the faces facing ±v).
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
  // A cone frustum: its section (axis, r1 at `from`, r2 at `to`) turned about the axis.
  const cone = (r1: number, r2: number, from: number, to: number): TopoDS_Shape => {
    const at = (rad: number, t: number): Vec3 => [0, 1, 2].map((i) => c[i]! + a[i]! * t + frame.u[i]! * rad) as Vec3;
    const pts = [at(0, from), at(r1, from), at(r2, to), at(0, to)];
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map((p) => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt(p))).Vertex()));
    vs.forEach((v0, i) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v0, vs[(i + 1) % vs.length]!)).Edge())));
    const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face());
    const rev = arena.track(new oc.BRepPrimAPI_MakeRevol(face, arena.track(new oc.gp_Ax1(pnt(c), arena.track(new oc.gp_Dir(...a)))), 2 * Math.PI, false));
    if (!rev.IsDone()) throw new FeatureError(`could not build the ${shape.label}`);
    return arena.track(rev.Shape());
  };
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
  // A point given in (u, v, up the axis).
  const world = (x: number, y: number, t: number): Vec3 => [0, 1, 2].map((i) => c[i]! + frame.u[i]! * x + frame.v[i]! * y + a[i]! * t) as Vec3;
  const vec = (d: [number, number, number]): Vec3 => [0, 1, 2].map((i) => frame.u[i]! * d[0] + frame.v[i]! * d[1] + a[i]! * d[2]) as Vec3;
  const polyFace = (pts: Vec3[]) => {
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map((p) => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt(p))).Vertex()));
    vs.forEach((x, k) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(x, vs[(k + 1) % vs.length]!)).Edge())));
    return arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face());
  };
  const prismOf = (outline: [number, number][], along: "axis" | "u", from: number, to: number): TopoDS_Shape => {
    // Along the axis: the outline in (u, v); lying: in (v, axis), pushed along u.
    const pts = outline.map(([x, y]) => (along === "axis" ? world(x, y, from) : world(from, x, y)));
    const d = along === "axis" ? vec([0, 0, to - from]) : vec([to - from, 0, 0]);
    const pr = arena.track(new oc.BRepPrimAPI_MakePrism(polyFace(pts), arena.track(new oc.gp_Vec(...d)), false, true));
    if (!pr.IsDone()) throw new FeatureError(`could not build the ${shape.label}`);
    return arena.track(pr.Shape());
  };
  const drill = (at: Vec3, dir: Vec3, r: number, depth: number): TopoDS_Shape => {
    const n = Math.hypot(...dir);
    const ax2 = arena.track(new oc.gp_Ax2(pnt(at), arena.track(new oc.gp_Dir(dir[0] / n, dir[1] / n, dir[2] / n))));
    return arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax2, r, depth)).Shape());
  };
  let solid: TopoDS_Shape | null = null;
  for (const pr of shape.prisms ?? []) {
    let s = prismOf(pr.outline, pr.along, pr.from, pr.to);
    for (const cutout of pr.cuts ?? []) {
      // Cut-outs run a little past both ends, so they open the part cleanly.
      const tool = "poly" in cutout ? prismOf(cutout.poly, pr.along, pr.from - 1, pr.to + 1) : pr.along === "axis" ? drill(world(cutout.circle[0], cutout.circle[1], pr.from - 1), a, cutout.circle[2], pr.to - pr.from + 2) : drill(world(pr.from - 1, cutout.circle[0], cutout.circle[1]), frame.u, cutout.circle[2], pr.to - pr.from + 2);
      s = bool("cut", s, tool);
    }
    solid = solid ? bool("fuse", solid, s) : s;
  }
  shape.rings.forEach((ring, k) => {
    let s = shape.hex?.ring === k ? hexPrism(shape.hex.across, ring.from, ring.to) : ring.r2 !== undefined ? cone(ring.r, ring.r2, ring.from, ring.to) : cylinder(ring.r, ring.from, ring.to);
    if (ring.hole > 0) s = bool("cut", s, cylinder(ring.hole, ring.from - 1, ring.to + 1));
    solid = solid ? bool("fuse", solid, s) : s;
  });
  if (shape.socket) solid = bool("cut", solid!, hexPrism(shape.socket.key, shape.socket.top - shape.socket.depth, shape.socket.top + 1));
  for (const d of shape.drills ?? []) {
    const at = world(...d.at), dir = vec(d.dir);
    solid = bool("cut", solid!, drill(at, dir, d.r, d.depth));
    if (d.cb) solid = bool("cut", solid!, drill(at, dir, d.cb.r, d.cb.depth));
  }
  // Faces sharing a solid's plane get merged (head and shank meet in one plane).
  const unify = arena.track(new oc.ShapeUpgrade_UnifySameDomain(solid!, true, true, false));
  unify.Build();
  const body = new Body(oc, arena, id, arena.track(unify.Shape()));
  const axial = [...shape.rings.map((r) => [r.from, r.to]), ...(shape.prisms ?? []).filter((p) => p.along === "axis").map((p) => [p.from, p.to])].flat();
  const top = axial.length ? Math.max(...axial) : NaN, bottom = axial.length ? Math.min(...axial) : NaN;
  const lying = (shape.prisms ?? []).filter((p) => p.along === "u");
  body.faceTags = body.faces.map((f, i) => {
    const p = body.facePoints[i]!;
    const t = (p[0] - c[0]) * a[0] + (p[1] - c[1]) * a[1] + (p[2] - c[2]) * a[2];
    const radial = Math.hypot(p[0] - c[0] - a[0] * t, p[1] - c[1] - a[1] * t, p[2] - c[2] - a[2] * t);
    const info = body.faceInfo[i]!;
    const flat = info.planar && info.normal && Math.abs(info.normal[0] * a[0] + info.normal[1] * a[1] + info.normal[2] * a[2]) > 0.99;
    const name = (part: string) => [`${id}.${part}`];
    if (lying.length && info.planar && info.normal) {
      // Lying parts (rails, brackets): the face on the plane, the ends, the top, the sides.
      const along = (p[0] - c[0]) * frame.u[0] + (p[1] - c[1]) * frame.u[1] + (p[2] - c[2]) * frame.u[2];
      const nu = Math.abs(info.normal[0] * frame.u[0] + info.normal[1] * frame.u[1] + info.normal[2] * frame.u[2]);
      if (nu > 0.99 && lying.some((l) => Math.abs(along - l.from) < 1e-6 || Math.abs(along - l.to) < 1e-6)) return name("end");
      if (flat && Math.abs(t) < 1e-6) return name("bottom");
      if (flat && Math.abs(t - Math.max(...lying.flatMap((l) => l.outline.map((q) => q[1])))) < 1e-6) return name("top");
      // Faces facing straight sideways: left and right (a rail's top meets each in one edge).
      const nv = info.normal[0] * frame.v[0] + info.normal[1] * frame.v[1] + info.normal[2] * frame.v[2];
      if (Math.abs(nv) > 0.99) return name(nv > 0 ? "left" : "right");
    }
    if (flat) {
      if (Math.abs(t - top) < 1e-6) return name("top");
      if (Math.abs(t - bottom) < 1e-6) return name("bottom");
      return name(shape.socket && Math.abs(t - (shape.socket.top - shape.socket.depth)) < 1e-6 ? "socket" : "seat");
    }
    if (shape.socket && t > shape.socket.top - shape.socket.depth - 1e-6 && radial < shape.socket.key) return name("socket");
    const ring = shape.rings.find((r) => t >= r.from - 1e-6 && t <= r.to + 1e-6);
    if (ring && ring.hole > 0 && radial < (ring.hole + ring.r) / 2) return name("bore");
    // Where two sections meet, the face belongs to the one it lies on: between their radii.
    const on = shape.rings.filter((r) => t >= r.from - 1e-6 && t <= r.to + 1e-6).find((r) => r.role && t > r.from + 1e-6 && t < r.to - 1e-6);
    if (on?.role) return name(on.role);
    void f;
    return name("side");
  });
  return body;
}
