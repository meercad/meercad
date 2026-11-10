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
  // A coarse sampling will do: the sweep follows the exact pieces, the samples only set the section's turn at the start.
  const layout = cable.layCable(spec, f.points.map((p) => p.at), rig.ends, Math.max(1, rig.rest.length / 300, spec.width));
  const pnt = (p: V) => arena.track(new oc.gp_Pnt(...p));
  const dirOf = (v: V) => arena.track(new oc.gp_Dir(...v));

  let spine: TopoDS_Wire;
  try {
    // The centre line exactly, as one cubic B-spline: each Hermite piece of the layout is a Bézier
    // segment, the knots spaced by the chords so the pieces join with the same tangent (C1). A
    // spline fitted through hundreds of samples instead had many tiny spans: the sweep along it
    // failed or came out as a surface that took a minute to mesh.
    const { nodes, nodeTangents: tan } = layout;
    const n = nodes.length - 1;
    const poles = arena.track(new oc.NCollection_Array1_gp_Pnt(1, 3 * n + 1));
    const knots = arena.track(new oc.NCollection_Array1_double(1, n + 1));
    const mults = arena.track(new oc.NCollection_Array1_int(1, n + 1));
    let u = 0;
    knots.SetValue(1, 0);
    poles.SetValue(1, pnt(nodes[0]!));
    for (let i = 0; i < n; i++) {
      const [p0, p1] = [nodes[i]!, nodes[i + 1]!];
      const h = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      poles.SetValue(3 * i + 2, pnt(add(p0, tan[i]!, h / 3)));
      poles.SetValue(3 * i + 3, pnt(add(p1, tan[i + 1]!, -h / 3)));
      poles.SetValue(3 * i + 4, pnt(p1));
      u += h;
      knots.SetValue(i + 2, u);
    }
    for (let i = 1; i <= n + 1; i++) mults.SetValue(i, i === 1 || i === n + 1 ? 4 : 3);
    const curve = arena.track(new oc.Geom_BSplineCurve(poles, knots, mults, 3, false));
    // Down to C1 where the pieces join smoothly (always, unless the tolerance says otherwise).
    for (let i = n; i >= 2; i--) curve.RemoveKnot(i, 2, 1e-7);
    const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(curve as never)).Edge());
    spine = arena.track(arena.track(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
  } catch (e) {
    throw new FeatureError(`could not lay the cable: ${occtErrorMessage(oc, e)}`);
  }

  // The section at the start, square to the spine's own start.
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
    // Discrete trihedron: turns the section as little as possible, like corrected Frenet, but
    // stays exact where the spine runs straight. Corrected Frenet has no curvature to go by there
    // and approximates the swept surface badly: a straight cable along Z came out as a surface
    // that meshing never finished (the app hung), slanted straight cables failed to sweep at all.
    mk.SetDiscreteMode();
    mk.Add(profile, false, false);
    mk.Build();
    if (!mk.IsDone()) throw new FeatureError("could not sweep the cable", "a cable too thick for a tight bend crosses itself: move the points apart");
    mk.MakeSolid();
    // A swept solid can come out inside-out, which booleans reject (the plugs would fuse into nothing):
    // orient it and copy it onto fresh topology.
    const solids = arena.track(new oc.TopExp_Explorer(arena.track(mk.Shape()), "TopAbs_SOLID" as never));
    if (!solids.More()) throw new FeatureError("could not sweep the cable");
    const solid = arena.track(oc.TopoDS.Solid(arena.track(solids.Current())));
    oc.BRepLib.OrientClosedSolid(solid);
    shape = arena.track(arena.track(new oc.BRepBuilderAPI_Transform(solid, arena.track(new oc.gp_Trsf()), true, false)).Shape());
  } catch (e) {
    if (e instanceof FeatureError) throw e;
    throw new FeatureError(`could not sweep the cable: ${occtErrorMessage(oc, e)}`, "a cable too thick for a tight bend crosses itself: move the points apart");
  }

  for (const plug of layout.plugs) {
    const up = cross(plug.dir, plug.across);
    const corner = add(add(plug.at, plug.across, -plug.size.width / 2), up, -plug.size.height / 2);
    // Local X along the plug, Y across, Z = X × Y up.
    const ax = arena.track(new oc.gp_Ax2(pnt(corner), dirOf(up), dirOf(plug.dir)));
    const box = arena.track(arena.track(new oc.BRepPrimAPI_MakeBox(ax, plug.size.length, plug.size.width, plug.size.height)).Shape());
    const fuse = arena.track(new oc.BRepAlgoAPI_Fuse());
    const list = (x: TopoDS_Shape) => {
      const l = arena.track(new oc.NCollection_List_TopoDS_Shape());
      l.Append(x);
      return l;
    };
    fuse.SetArguments(list(shape));
    fuse.SetTools(list(box));
    fuse.SetFuzzyValue(1e-4);
    fuse.Build(arena.track(new oc.Message_ProgressRange()));
    if (!fuse.IsDone() || fuse.HasErrors()) throw new FeatureError(`could not put the ${plug.size.label} plug on the cable`);
    shape = arena.track(fuse.Shape());
  }

  const body = new Body(oc, arena, f.id, shape);
  body.preciseProps = true;
  // A thin tube needs no 100 facets round (the usual 0.06 rad): a quarter of that still looks
  // round and meshes several times faster (a robot with two dozen cables).
  body.displayCoarse = 4;
  // Export: 0.02 mm and 0.2 rad (about 30 facets round, under 0.02 mm off a 3 mm tube) instead of
  // print quality's 0.05 rad. At print quality two dozen cables of a robot made more triangles than
  // its 560 other parts together (5.2 of 9.7 million) and two thirds of the export time (86 of 133 s).
  body.exportTolerance = { linear: 0.02, angular: 0.2 };
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
