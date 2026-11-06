/**
 * Modelled ISO metric threads. A trapezoid groove (ISO 68-1 flanks, 60°) is swept along a helix
 * around the cylinder's axis, clipped to the threaded length and cut from the body. The thread's
 * own diameters win over the drawn ones: a hole is filled to the minor diameter first if it was drawn
 * at the nominal size, a shaft is trimmed to (or grown to) the major diameter.
 */

import { FeatureError, grooveShape, threadSpec, type ResolvedThread, type ThreadProfile } from "@meercad/model";
import { resolveFaces } from "@meercad/naming";
import type { TopoDS_Shape, TopoDS_Wire } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { booleanBodies } from "./boolean.js";
import { occtErrorMessage, type OC } from "./occt.js";

type V = [number, number, number];
const FUZZY = 1e-5;
const add = (p: V, q: V, s = 1): V => [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];
const dot = (p: V, q: V) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];

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
  return threadFace(oc, arena, input, refs[0]!.faces[0]!, { ...f, tag: `${f.id}.thread` });
}

export interface ThreadOptions {
  profile?: ThreadProfile;
  size?: string;
  diameter?: number;
  pitch?: number;
  starts?: number;
  length?: number;
  clearance?: number;
  leftHanded?: boolean;
  /** Tag of the thread's faces. */
  tag: string;
}

/** Threads face `fi` of `input` (a cylinder): the body brought to the thread's diameters, the groove(s) cut. */
export function threadFace(oc: OC, arena: Arena, input: Body, fi: number, f: ThreadOptions): { body: Body; info: ThreadInfo } {
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

  let spec: ReturnType<typeof threadSpec>;
  let shape: ReturnType<typeof grooveShape>;
  const c = f.clearance ?? 0;
  try {
    spec = threadSpec(radius * 2, internal, f);
    if (!(spec.pitch > 0) || spec.pitch > spec.d / 2) throw new Error(`pitch ${spec.pitch} mm does not fit ${spec.size}`);
    if (c < 0 || c > spec.pitch / 4) throw new Error(`clearance must be between 0 and ${(spec.pitch / 4).toFixed(2)} mm for this pitch`);
    shape = grooveShape(spec.profile, spec.d, spec.pitch, internal, c);
  } catch (e) {
    throw new FeatureError(e instanceof Error ? e.message : String(e));
  }
  const P = spec.pitch;
  const L = spec.lead;
  if (!(shape.root > 0.1)) throw new FeatureError(`the thread is deeper than ${spec.size} is thick`, "use a finer pitch");
  const length = Math.min(f.length ?? full, full);
  if (!(length > 0)) throw new FeatureError("thread length must be greater than zero");

  // Threads start at an open end (the top one if both are open) and run `length` along the face.
  const fromTop = open[1] || !open[0];
  const lo = fromTop ? t1 - length : t0;
  const hi = fromTop ? t1 : t0 + length;
  const runOutLo = open[0] && free[0] && lo <= t0 + 1e-9;
  const runOutHi = open[1] && free[1] && hi >= t1 - 1e-9;
  const zLo = lo - (runOutLo ? L : 0);
  const zHi = hi + (runOutHi ? L : 0);

  // Seams: OCCT can miss the groove/cylinder intersection (the cut then silently removes nothing)
  // depending on where the helix starts relative to the cylinders' seam. A quarter turn from the
  // seam works, normally the one ahead of the seam in the helix's own sense; the one behind it when
  // the groove's far end would land past the opposite side (170–320° for holes, 170–250° for shafts,
  // measured over M3–M8 holes and shafts of many lengths, both axis directions and both hands).
  // The other start is still tried if the cut misses. Our helper cylinders share the face's seam direction.
  // The face's seam sits at its first u parameter, which need not be the surface's x direction.
  const xd = arena.track(pos.XDirection());
  const yd = arena.track(pos.YDirection());
  const u0 = surf.FirstUParameter();
  const xdir: V = add([xd.X() * Math.cos(u0), xd.Y() * Math.cos(u0), xd.Z() * Math.cos(u0)], [yd.X(), yd.Y(), yd.Z()], Math.sin(u0));
  const cross = (p: V, q: V): V => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const ahead = f.leftHanded ? cross(xdir, a) : cross(a, xdir);
  // A direction `deg` degrees from the seam in the helix's sense.
  // Exact at quarter turns: OCCT's cut reacts even to a 1e-16 tilt of the start (cos 270° is not 0 in floating point).
  const turned = (deg: number): V => {
    const r = (deg * Math.PI) / 180;
    const exact = (v: number) => (Math.abs(v) < 1e-12 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-12 ? Math.sign(v) : v);
    const [c, sn] = [exact(Math.cos(r)), exact(Math.sin(r))];
    return add([xdir[0] * c, xdir[1] * c, xdir[2] * c], ahead, sn);
  };
  const tagged = (s: TopoDS_Shape) => {
    const b = new Body(oc, arena, input.bodyId, s);
    b.faceTags = b.faces.map(() => [f.tag]);
    return b;
  };
  const cylinder = (r: number, from: number, to: number) =>
    arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(axis2(oc, arena, add(o, a, from), a, xdir), r, to - from)).Shape());
  const ring = (rIn: number, rOut: number, from: number, to: number) => boolOp(oc, arena, "cut", cylinder(rOut, from, to), cylinder(rIn, from - 1, to + 1));

  const rCrest = shape.crest / 2;
  const rRoot = shape.root / 2;
  // The spine runs between the outline's wide side (just past the crest) and the root, as it always has.
  const rMid = (shape.outline[0]![0] + rRoot) / 2;
  const volume = (sh: TopoDS_Shape) => {
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(sh, props, false, false, false);
    return props.Mass();
  };
  // `shift` moves the groove along the axis: start k of a multi-start thread is start 0 shifted by k·P.
  const groove = (hdir: V, shift = 0, pieces = 0): TopoDS_Shape => {
    try {
      const start = add(o, a, zLo - L + shift);
      const spine = helix(oc, arena, start, a, hdir, rMid, L, zHi - zLo + 2 * L, !!f.leftHanded, pieces);
      const at = (r: number, z: number): V => add(add(start, hdir, r), a, z);
      const profile = polygon(oc, arena, shape.outline.map(([r, z]) => at(r, z)));
      const mk = arena.track(new oc.BRepOffsetAPI_MakePipeShell(spine));
      mk.SetMode(arena.track(new oc.gp_Dir(a[0], a[1], a[2])));
      mk.Add(profile, false, false);
      mk.Build();
      if (!mk.IsDone()) throw new Error("sweep failed");
      mk.MakeSolid();
      let swept = arena.track(mk.Shape());
      // Depending on the axis direction the sweep can come out inside-out (negative volume).
      if (volume(swept) < 0) swept = arena.track(swept.Reversed());
      return boolOp(oc, arena, "common", swept, cylinder(Math.max(rCrest, rRoot) + P, zLo, zHi));
    } catch (err) {
      throw new FeatureError(`could not build the thread: ${err instanceof FeatureError ? err.message : occtErrorMessage(oc, err)}`);
    }
  };

  // Bring the face to the thread's own diameters first.
  let body = input;
  if (internal) {
    // Drawn at the nominal size (or bigger than the tap drill): fill back to the minor diameter.
    if (radius > rCrest + 1e-6) body = booleanBodies(oc, arena, body, tagged(ring(rCrest, radius + 0.01, lo, hi)), "fuse");
    // A separate cut rather than one fused tool: fusing the swept groove with the bore drops the groove.
    body = booleanBodies(oc, arena, body, tagged(cylinder(rCrest, zLo, zHi)), "cut");
  } else {
    if (radius < rCrest - 1e-6) body = booleanBodies(oc, arena, body, tagged(ring(Math.max(radius - 0.01, 0.01), rCrest, lo, hi)), "fuse");
    if (radius > rCrest + 1e-6) body = booleanBodies(oc, arena, body, tagged(ring(rCrest, radius + 1, lo, hi)), "cut");
  }
  // Each start is its own groove, turned by 360°/starts. They are cut one after the other and,
  // where OCCT misses a later groove against the earlier ones, all together.
  // Where the far end of the groove from the start ahead of the seam lands, in degrees from the seam.
  const turns = (zHi - zLo) / L;
  const endAngle = (90 + 360 * (turns - Math.floor(turns))) % 360;
  const fromBehind = endAngle >= 170 && endAngle < (internal ? 320 : 250);
  // Further starts in between (never on the seam itself) for the shapes where both of those miss.
  const tries = [...(fromBehind ? [270, 90] : [90, 270]), 45, 135, 225, 315, 20, 160, 200, 340];
  // Plain cuts at the usual starts first (what has always worked for metric threads), then fuzzy ones.
  // At most eight tries: a thread that misses that often will not work at another angle either.
  // Then grooves made of half-turn pieces, which OCCT intersects more reliably than one long face.
  // Metric single-start threads keep the long groove first (measured over many sizes); the other
  // forms start with the pieces.
  const metric = spec.profile === "iso" && spec.starts === 1;
  const whole = tries.slice(0, metric ? 6 : 2).map((deg) => [deg, 0, 0] as const);
  const split = tries.slice(0, 2).map((deg) => [deg, 0, 2] as const);
  const attempts: (readonly [number, number, number])[] = [
    ...(metric ? [...whole, ...split] : [...split, ...whole]),
    ...tries.slice(0, 4).map((deg) => [deg, FUZZY, 2] as const),
  ];
  const off = (deg: number) => {
    const at = ((deg % 360) + 360) % 360;
    return Math.abs(at) < 5 || Math.abs(at - 360) < 5 ? at + 10 : at;
  };
  let lastError: unknown = null;
  /** Cuts the grooves (start angle, axial shift); null when the cut missed them. */
  const cut = (from: Body, gs: [number, number][], fuzzy: number, pieces: number): Body | null => {
    try {
      const grooves = gs.map(([deg, shift]) => groove(turned(off(deg)), shift, pieces));
      const before = volume(from.shape);
      const out = booleanBodies(oc, arena, from, grooves.map(tagged), "cut", from.bodyId, fuzzy);
      // Measured after the cut: measuring the grooves first changes what OCCT's boolean makes of them.
      const gv = grooves.reduce((sum, g) => sum + volume(g), 0);
      // Most of the grooves lie in material; a cut that removed (almost) nothing missed them, one that
      // removed more than them went wrong (it can happen, and leaves bits of the groove outside).
      const removed = before - volume(out.shape);
      return removed > 0.2 * gv && removed < 1.02 * gv ? out : null;
    } catch (e) {
      lastError = e;
      return null;
    }
  };
  // Start k is start 0 moved k pitches along the axis: the same angle to the seam that worked for it.
  let threaded: Body | null = null;
  let found: readonly [number, number, number] | null = null;
  for (const att of attempts) if ((threaded = cut(body, [[att[0], 0]], att[1], att[2]))) {
    found = att;
    break;
  }
  for (let k = 1; k < spec.starts && threaded && found; k++) {
    const from: Body = threaded;
    threaded = cut(from, [[found[0], k * P]], found[1], found[2]);
    for (const [deg, fuzzy, pieces] of attempts) if (!threaded) threaded = cut(from, [[deg, k * P]], fuzzy, pieces);
  }
  if (!threaded && lastError instanceof FeatureError && !/no solid|failed/.test(lastError.message)) throw lastError;
  if (!threaded) throw new FeatureError("could not cut the thread into this face", spec.starts > 1 ? "try a slightly different length, or thread only part of the face" : "try a slightly different length or diameter");
  body = threaded;
  return { body, info: { size: spec.size, pitch: P, internal, length } };
}

function axis2(oc: OC, arena: Arena, origin: V, dir: V, xdir: V) {
  return arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...origin)), arena.track(new oc.gp_Dir(...dir)), arena.track(new oc.gp_Dir(...xdir))));
}

/** Helix on a cylinder of radius `r` around `dir` through `origin`, starting at `origin + xdir·r`. */
/** `pieces` > 0 builds the helix from that many edges per turn (booleans cope better with short faces). */
function helix(oc: OC, arena: Arena, origin: V, dir: V, xdir: V, r: number, pitch: number, height: number, left: boolean, pieces = 0): TopoDS_Wire {
  const ax3 = arena.track(new oc.gp_Ax3(arena.track(new oc.gp_Pnt(...origin)), arena.track(new oc.gp_Dir(...dir)), arena.track(new oc.gp_Dir(...xdir))));
  const surface = arena.track(new oc.Geom_CylindricalSurface(ax3, r));
  const line = arena.track(new oc.Geom2d_Line(arena.track(new oc.gp_Pnt2d(0, 0)), arena.track(new oc.gp_Dir2d(left ? -2 * Math.PI : 2 * Math.PI, pitch))));
  const span = (height / pitch) * Math.hypot(2 * Math.PI, pitch);
  if (pieces <= 0) {
    const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, span)).Edge());
    oc.BRepLib.BuildCurves3d(edge);
    return arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
  }
  const n = Math.max(1, Math.ceil((height / pitch) * pieces));
  const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
  for (let k = 0; k < n; k++) {
    const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(line, surface, (span * k) / n, (span * (k + 1)) / n)).Edge());
    oc.BRepLib.BuildCurves3d(edge);
    mw.Add(edge);
  }
  return arena.track(mw.Wire());
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
