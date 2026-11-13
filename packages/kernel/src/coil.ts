/**
 * Helices and what is built on them: the coil feature (a profile swept along a helix, cylindrical
 * or conical) and coil springs (compression, extension, torsion) from their spec.
 *
 * Helices are built exactly on a cylinder or cone: a line (constant pitch) or a smooth B-spline
 * (springs, whose pitch changes at closed ends) in the surface's (angle, height) parameters, so the
 * coil keeps its radius exactly.
 */

import { FeatureError, type ResolvedSpring } from "@meercad/model";
import { toWorld, type PlaneFrame } from "@meercad/sketch";
import type { TopoDS_Shape, TopoDS_Wire } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { occtErrorMessage, type OC } from "./occt.js";

export type V = [number, number, number];
const add = (p: V, q: V, s = 1): V => [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];
const dot = (p: V, q: V) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const cross = (p: V, q: V): V => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const unit = (v: V): V => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Where a helix sits: its axis (origin, unit direction) and the direction its start lies in from the axis. */
export interface HelixFrame {
  origin: V;
  dir: V;
  xdir: V;
}

/**
 * Helix of `turns` turns starting at `origin + xdir·r`, rising `pitch` per turn along `dir`
 * (right-handed unless `left`). A taper (degrees) makes it conical: the radius grows by
 * pitch·tan(taper) per turn.
 */
export function helixWire(oc: OC, arena: Arena, h: HelixFrame, r: number, pitch: number, turns: number, left: boolean, taper = 0): TopoDS_Wire {
  const ax3 = arena.track(new oc.gp_Ax3(arena.track(new oc.gp_Pnt(...h.origin)), arena.track(new oc.gp_Dir(...h.dir)), arena.track(new oc.gp_Dir(...h.xdir))));
  const a = (taper * Math.PI) / 180;
  const surface = Math.abs(a) < 1e-9 ? arena.track(new oc.Geom_CylindricalSurface(ax3, r)) : arena.track(new oc.Geom_ConicalSurface(ax3, a, r));
  // On the cone the second parameter runs along the slanted generatrix: pitch / cos(a) per turn.
  const rise = pitch / Math.cos(a);
  const line = arena.track(new oc.Geom2d_Line(arena.track(new oc.gp_Pnt2d(0, 0)), arena.track(new oc.gp_Dir2d(left ? -2 * Math.PI : 2 * Math.PI, rise))));
  const span = turns * Math.hypot(2 * Math.PI, rise);
  const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, span)).Edge());
  oc.BRepLib.BuildCurves3d(edge);
  return arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
}

/**
 * Helix on a cylinder of radius `r` whose height follows `z(turn)` (smooth), sampled per quarter
 * turn into a B-spline in the cylinder's parameters.
 */
function variableHelix(oc: OC, arena: Arena, h: HelixFrame, r: number, turns: number, z: (s: number) => number, left: boolean): TopoDS_Wire {
  // A B-spline through points on the cylinder (a curve in the cylinder's own parameters sweeps
  // badly: Frenet frames fail on it and corrected ones take minutes).
  const ydir = cross(h.dir, h.xdir);
  const n = Math.max(12, Math.ceil(turns * 24));
  const pts = arena.track(new oc.NCollection_Array1_gp_Pnt(1, n + 1));
  for (let k = 0; k <= n; k++) {
    const s = (k / n) * turns;
    const ang = (left ? -1 : 1) * 2 * Math.PI * s;
    const p = add(add(add(h.origin, h.xdir, r * Math.cos(ang)), ydir, r * Math.sin(ang)), h.dir, z(s));
    pts.SetValue(k + 1, arena.track(new oc.gp_Pnt(...p)));
  }
  const fit = arena.track(new oc.GeomAPI_PointsToBSpline(pts, 3, 8, "GeomAbs_C2" as never, 1e-4));
  const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(arena.track(fit.Curve()) as never)).Edge());
  return arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
}

/** The point and unit tangent at the start or end of a wire made of one edge. */
function wireEnd(oc: OC, arena: Arena, w: TopoDS_Wire, end: boolean): { p: V; t: V } {
  const ex = arena.track(new oc.TopExp_Explorer(w, "TopAbs_EDGE"));
  const c = arena.track(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(arena.track(ex.Current()))));
  const u = end ? c.LastParameter() : c.FirstParameter();
  const p = arena.track(c.Value(u));
  const d = arena.track(c.EvalDN(u, 1));
  return { p: [p.X(), p.Y(), p.Z()], t: unit([d.X(), d.Y(), d.Z()]) };
}

function volume(oc: OC, arena: Arena, s: TopoDS_Shape): number {
  const props = arena.track(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(s, props, false, false, false);
  return props.Mass();
}

function boolOp(oc: OC, arena: Arena, op: "fuse" | "cut" | "common", a: TopoDS_Shape, b: TopoDS_Shape, what: string): TopoDS_Shape {
  const Algo = op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const algo = arena.track(new Algo(a, b));
  if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(`could not build the ${what}`);
  return arena.track(algo.Shape());
}

/** A round wire (diameter `d`) swept along `spine`, starting with its section across the spine's start. */
function pipe(oc: OC, arena: Arena, spine: TopoDS_Wire, d: number, what: string): TopoDS_Shape {
  const { p, t } = wireEnd(oc, arena, spine, false);
  const circ = arena.track(new oc.gp_Circ(arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...p)), arena.track(new oc.gp_Dir(...t)))), d / 2));
  const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge());
  const profile = arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
  try {
    const mk = arena.track(new oc.BRepOffsetAPI_MakePipeShell(spine));
    mk.SetMode(true);
    mk.Add(profile, false, false);
    mk.Build();
    if (!mk.IsDone()) throw new FeatureError(`could not sweep the ${what}`);
    mk.MakeSolid();
    let s = arena.track(mk.Shape());
    if (volume(oc, arena, s) < 0) s = arena.track(s.Reversed());
    return s;
    /* v8 ignore start -- OCCT throws here only on failures no test can provoke on purpose */
  } catch (e) {
    if (e instanceof FeatureError) throw e;
    throw new FeatureError(`could not sweep the ${what}: ${occtErrorMessage(oc, e)}`);
  }
  /* v8 ignore stop */
}

// ---------------------------------------------------------------- springs

export interface SpringInfo {
  /** Pitch of the active coils, mm. */
  pitch: number;
  /** Total coils including closed ends. */
  totalCoils: number;
  /** Overall height (compression: the free length). */
  height: number;
  /** Solid height of a compression spring (all coils touching), mm. */
  solidHeight: number;
  /** Spring rate for spring steel (G = 81.5 GPa), N/mm (torsion: N·mm per degree). */
  rateSteel: number;
  /** Mean coil diameter, mm. */
  meanDiameter: number;
}

/** Shear and Young's moduli of spring steel, N/mm². */
const G_STEEL = 81500;
const E_STEEL = 206000;

/** Numbers of a spring spec without building it (for the dialog and the report). */
export function springNumbers(f: Pick<ResolvedSpring, "kind" | "wire" | "diameter" | "coils" | "length" | "ends" | "gap">): SpringInfo {
  const d = f.wire;
  const Dm = f.diameter - d;
  const n = f.coils;
  if (!(d > 0)) throw new FeatureError("the wire diameter must be greater than zero");
  if (!(n > 0)) throw new FeatureError("a spring needs at least a fraction of a coil");
  if (!(Dm > 1.2 * d)) throw new FeatureError("the wire is too thick for this diameter", `make the outside diameter at least ${(2.2 * d).toFixed(1)} mm`);
  const rate = f.kind === "torsion" ? (E_STEEL * d ** 4) / (64 * Dm * n) / (180 / Math.PI) : (G_STEEL * d ** 4) / (8 * Dm ** 3 * n);
  if (f.kind === "compression") {
    const ends = f.ends ?? "ground";
    const L = f.length ?? 3 * f.diameter;
    const endPitch = 1.05 * d;
    const total = ends === "open" ? n : n + 2;
    const pitch = ends === "open" ? (L - d) / n : ends === "closed" ? (L - d - 2 * endPitch) / n : (L - 2 * endPitch) / n;
    const solid = ends === "ground" ? (total - 0.5) * d : (total + 1) * d;
    return { pitch, totalCoils: total, height: L, solidHeight: solid, rateSteel: rate, meanDiameter: Dm };
  }
  const pitch = d + (f.gap ?? 0.3);
  const body = n * pitch + d;
  return { pitch, totalCoils: n, height: f.kind === "extension" ? body - d + 2 * Dm + d : body, solidHeight: body, rateSteel: rate, meanDiameter: Dm };
}

/**
 * A coil spring on `frame` at `center`, its axis along the frame's normal, standing on the plane.
 * Faces are all tagged `<id>.coil` (ground ends `<id>.end`).
 */
export function springBody(oc: OC, arena: Arena, f: ResolvedSpring, frame: PlaneFrame, warnings: string[]): { body: Body; info: SpringInfo } {
  const info = springNumbers(f);
  const d = f.wire;
  const R = info.meanDiameter / 2;
  const n = f.coils;
  const center = toWorld(frame, f.center ?? [0, 0]);
  const h: HelixFrame = { origin: center, dir: frame.normal, xdir: frame.u };
  const left = !!f.leftHanded;
  const what = `${f.kind} spring`;
  if (info.meanDiameter / d < 3) warnings.push("tightly wound: a spring index (mean diameter ÷ wire) below 3 is hard to make and stiff");
  const along = (p: V, t: number): V => add(p, frame.normal, t);
  const at = (s: number, z: number): V => {
    // Point at turn s (counted from the start at frame.u) and height z on the mean diameter.
    const ang = (left ? -1 : 1) * 2 * Math.PI * s;
    const e = add([frame.u[0] * Math.cos(ang), frame.u[1] * Math.cos(ang), frame.u[2] * Math.cos(ang)], frame.v, Math.sin(ang));
    return along(add(center, e, R), z);
  };
  const solid = (s: TopoDS_Shape) => {
    const b = new Body(oc, arena, f.id, s);
    b.faceTags = b.faces.map(() => [`${f.id}.coil`]);
    return b;
  };
  const cylinderBetween = (p: V, q: V, r: number) => {
    const dir = unit(add(q, p, -1));
    const len = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    return arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...p)), arena.track(new oc.gp_Dir(...dir)))), r, len)).Shape());
  };
  const sphere = (p: V, r: number) => arena.track(arena.track(new oc.BRepPrimAPI_MakeSphere(arena.track(new oc.gp_Pnt(...p)), r)).Shape());

  if (f.kind === "compression") {
    const ends = f.ends ?? "ground";
    if (!(info.height > 0)) throw new FeatureError("the free length must be greater than zero");
    if (!(info.pitch > 1.05 * d)) {
      const min = ends === "open" ? 1.05 * d * n + d : ends === "closed" ? 1.05 * d * (n + 2) + d : 1.05 * d * (n + 2);
      throw new FeatureError("too many coils for this length: they would touch", `make the spring at least ${min.toFixed(1)} mm long or use fewer coils`);
    }
    // Pitch along the turns: the end turns lie close (1.05 × wire), blending smoothly into the active pitch.
    const endPitch = 1.05 * d;
    const N = info.totalCoils;
    const blend = (s: number) => {
      if (ends === "open") return 1;
      const ramp = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : (1 - Math.cos(Math.PI * x)) / 2);
      return Math.min(ramp((s - 0.75) / 0.5), ramp((N - 0.75 - s) / 0.5));
    };
    // z(s) = z0 + ∫ pitch; the active pitch is chosen so the coil ends where it should.
    const z0 = ends === "ground" ? 0 : d / 2;
    const zEnd = ends === "ground" ? info.height : info.height - d / 2;
    const steps = Math.ceil(N * 64);
    let wActive = 0;
    let wEnd = 0;
    for (let k = 0; k < steps; k++) {
      const w = blend(((k + 0.5) / steps) * N);
      wActive += w / steps * N;
      wEnd += (1 - w) / steps * N;
    }
    const pActive = (zEnd - z0 - endPitch * wEnd) / wActive;
    // Cumulative heights on a fine grid for z(s).
    const zs: number[] = [z0];
    for (let k = 0; k < steps; k++) {
      const w = blend(((k + 0.5) / steps) * N);
      zs.push(zs[k]! + ((endPitch * (1 - w) + pActive * w) * N) / steps);
    }
    const z = (s: number) => {
      const x = Math.max(0, Math.min(steps, (s / N) * steps));
      const k = Math.min(steps - 1, Math.floor(x));
      return zs[k]! + (zs[k + 1]! - zs[k]!) * (x - k);
    };
    const spine = ends === "open" ? helixWire(oc, arena, { ...h, origin: along(center, z0) }, R, pActive, N, left) : variableHelix(oc, arena, h, R, N, z, left);
    let shape = pipe(oc, arena, spine, d, what);
    if (ends === "ground") {
      // Grinding: everything outside the free length goes.
      const slab = arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...center)), arena.track(new oc.gp_Dir(...frame.normal)))), R + d, info.height)).Shape());
      shape = boolOp(oc, arena, "common", shape, slab, what);
      const body = new Body(oc, arena, f.id, shape);
      body.faceTags = body.faces.map((_, i) => {
        const info2 = body.faceInfo[i]!;
        return [info2.planar ? `${f.id}.end` : `${f.id}.coil`];
      });
      return { body, info: { ...info, pitch: pActive } };
    }
    return { body: solid(shape), info: { ...info, pitch: pActive } };
  }

  const p = info.pitch;
  if (f.kind === "extension") {
    // Close-wound body between two full loops in the plane of each end, standing on the plane.
    const zb = 2 * R + d / 2;
    const spine = helixWire(oc, arena, { ...h, origin: along(center, zb) }, R, p, n, left);
    let shape = pipe(oc, arena, spine, d, what);
    const loop = (end: V, up: number) => {
      // From the end straight along the axis by R, then a full loop of radius R round a centre on the axis.
      const radial = unit(add(add(end, center, -1), frame.normal, -dot(add(end, center, -1), frame.normal)));
      const knee = along(end, up * R);
      const c = add(knee, radial, -R);
      const torusAxis = cross(radial, frame.normal);
      const torus = arena.track(arena.track(new oc.BRepPrimAPI_MakeTorus(arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...c)), arena.track(new oc.gp_Dir(...torusAxis)))), R, d / 2)).Shape());
      let s = boolOp(oc, arena, "fuse", cylinderBetween(end, knee, d / 2), torus, what);
      s = boolOp(oc, arena, "fuse", s, sphere(end, d / 2), what);
      return boolOp(oc, arena, "fuse", s, sphere(knee, d / 2), what);
    };
    shape = boolOp(oc, arena, "fuse", shape, loop(at(0, zb), -1), what);
    shape = boolOp(oc, arena, "fuse", shape, loop(at(n, zb + n * p), 1), what);
    return { body: solid(shape), info };
  }

  // Torsion: close-wound body and two straight legs along the coil's tangent at its ends.
  const z0 = d / 2;
  const spine = helixWire(oc, arena, { ...h, origin: along(center, z0) }, R, p, n, left);
  const legs = f.legs ?? f.diameter;
  if (!(legs > 0)) throw new FeatureError("the legs must be longer than zero");
  let shape = pipe(oc, arena, spine, d, what);
  const s0 = wireEnd(oc, arena, spine, false);
  const s1 = wireEnd(oc, arena, spine, true);
  shape = boolOp(oc, arena, "fuse", shape, cylinderBetween(s0.p, add(s0.p, s0.t, -legs), d / 2), what);
  shape = boolOp(oc, arena, "fuse", shape, cylinderBetween(s1.p, add(s1.p, s1.t, legs), d / 2), what);
  return { body: solid(shape), info };
}
