/**
 * Involute gears, ring gears and racks. The outline comes from `@meercad/model` (pure geometry);
 * here it becomes wires on the gear's plane, swept straight up (spur), lofted through turned
 * sections (helical, herringbone), and given a bore and hub. Faces are tagged by where they lie:
 * `gr1.flank`, `gr1.tip`, `gr1.root`, `gr1.start_cap`, `gr1.end_cap`, `gr1.bore`, `gr1.hub`,
 * `gr1.chamfer`, `gr1.rim` (ring gears), `gr1.back` and `gr1.end` (racks).
 */

import {
  FeatureError,
  GEAR_DEFAULTS,
  GearError,
  gearDims,
  gearShape,
  helixTwist,
  meshHelix,
  meshPlacement,
  type GearParams,
  type GearPlacement,
  type OutlineSegment,
  type Pt,
  type ResolvedGear,
} from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Edge, TopoDS_Shape, TopoDS_Vertex, TopoDS_Wire } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import type { OC } from "./occt.js";

/** A built gear as later features see it (for meshing). */
export interface GearRecord extends GearPlacement {
  frame: PlaneFrame;
}

const rad = (deg: number) => (deg * Math.PI) / 180;

export function gearBody(oc: OC, arena: Arena, f: ResolvedGear, frame: PlaneFrame, partner: GearRecord | undefined): { body: Body; record: GearRecord } {
  const P = partner?.params;
  const module = P ? P.module : f.module;
  if (module === undefined || !(module > 0)) throw new FeatureError("the module must be greater than zero");
  const params: GearParams = {
    kind: f.kind,
    module,
    teeth: f.teeth,
    pressureAngle: P ? P.pressureAngle : (f.pressureAngle ?? GEAR_DEFAULTS.pressureAngle),
    profileShift: f.kind === "spur" ? (f.profileShift ?? 0) : 0,
    helix: P ? meshHelix(P, f.kind) : (f.helix ?? 0),
    herringbone: P ? P.herringbone : !!f.herringbone,
    backlash: f.backlash ?? GEAR_DEFAULTS.backlash,
    clearance: f.clearance ?? GEAR_DEFAULTS.clearance,
  };
  const width = f.width;
  if (!(width > 0)) throw new FeatureError("the gear's width must be greater than zero");
  if (params.pressureAngle < 10 || params.pressureAngle > 35) throw new FeatureError("the pressure angle must be between 10° and 35°");
  if (Math.abs(params.helix) >= 45) throw new FeatureError("the helix angle must be below 45°");
  if (params.backlash < 0 || params.backlash > module) throw new FeatureError(`backlash must be between 0 and ${module} mm`);
  if (params.clearance < 0 || params.clearance > 1) throw new FeatureError("the tip clearance factor must be between 0 and 1");

  let shape: ReturnType<typeof gearShape>;
  let place: { center: Pt; rotation: number };
  try {
    shape = gearShape(params, { ...(f.rim !== undefined ? { rim: f.rim } : {}) });
    place = partner ? meshPlacement(partner, params, rad(f.meshWith?.direction ?? 0)) : { center: f.center ?? [0, 0], rotation: rad(f.rotation ?? 0) };
  } catch (e) {
    if (e instanceof GearError) throw new FeatureError(e.message);
    throw e;
  }
  const dims = gearDims(params);
  const [cx, cy] = place.center;
  const cos = Math.cos(place.rotation);
  const sin = Math.sin(place.rotation);
  const n = frame.normal;
  const lift = (p: Vec3, z: number): Vec3 => [p[0] + n[0] * z, p[1] + n[1] * z, p[2] + n[2] * z];
  // Gear coordinates at height z → world: helix turn (racks: shift), placement, plane.
  const world = (z: number) => {
    const t = helixTwist(params, width, z);
    const tc = Math.cos(t);
    const ts = Math.sin(t);
    return ([x, y]: Pt): Vec3 => {
      const [a, b] = params.kind === "rack" ? [x + t, y] : [x * tc - y * ts, x * ts + y * tc];
      return lift(toWorld(frame, [cx + a * cos - b * sin, cy + a * sin + b * cos]), z);
    };
  };

  const twisted = Math.abs(params.helix) > 1e-9;
  const sweep = (loop: OutlineSegment[]): TopoDS_Shape => {
    if (!twisted) {
      const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(wire(oc, arena, loop, world(0)), true)).Face());
      const prism = arena.track(new oc.BRepPrimAPI_MakePrism(face, arena.track(new oc.gp_Vec(n[0] * width, n[1] * width, n[2] * width)), false, true));
      if (!prism.IsDone()) throw new FeatureError("could not build the gear");
      return arena.track(prism.Shape());
    }
    // Gears turn: a smooth loft through sections a few degrees apart. Racks shift linearly, so a
    // ruled loft is exact. A herringbone runs through all sections up to the middle and back in one
    // ruled loft, which keeps its point sharp and avoids joining two halves (slow in OCCT).
    const half = params.herringbone ? width / 2 : width;
    const turn = Math.abs(helixTwist(params, width, half));
    const steps = params.kind === "rack" ? 1 : Math.max(2, Math.ceil(turn / rad(3)));
    const zs = Array.from({ length: steps + 1 }, (_, i) => (half * i) / steps);
    if (params.herringbone) zs.push(...zs.slice(1).map((z) => half + z));
    const loft = arena.track(new oc.BRepOffsetAPI_ThruSections(true, params.kind === "rack" || params.herringbone, 1e-6));
    loft.CheckCompatibility(false);
    for (const z of zs) loft.AddWire(wire(oc, arena, loop, world(z)));
    loft.Build(arena.track(new oc.Message_ProgressRange()));
    if (!loft.IsDone()) throw new FeatureError("could not build the helical gear");
    return arena.track(loft.Shape());
  };

  let solid: TopoDS_Shape;
  try {
    solid = sweep(shape.outer);
    if (shape.inner) solid = boolOp(oc, arena, "cut", solid, sweep(shape.inner));
  } catch (e) {
    if (e instanceof FeatureError) throw e;
    throw new FeatureError("could not build the gear", "try fewer teeth or a smaller helix angle");
  }

  const axisAt = (z: number): Vec3 => lift(toWorld(frame, [cx, cy]), z);
  // Tooth chamfer: keep what lies inside a cylinder at the tip circle with 45° chamfers at both
  // ends (ring gears: outside a cone-ended hole at their inner tip circle).
  const chamfer = f.chamfer ?? 0;
  if (chamfer > 0) {
    if (params.kind === "rack") throw new FeatureError("racks have no tooth chamfer yet");
    if (chamfer > module) throw new FeatureError(`the tooth chamfer must be at most the module (${module} mm)`);
    if (2 * chamfer >= width) throw new FeatureError("the tooth chamfer must be less than half the width");
    const ra = dims.da / 2;
    const e = 0.5;
    const rz: Pt[] =
      params.kind === "internal"
        ? [
            [ra + chamfer, -e],
            [(f.rim ?? dims.df + 4 * module) / 2 + 1, -e],
            [(f.rim ?? dims.df + 4 * module) / 2 + 1, width + e],
            [ra + chamfer, width + e],
            [ra + chamfer, width],
            [ra - e, width - chamfer - e],
            [ra - e, chamfer + e],
            [ra + chamfer, 0],
          ]
        : [
            [0, -e],
            [ra - chamfer, -e],
            [ra - chamfer, 0],
            [ra + e, chamfer + e],
            [ra + e, width - chamfer - e],
            [ra - chamfer, width],
            [ra - chamfer, width + e],
            [0, width + e],
          ];
    const at = (r: number, z: number): Vec3 => lift(toWorld(frame, [cx + r, cy]), z);
    const revolve = (pts: Pt[]) => {
      const loop = pts.map((p, i) => ({ part: "flank" as const, pts: [p, pts[(i + 1) % pts.length]!] }));
      const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(wire(oc, arena, loop, ([r, z]) => at(r, z)), true)).Face());
      const rev = arena.track(new oc.BRepPrimAPI_MakeRevol(face, arena.track(new oc.gp_Ax1(arena.track(new oc.gp_Pnt(...axisAt(0))), arena.track(new oc.gp_Dir(...n)))), 2 * Math.PI, false));
      if (!rev.IsDone()) throw new FeatureError("could not chamfer the teeth");
      return arena.track(rev.Shape());
    };
    if (params.kind === "internal") solid = boolOp(oc, arena, "common", solid, revolve(rz));
    else {
      // Spur gears: cut two thin 45° rings off the tooth tips at the ends, which touches the teeth
      // only there (keeping everything inside the chamfered cylinder took several times longer).
      const c0 = ra - chamfer;
      const front = revolve([[c0 - e, -e], [ra + 1, -e], [ra + 1, ra + 1 - c0]]);
      const back = revolve([[c0 - e, width + e], [ra + 1, width - (ra + 1 - c0)], [ra + 1, width + e]]);
      solid = boolOp(oc, arena, "cut", boolOp(oc, arena, "cut", solid, front), back);
    }
  }

  // Hub and bore (spur gears), along the axis through the centre.
  const cylinder = (r: number, z0: number, z1: number) =>
    arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(axis2(oc, arena, axisAt(z0), n, frame.u), r, z1 - z0)).Shape());
  let zLo = 0;
  let zHi = width;
  if (f.hub) {
    const side = f.hub.side ?? "front";
    const r = f.hub.diameter / 2;
    if (!(f.hub.length > 0)) throw new FeatureError("the hub's length must be greater than zero");
    if (!(r > 0) || r >= dims.df / 2) throw new FeatureError(`the hub must be smaller than the root circle (${dims.df.toFixed(2)} mm)`);
    if (side !== "back") solid = boolOp(oc, arena, "fuse", solid, cylinder(r, width - 0.01, width + f.hub.length)), (zHi = width + f.hub.length);
    if (side !== "front") solid = boolOp(oc, arena, "fuse", solid, cylinder(r, -f.hub.length, 0.01)), (zLo = -f.hub.length);
  }
  let boreR = 0;
  if (f.bore) {
    const d = f.bore.diameter + (f.bore.allowance ?? 0);
    const limit = f.hub ? f.hub.diameter : dims.df;
    if (!(d > 0) || d >= limit - 0.5) throw new FeatureError(`the bore must be smaller than the ${f.hub ? "hub" : "root circle"} (${limit.toFixed(2)} mm)`);
    const shapeKind = f.bore.shape ?? "round";
    let tool: TopoDS_Shape;
    if (shapeKind === "hex") {
      // `diameter` is across the flats.
      const rc = d / 2 / Math.cos(Math.PI / 6);
      const pts = Array.from({ length: 6 }, (_, k): Pt => [rc * Math.cos((Math.PI / 3) * k + Math.PI / 6), rc * Math.sin((Math.PI / 3) * k + Math.PI / 6)]);
      const loop = pts.map((p, i) => ({ part: "flank" as const, pts: [p, pts[(i + 1) % 6]!] }));
      tool = prismOf(oc, arena, loop, world0(zLo - 1), n, zHi - zLo + 2);
      boreR = rc;
    } else {
      tool = cylinder(d / 2, zLo - 1, zHi + 1);
      boreR = d / 2;
      if (shapeKind === "d_flat") {
        const across = (f.bore.flat ?? f.bore.diameter * 0.9) + (f.bore.allowance ?? 0);
        if (!(across > d / 2) || across >= d) throw new FeatureError("the flat must be between half the bore and the bore diameter");
        // Material back in beyond the flat, which faces where tooth 1 points.
        const off = across - d / 2;
        const big = d;
        const keep: Pt[] = [
          [off, -big],
          [off + big, -big],
          [off + big, big],
          [off, big],
        ];
        const loop = keep.map((p, i) => ({ part: "flank" as const, pts: [p, keep[(i + 1) % 4]!] }));
        tool = boolOp(oc, arena, "cut", tool, prismOf(oc, arena, loop, world0(zLo - 2), n, zHi - zLo + 4));
      }
    }
    solid = boolOp(oc, arena, "cut", solid, tool);
  }
  // Points in gear coordinates without any helix turn (bore and flat follow tooth 1).
  function world0(z: number) {
    return ([x, y]: Pt): Vec3 => lift(toWorld(frame, [cx + x * cos - y * sin, cy + x * sin + y * cos]), z);
  }

  const body = new Body(oc, arena, f.id, solid);
  body.faceTags = tagFaces(body, f.id, params, dims, { frame, center: place.center, rotation: place.rotation, width, boreR, rim: f.rim, chamfer });
  return { body, record: { params, center: place.center, rotation: place.rotation, width, frame } };
}

function tagFaces(
  body: Body,
  id: string,
  p: GearParams,
  dims: ReturnType<typeof gearDims>,
  at: { frame: PlaneFrame; center: Pt; rotation: number; width: number; boreR: number; rim: number | undefined; chamfer: number },
): string[][] {
  const { frame, center, width } = at;
  const tol = Math.max(0.02 * p.module, 0.01);
  const m = p.module;
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return body.facePoints.map((pt, i) => {
    const info = body.faceInfo[i]!;
    const d: Vec3 = [pt[0] - frame.origin[0], pt[1] - frame.origin[1], pt[2] - frame.origin[2]];
    const u = dot(d, frame.u) - center[0];
    const v = dot(d, frame.v) - center[1];
    const w = dot(d, frame.normal);
    const name = (part: string) => [`${id}.${part}`];
    if (info.planar && info.normal && Math.abs(Math.abs(dot(info.normal, frame.normal)) - 1) < 1e-6) {
      if (Math.abs(w) < 1e-6) return name("start_cap");
      if (Math.abs(w - width) < 1e-6) return name("end_cap");
      return name("hub");
    }
    if (p.kind === "rack") {
      const c = Math.cos(at.rotation);
      const s = Math.sin(at.rotation);
      const x = u * c + v * s;
      const y = -u * s + v * c;
      const hf = m * (1 + p.clearance);
      const back = at.rim ?? 2 * m;
      const L = Math.round(p.teeth) * dims.pitch;
      if (Math.abs(y - m) < tol) return name("tip");
      if (Math.abs(y + hf) < tol) return name("root");
      if (Math.abs(y + hf + back) < tol) return name("back");
      if (Math.abs(Math.abs(x) - L / 2) < tol) return name("end");
      return name("flank");
    }
    const rho = Math.hypot(u, v);
    if (at.boreR > 0 && rho < at.boreR + tol) return name("bore");
    if (w < -1e-6 || w > width + 1e-6) return name("hub");
    // Chamfer cones: near an end, around the tip circle, not flat.
    if (at.chamfer > 0 && !info.planar && (w < at.chamfer + tol || w > width - at.chamfer - tol) && Math.abs(rho - dims.da / 2) < at.chamfer + tol) return name("chamfer");
    if (p.kind === "internal" && Math.abs(rho - (at.rim ?? dims.df + 4 * m) / 2) < tol) return name("rim");
    if (Math.abs(rho - dims.da / 2) < tol) return name("tip");
    if (Math.abs(rho - dims.df / 2) < tol) return name("root");
    return name("flank");
  });
}

/** Closed wire through the outline's segments: straight edges, or B-splines through their points. */
function wire(oc: OC, arena: Arena, loop: OutlineSegment[], map: (p: Pt) => Vec3): TopoDS_Wire {
  const vertex = (p: Vec3): TopoDS_Vertex => arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(arena.track(new oc.gp_Pnt(p[0], p[1], p[2])))).Vertex());
  // Consecutive segments share their end points, so they share vertices too.
  const starts = loop.map((s) => vertex(map(s.pts[0]!)));
  const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
  loop.forEach((s, i) => {
    const v0 = starts[i]!;
    const v1 = starts[(i + 1) % loop.length]!;
    let edge: TopoDS_Edge;
    if (s.pts.length === 2) edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v0, v1)).Edge());
    else {
      const pts = arena.track(new oc.NCollection_Array1_gp_Pnt(1, s.pts.length));
      s.pts.forEach((p, k) => {
        const w = map(p);
        pts.SetValue(k + 1, arena.track(new oc.gp_Pnt(w[0], w[1], w[2])));
      });
      const fit = arena.track(new oc.GeomAPI_PointsToBSpline(pts, 3, 8, "GeomAbs_C2" as never, 1e-6));
      edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(arena.track(fit.Curve()), v0, v1)).Edge());
    }
    mw.Add(edge);
  });
  if (!mw.IsDone()) throw new FeatureError("the gear's outline is not closed");
  return arena.track(mw.Wire());
}

function prismOf(oc: OC, arena: Arena, loop: OutlineSegment[], map: (p: Pt) => Vec3, n: Vec3, h: number): TopoDS_Shape {
  const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(wire(oc, arena, loop, map), true)).Face());
  return arena.track(arena.track(new oc.BRepPrimAPI_MakePrism(face, arena.track(new oc.gp_Vec(n[0] * h, n[1] * h, n[2] * h)), false, true)).Shape());
}

function axis2(oc: OC, arena: Arena, origin: Vec3, dir: Vec3, xdir: Vec3) {
  return arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...origin)), arena.track(new oc.gp_Dir(...dir)), arena.track(new oc.gp_Dir(...xdir))));
}

function boolOp(oc: OC, arena: Arena, op: "fuse" | "cut" | "common", a: TopoDS_Shape, b: TopoDS_Shape): TopoDS_Shape {
  const Algo = op === "fuse" ? oc.BRepAlgoAPI_Fuse : op === "cut" ? oc.BRepAlgoAPI_Cut : oc.BRepAlgoAPI_Common;
  const algo = arena.track(new Algo(a, b));
  if (!algo.IsDone() || algo.HasErrors()) throw new FeatureError(`gear ${op} failed`);
  return arena.track(algo.Shape());
}
