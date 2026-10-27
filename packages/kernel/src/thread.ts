/**
 * Modelled ISO metric threads. A trapezoid groove (ISO 68-1 flanks, 60°) is swept along a helix
 * around the cylinder's axis, clipped to the threaded length and cut from the body. The thread's
 * own diameters win over the drawn ones: a hole is filled to the minor diameter first if it was drawn
 * at the nominal size, a shaft is trimmed to (or grown to) the major diameter.
 */

import { externalMinor, FeatureError, internalMinor, threadFor, type ResolvedThread } from "@meercad/model";
import { resolveFaces } from "@meercad/naming";
import type { TopoDS_Shape, TopoDS_Wire } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { booleanBodies } from "./boolean.js";
import { occtErrorMessage, type OC } from "./occt.js";

type V = [number, number, number];
const add = (p: V, q: V, s = 1): V => [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];
const dot = (p: V, q: V) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const TAN30 = Math.tan(Math.PI / 6);

export interface ThreadInfo {
  size: string;
  pitch: number;
  internal: boolean;
  length: number;
}

export function threadBody(oc: OC, arena: Arena, bodies: ReadonlyMap<string, Body>, f: ResolvedThread): { body: Body; info: ThreadInfo } {
  const refs = resolveFaces(f.face, [...bodies.values()]);
  const count = refs.reduce((n, r) => n + r.faces.length, 0);
  if (count !== 1) throw new FeatureError(`the face selector matches ${count} faces; pick exactly one cylindrical face`);
  const input = bodies.get(refs[0]!.body)!;
  const fi = refs[0]!.faces[0]!;
  const face = input.faces[fi]!;

  const surf = arena.track(new oc.BRepAdaptor_Surface(face, true));
  if (surf.GetType() !== "GeomAbs_Cylinder") throw new FeatureError("threads go on round faces: a hole or a shaft", "select the cylindrical wall");
  const cyl = arena.track(surf.Cylinder());
  const pos = arena.track(cyl.Position());
  const loc = arena.track(pos.Location());
  const dirG = arena.track(pos.Direction());
  const o: V = [loc.X(), loc.Y(), loc.Z()];
  const a: V = [dirG.X(), dirG.Y(), dirG.Z()];
  const radius = cyl.Radius();
  // Material on the axis side means a shaft; on the outside, a hole.
  const internal = (face.Orientation() === "TopAbs_REVERSED") === pos.Direct();

  // Axial extent of the face and which of its ends are open (the thread runs out there).
  const ts: number[] = [];
  const ex = arena.track(new oc.TopExp_Explorer(face, "TopAbs_VERTEX"));
  for (; ex.More(); ex.Next()) {
    const p = arena.track(oc.BRep_Tool.Pnt(arena.track(oc.TopoDS.Vertex(arena.track(ex.Current())))));
    ts.push(dot([p.X() - o[0], p.Y() - o[1], p.Z() - o[2]], a));
  }
  if (!ts.length) throw new FeatureError("could not find the ends of this face");
  const t0 = Math.min(...ts);
  const t1 = Math.max(...ts);
  const full = t1 - t0;
  if (!(full > 1e-6)) throw new FeatureError("the cylindrical face has no length");
  const open = [true, true];
  // Run-out past the end only into free space: a chamfer or rounded edge there stops the groove at
  // the face's edge (OCCT cannot intersect the groove with the cone reliably, and it reads better).
  const free = [true, true];
  input.edgeFaces.forEach((adj, ei) => {
    if (!adj.includes(fi)) return;
    const p = input.edgePoints[ei]!;
    const t = dot([p[0] - o[0], p[1] - o[1], p[2] - o[2]], a);
    const end = Math.abs(t - t0) < 1e-4 * Math.max(1, full) ? 0 : Math.abs(t - t1) < 1e-4 * Math.max(1, full) ? 1 : -1;
    if (end < 0) return;
    for (const nb of adj) {
      if (nb === fi) continue;
      const info = input.faceInfo[nb]!;
      // A planar neighbour whose outside faces back along the face is a shoulder or a hole bottom.
      if (info.planar && info.normal && dot(info.normal, a) * (end === 0 ? -1 : 1) < 0.3) open[end] = false;
      if (!info.planar) free[end] = false;
    }
  });

  let spec: { size: string; d: number; pitch: number };
  try {
    spec = threadFor(radius * 2, internal, f.size, f.pitch);
  } catch (e) {
    throw new FeatureError(e instanceof Error ? e.message : String(e));
  }
  const P = spec.pitch;
  const R = spec.d / 2;
  if (!(P > 0) || P > R) throw new FeatureError(`pitch ${P} mm does not fit ${spec.size}`);
  const c = f.clearance ?? 0;
  if (c < 0 || c > P / 4) throw new FeatureError(`clearance must be between 0 and ${(P / 4).toFixed(2)} mm for this pitch`);
  const length = Math.min(f.length ?? full, full);
  if (!(length > 0)) throw new FeatureError("thread length must be greater than zero");

  // Threads start at an open end (the top one if both are open) and run `length` along the face.
  const fromTop = open[1] || !open[0];
  const lo = fromTop ? t1 - length : t0;
  const hi = fromTop ? t1 : t0 + length;
  const runOutLo = open[0] && free[0] && lo <= t0 + 1e-9;
  const runOutHi = open[1] && free[1] && hi >= t1 - 1e-9;
  const zLo = lo - (runOutLo ? P : 0);
  const zHi = hi + (runOutHi ? P : 0);

  // Seams: OCCT can miss the groove/cylinder intersection (the cut then silently removes nothing)
  // depending on where the helix starts relative to the cylinders' seam. A quarter turn from the
  // seam works, on a side that depends on the thread; the other side is tried if the cut misses.
  // Our helper cylinders share the face's seam direction.
  // The face's seam sits at its first u parameter, which need not be the surface's x direction.
  const xd = arena.track(pos.XDirection());
  const yd = arena.track(pos.YDirection());
  const u0 = surf.FirstUParameter();
  const xdir: V = add([xd.X() * Math.cos(u0), xd.Y() * Math.cos(u0), xd.Z() * Math.cos(u0)], [yd.X(), yd.Y(), yd.Z()], Math.sin(u0));
  const cross = (p: V, q: V): V => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const starts = internal !== !!f.leftHanded ? [cross(xdir, a), cross(a, xdir)] : [cross(a, xdir), cross(xdir, a)];
  const tag = `${f.id}.thread`;
  const tagged = (s: TopoDS_Shape) => {
    const b = new Body(oc, arena, input.bodyId, s);
    b.faceTags = b.faces.map(() => [tag]);
    return b;
  };
  const cylinder = (r: number, from: number, to: number) =>
    arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(axis2(oc, arena, add(o, a, from), a, xdir), r, to - from)).Shape());
  const ring = (rIn: number, rOut: number, from: number, to: number) => boolOp(oc, arena, "cut", cylinder(rOut, from, to), cylinder(rIn, from - 1, to + 1));

  // Profile radii (with clearance) and groove widths at its wide (open) and narrow (deep) side.
  const e = 0.05 * P;
  let rWide: number, wWide: number, rNarrow: number, wNarrow: number;
  if (internal) {
    const rMinor = internalMinor(spec.d, P) / 2 + c;
    const depth = R + c - rMinor;
    rWide = rMinor - e;
    wWide = 0.75 * P + 2 * e * TAN30;
    rNarrow = R + c;
    wNarrow = 0.75 * P - 2 * depth * TAN30;
  } else {
    const rMajor = R - c;
    const rRoot = externalMinor(spec.d, P) / 2 - c;
    rWide = rMajor + e;
    wWide = 0.875 * P + 2 * e * TAN30;
    rNarrow = rRoot;
    wNarrow = 0.875 * P - 2 * (rMajor - rRoot) * TAN30;
  }

  const volume = (sh: TopoDS_Shape) => {
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(sh, props, false, false, false);
    return props.Mass();
  };
  const groove = (hdir: V): TopoDS_Shape => {
    try {
      const start = add(o, a, zLo - P);
      const spine = helix(oc, arena, start, a, hdir, (rWide + rNarrow) / 2, P, zHi - zLo + 2 * P, !!f.leftHanded);
      const at = (r: number, z: number): V => add(add(start, hdir, r), a, z);
      const profile = polygon(oc, arena, [at(rWide, -wWide / 2), at(rNarrow, -wNarrow / 2), at(rNarrow, wNarrow / 2), at(rWide, wWide / 2)]);
      const mk = arena.track(new oc.BRepOffsetAPI_MakePipeShell(spine));
      mk.SetMode(arena.track(new oc.gp_Dir(a[0], a[1], a[2])));
      mk.Add(profile, false, false);
      mk.Build();
      if (!mk.IsDone()) throw new Error("sweep failed");
      mk.MakeSolid();
      let swept = arena.track(mk.Shape());
      // Depending on the axis direction the sweep can come out inside-out (negative volume).
      if (volume(swept) < 0) swept = arena.track(swept.Reversed());
      return boolOp(oc, arena, "common", swept, cylinder(Math.max(rWide, rNarrow) + P, zLo, zHi));
    } catch (err) {
      throw new FeatureError(`could not build the thread: ${err instanceof FeatureError ? err.message : occtErrorMessage(oc, err)}`);
    }
  };

  // Bring the face to the thread's own diameters first.
  let body = input;
  if (internal) {
    const rMinor = internalMinor(spec.d, P) / 2 + c;
    // Drawn at the nominal size (or bigger than the tap drill): fill back to the minor diameter.
    if (radius > rMinor + 1e-6) body = booleanBodies(oc, arena, body, tagged(ring(rMinor, radius + 0.01, lo, hi)), "fuse");
    // A separate cut rather than one fused tool: fusing the swept groove with the bore drops the groove.
    body = booleanBodies(oc, arena, body, tagged(cylinder(rMinor, zLo, zHi)), "cut");
  } else {
    const rMajor = R - c;
    if (radius < rMajor - 1e-6) body = booleanBodies(oc, arena, body, tagged(ring(Math.max(radius - 0.01, 0.01), rMajor, lo, hi)), "fuse");
    if (radius > rMajor + 1e-6) body = booleanBodies(oc, arena, body, tagged(ring(rMajor, radius + 1, lo, hi)), "cut");
  }
  const before = volume(body.shape);
  let threaded: Body | null = null;
  for (const hdir of starts) {
    const g = groove(hdir);
    const out = booleanBodies(oc, arena, body, tagged(g), "cut");
    // Most of the groove lies in material; a cut that removed (almost) nothing missed it.
    if (before - volume(out.shape) > 0.2 * volume(g)) {
      threaded = out;
      break;
    }
  }
  if (!threaded) throw new FeatureError("could not cut the thread into this face", "try a slightly different length or diameter");
  body = threaded;
  return { body, info: { size: spec.size, pitch: P, internal, length } };
}

function axis2(oc: OC, arena: Arena, origin: V, dir: V, xdir: V) {
  return arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...origin)), arena.track(new oc.gp_Dir(...dir)), arena.track(new oc.gp_Dir(...xdir))));
}

/** Helix on a cylinder of radius `r` around `dir` through `origin`, starting at `origin + xdir·r`. */
function helix(oc: OC, arena: Arena, origin: V, dir: V, xdir: V, r: number, pitch: number, height: number, left: boolean): TopoDS_Wire {
  const ax3 = arena.track(new oc.gp_Ax3(arena.track(new oc.gp_Pnt(...origin)), arena.track(new oc.gp_Dir(...dir)), arena.track(new oc.gp_Dir(...xdir))));
  const surface = arena.track(new oc.Geom_CylindricalSurface(ax3, r));
  const line = arena.track(new oc.Geom2d_Line(arena.track(new oc.gp_Pnt2d(0, 0)), arena.track(new oc.gp_Dir2d(left ? -2 * Math.PI : 2 * Math.PI, pitch))));
  const span = (height / pitch) * Math.hypot(2 * Math.PI, pitch);
  const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, span)).Edge());
  oc.BRepLib.BuildCurves3d(edge);
  return arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
}

function polygon(oc: OC, arena: Arena, pts: V[]): TopoDS_Wire {
  const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
  const vs = pts.map((p) => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(arena.track(new oc.gp_Pnt(...p)))).Vertex()));
  vs.forEach((v, i) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
  return arena.track(mw.Wire());
}

function boolOp(oc: OC, arena: Arena, op: "fuse" | "cut" | "common", a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const Algo = op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const algo = arena.track(new Algo(a, b));
  if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(`thread ${op} failed`);
  return arena.track(algo.Shape());
}
