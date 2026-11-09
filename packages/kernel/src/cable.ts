/**
 * Cables as solids: the section (round, or a ribbon's flat rectangle) swept along the sampled
 * centre line of model/cable, with box housings for the plugs on its ends, fused into one part.
 * All faces are tagged `<id>.cable`.
 */

import { cable, FeatureError, materialById, type ResolvedCable } from "@meercad/model";
import type { TopoDS_Shape, TopoDS_Wire } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { occtErrorMessage, type OC } from "./occt.js";

type V = [number, number, number];
const cross = (p: V, q: V): V => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
const add = (p: V, q: V, s = 1): V => [p[0] + q[0] * s, p[1] + q[1] * s, p[2] + q[2] * s];

export interface CableInfo {
  length: number;
  /** Tightest bend as drawn, mm (Infinity when straight). */
  minRadius: number;
  bendRadius: number;
  mass: number;
}

export function cableBody(oc: OC, arena: Arena, f: ResolvedCable, warnings: string[]): { body: Body; info: CableInfo } {
  let rig: cable.CableRig;
  try {
    rig = cable.cableRig(f);
  } catch (e) {
    if (e instanceof cable.CableError) throw new FeatureError(e.message);
    throw e;
  }
  const { spec } = rig;
  // A coarser sampling for the spine: the B-spline through the samples is smooth anyway.
  const layout = cable.layCable(spec, f.points.map((p) => p.at), rig.ends, Math.max(1, rig.rest.length / 300, spec.width));
  const pnt = (p: V) => arena.track(new oc.gp_Pnt(...p));
  const dirOf = (v: V) => arena.track(new oc.gp_Dir(...v));

  const pts = arena.track(new oc.NCollection_Array1_gp_Pnt(1, layout.line.length));
  layout.line.forEach((p, i) => pts.SetValue(i + 1, pnt(p)));
  let spine: TopoDS_Wire;
  try {
    const fit = arena.track(new oc.GeomAPI_PointsToBSpline(pts, 3, 8, "GeomAbs_C2" as never, 1e-3));
    const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(arena.track(fit.Curve()) as never)).Edge());
    spine = arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
  } catch (e) {
    throw new FeatureError(`could not lay the cable: ${occtErrorMessage(oc, e)}`);
  }

  // The section at the start, square to the spine's own start (the fitted spline's, not the samples').
  const p0 = layout.line[0]!;
  const t0 = spineStart(oc, arena, spine) ?? layout.tangent[0]!;
  const a0 = unitV(add(layout.across[0]!, t0, -dotV(layout.across[0]!, t0)));
  let profile;
  if (spec.shape === "round") {
    const circ = arena.track(new oc.gp_Circ(arena.track(new oc.gp_Ax2(pnt(p0), dirOf(t0), dirOf(a0))), spec.width / 2));
    profile = arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge()))).Wire());
  } else {
    const up = cross(t0, a0);
    const w = spec.width / 2;
    const h = spec.thickness / 2;
    const corners: V[] = [add(add(p0, a0, w), up, -h), add(add(p0, a0, w), up, h), add(add(p0, a0, -w), up, h), add(add(p0, a0, -w), up, -h)];
    const vs = corners.map((c) => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt(c))).Vertex()));
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    vs.forEach((v, i) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % 4]!)).Edge())));
    profile = arena.track(mw.Wire());
  }
  let shape: TopoDS_Shape;
  try {
    const mk = arena.track(new oc.BRepOffsetAPI_MakePipeShell(spine));
    mk.SetMode(false); // corrected Frenet: turns the section as little as possible
    mk.Add(profile, false, false);
    mk.Build();
    if (!mk.IsDone()) throw new FeatureError("could not sweep the cable", "a cable too thick for a tight bend crosses itself: move the points apart");
    mk.MakeSolid();
    shape = arena.track(mk.Shape());
  } catch (e) {
    if (e instanceof FeatureError) throw e;
    throw new FeatureError(`could not sweep the cable: ${occtErrorMessage(oc, e)}`, "a cable too thick for a tight bend crosses itself: move the points apart");
  }
  if (volumeOf(oc, arena, shape) < 0) shape = arena.track(shape.Reversed());

  for (const plug of layout.plugs) {
    const up = cross(plug.dir, plug.across);
    const corner = add(add(plug.at, plug.across, -plug.size.width / 2), up, -plug.size.height / 2);
    // Local X along the plug, Y across, Z = X × Y up.
    const ax = arena.track(new oc.gp_Ax2(pnt(corner), dirOf(up), dirOf(plug.dir)));
    const box = arena.track(arena.track(new oc.BRepPrimAPI_MakeBox(ax, plug.size.length, plug.size.width, plug.size.height)).Shape());
    const fuse = arena.track(new oc.BRepAlgoAPI_Fuse(shape, box));
    if (!fuse.IsDone() || fuse.HasErrors()) throw new FeatureError(`could not put the ${plug.size.label} plug on the cable`);
    shape = arena.track(fuse.Shape());
  }

  const body = new Body(oc, arena, f.id, shape);
  body.preciseProps = true;
  body.faceTags = body.faces.map(() => [`${f.id}.cable`]);
  const density = materialById(spec.material)?.density ?? 0;
  const info: CableInfo = { length: rig.rest.length, minRadius: rig.rest.minRadius, bendRadius: spec.bendRadius, mass: (volumeOf(oc, arena, shape) / 1000) * density };
  if (cable.isTooTight({ minRadius: rig.rest.minRadius, bendRadius: spec.bendRadius }))
    warnings.push(`the cable bends to a ${rig.rest.minRadius.toFixed(1)} mm radius, tighter than its ${spec.bendRadius.toFixed(1)} mm bend radius: move the points apart`);
  return { body, info };
}

const dotV = (p: V, q: V) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
const unitV = (v: V): V => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function spineStart(oc: OC, arena: Arena, w: TopoDS_Wire): V | null {
  const ex = arena.track(new oc.TopExp_Explorer(w, "TopAbs_EDGE" as never));
  const c = arena.track(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(arena.track(ex.Current()))));
  const d = arena.track(c.EvalDN(c.FirstParameter(), 1));
  const t: V = [d.X(), d.Y(), d.Z()];
  return Math.hypot(...t) > 1e-12 ? unitV(t) : null;
}

/** Volume by the precise integral: the quick one is several per cent off on curved sweeps. */
function volumeOf(oc: OC, arena: Arena, s: TopoDS_Shape): number {
  const props = arena.track(new oc.GProp_GProps());
  oc.BRepGProp.VolumeProperties(s, props, 1e-5, false, false);
  return props.Mass();
}
