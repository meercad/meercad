/**
 * Boxes with lids (snap and screw) and snap hooks, built as solids.
 *
 * Box and lid are built in one local frame in their closed pose (the box from z = 0 up to its rim,
 * centred on the origin, the lid on top), their faces named there, then the lid is laid upside
 * down beside the box unless the layout keeps it closed. Round parts are turned profiles; snap
 * beads and grooves are ruled lofts through outlines grown and shrunk at 45°. Threads are a
 * trapezoid ridge swept along a helix, trimmed to their height and joined to neck and cap.
 */

import { BOX, ClosureError, FeatureError, checkSnapHook, screwBoxSizes, snapBoxSizes, snapHookProfile, snapHookStrain, type ResolvedBox, type ResolvedSnapHook } from "@meercad/model";
import type { PlaneFrame, Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape, TopoDS_Wire, gp_Trsf } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { Builder } from "./builder.js";
import { occtErrorMessage, type OC } from "./occt.js";

const checked = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof ClosureError) throw new FeatureError(e.message);
    throw e;
  }
};

/** Signed distance from a point to a rounded rectangle's outline centred on the origin (positive outside). */
function outlineDistance(x: number, y: number, w: number, h: number, r: number): number {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  const qx = Math.abs(x) - (w / 2 - r), qy = Math.abs(y) - (h / 2 - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}


/**
 * A face's sample point moved onto the face's cylinder (sample points of round faces are triangle
 * centres and lie a little inside), so it can be classed by its distance from the axis.
 */
function samplePoint(oc: OC, arena: Arena, body: Body, i: number): Vec3 {
  const p = body.facePoints[i]!;
  const surf = arena.track(new oc.BRepAdaptor_Surface(body.faces[i]!, true));
  if (surf.GetType() !== "GeomAbs_Cylinder") return p;
  const cyl = arena.track(surf.Cylinder());
  const pos = arena.track(cyl.Position());
  const o = arena.track(pos.Location()), a = arena.track(pos.Direction());
  const v: Vec3 = [p[0] - o.X(), p[1] - o.Y(), p[2] - o.Z()];
  const along = v[0] * a.X() + v[1] * a.Y() + v[2] * a.Z();
  const radial: Vec3 = [v[0] - along * a.X(), v[1] - along * a.Y(), v[2] - along * a.Z()];
  const len = Math.hypot(...radial);
  if (len < 1e-9) return p;
  const k = cyl.Radius() / len;
  return [o.X() + along * a.X() + radial[0] * k, o.Y() + along * a.Y() + radial[1] * k, o.Z() + along * a.Z() + radial[2] * k];
}

class ClosureBuilder extends Builder {
  private tr<T>(x: T): T {
    return this.arena.track(x as never) as T;
  }
  /** A circle (round) or rounded rectangle outline at height z. */
  outline(round: boolean, w: number, h: number, r: number, z: number): TopoDS_Wire {
    if (!round) return this.roundedRect(0, 0, w, h, r, z);
    const { oc } = this;
    const ax = this.tr(new oc.gp_Ax2(this.pnt(0, 0, z), this.tr(new oc.gp_Dir(0, 0, 1)), this.tr(new oc.gp_Dir(1, 0, 0))));
    const edge = this.tr(this.tr(new oc.BRepBuilderAPI_MakeEdge(this.tr(new oc.gp_Circ(ax, w / 2)))).Edge());
    return this.tr(this.tr(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
  }
  /** Ruled loft through outlines: `profile` is [z, inset] pairs from the bottom up (negative insets grow). */
  section(round: boolean, w: number, h: number, r: number, profile: [number, number][]): TopoDS_Shape {
    const { oc } = this;
    const loft = this.tr(new oc.BRepOffsetAPI_ThruSections(true, true, 1e-6));
    for (const [z, d] of profile) loft.AddWire(this.outline(round, w - 2 * d, h - 2 * d, r - d, z));
    loft.Build(this.tr(new oc.Message_ProgressRange()));
    if (!loft.IsDone()) throw new FeatureError("could not build the snap's bead");
    return this.tr(loft.Shape());
  }
  /** An outline extruded from z0 to z1. */
  slab(round: boolean, w: number, h: number, r: number, z0: number, z1: number): TopoDS_Shape {
    if (round) return this.cylinderZ(0, 0, w / 2, z0, z1);
    return this.block(0, 0, w, h, r, z0, z1);
  }
  /** A closed polygon in the x–z plane (points as [r, z]) turned once round the z axis. */
  turned(pts: [number, number][]): TopoDS_Shape {
    const { oc } = this;
    const mw = this.tr(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map(([r, z]) => this.vertex(r, 0, z));
    vs.forEach((v, i) => mw.Add(this.tr(this.tr(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    const face = this.tr(this.tr(new oc.BRepBuilderAPI_MakeFace(this.tr(mw.Wire()), true)).Face());
    const axis = this.tr(new oc.gp_Ax1(this.pnt(0, 0, 0), this.tr(new oc.gp_Dir(0, 0, 1))));
    const rev = this.tr(new oc.BRepPrimAPI_MakeRevol(face, axis, 2 * Math.PI, false));
    if (!rev.IsDone()) throw new FeatureError("could not build the round box");
    return this.tr(rev.Shape());
  }
  /** A closed polygon in the x–z plane (points as [x, z]) extruded along y from y0 to y1. */
  prismY(pts: [number, number][], y0: number, y1: number): TopoDS_Shape {
    const { oc } = this;
    const mw = this.tr(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map(([x, z]) => this.vertex(x, y0, z));
    vs.forEach((v, i) => mw.Add(this.tr(this.tr(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    const face = this.tr(this.tr(new oc.BRepBuilderAPI_MakeFace(this.tr(mw.Wire()), true)).Face());
    return this.tr(this.tr(new oc.BRepPrimAPI_MakePrism(face, this.tr(new oc.gp_Vec(0, y1 - y0, 0)), false, true)).Shape());
  }
  /**
   * A thread ridge round the z axis: the [r, dz] polygon (dz along the axis from the helix) swept
   * along a helix of `lead` starting at height z0 and turned by `phase` (radians), kept between zLo and zHi.
   */
  ridge(profile: [number, number][], lead: number, z0: number, height: number, phase: number, zLo: number, zHi: number): TopoDS_Shape {
    const { oc } = this;
    const x: Vec3 = [Math.cos(phase), Math.sin(phase), 0];
    const rMid = profile.reduce((s, p) => s + p[0], 0) / profile.length;
    const ax3 = this.tr(new oc.gp_Ax3(this.pnt(0, 0, z0), this.tr(new oc.gp_Dir(0, 0, 1)), this.tr(new oc.gp_Dir(...x))));
    const surface = this.tr(new oc.Geom_CylindricalSurface(ax3, rMid));
    const line = this.tr(new oc.Geom2d_Line(this.tr(new oc.gp_Pnt2d(0, 0)), this.tr(new oc.gp_Dir2d(2 * Math.PI, lead))));
    const span = (height / lead) * Math.hypot(2 * Math.PI, lead);
    const edge = this.tr(this.tr(new oc.BRepBuilderAPI_MakeEdge(line, surface, 0, span)).Edge());
    oc.BRepLib.BuildCurves3d(edge);
    const spine = this.tr(this.tr(new oc.BRepBuilderAPI_MakeWire(edge)).Wire());
    const mw = this.tr(new oc.BRepBuilderAPI_MakeWire());
    const vs = profile.map(([r, dz]) => this.vertex(x[0] * r, x[1] * r, z0 + dz));
    vs.forEach((v, i) => mw.Add(this.tr(this.tr(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    const mk = this.tr(new oc.BRepOffsetAPI_MakePipeShell(spine));
    mk.SetMode(this.tr(new oc.gp_Dir(0, 0, 1)));
    mk.Add(this.tr(mw.Wire()), false, false);
    mk.Build(this.tr(new oc.Message_ProgressRange()));
    if (!mk.IsDone()) throw new FeatureError("could not build the thread");
    mk.MakeSolid();
    let swept = this.tr(mk.Shape());
    const props = this.tr(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(swept, props, false, false, false);
    if (props.Mass() < 0) swept = this.tr(swept.Reversed());
    const rMax = Math.max(...profile.map((p) => p[0])) + 1;
    const common = this.tr(new oc.BRepAlgoAPI_Common(swept, this.cylinderZ(0, 0, rMax, zLo, zHi)));
    if (!common.IsDone() || common.HasErrors()) throw new FeatureError("could not trim the thread");
    return this.tr(common.Shape());
  }
  /** Lid laid upside down beside the box: turned over the x axis and moved along x. */
  besides(height: number, dx: number): gp_Trsf {
    const { oc } = this;
    const rot = this.tr(new oc.gp_Trsf());
    rot.SetRotation(this.tr(new oc.gp_Ax1(this.pnt(0, 0, 0), this.tr(new oc.gp_Dir(1, 0, 0)))), Math.PI);
    const move = this.tr(new oc.gp_Trsf());
    move.SetTranslation(this.tr(new oc.gp_Vec(dx, 0, height)));
    move.Multiply(rot);
    return move;
  }
}

// ---------------------------------------------------------------- boxes

export function boxBodies(oc: OC, arena: Arena, f: ResolvedBox, frame: PlaneFrame): Body[] {
  const b = new ClosureBuilder(oc, arena);
  try {
    const { box, lid, lidTop } = f.lid === "screw" ? screwBox(b, f) : snapBox(b, f);
    const placement = b.placement(frame, f.position);
    const out = [b.place(box, placement, f.id)];
    let lidTrsf = placement;
    if ((f.layout ?? "beside") === "beside") {
      lidTrsf = b.placement(frame, f.position);
      lidTrsf.Multiply(b.besides(lidTop, f.width + BOX.layoutGap));
    }
    out.push(b.place(lid, lidTrsf, `${f.id}_lid`));
    return out;
  } catch (e) {
    if (e instanceof FeatureError || e instanceof ClosureError) throw e instanceof ClosureError ? new FeatureError(e.message) : e;
    throw new FeatureError(`could not build the box: ${occtErrorMessage(oc, e)}`);
  }
}

function snapBox(b: ClosureBuilder, f: ResolvedBox): { box: Body; lid: Body; lidTop: number } {
  const s = checked(() => snapBoxSizes(f));
  const round = f.shape === "round";
  const { width: W, depth: D, height: H, wall: t, clearance: c, snap, corner: R, lidThickness: T } = f;
  const [iw, id] = s.inner;
  const ri = s.innerCorner;
  // Box: a shell open at the top, the groove round the inside of the wall at the bead's height.
  const hw = s.beadFlat + c; // half the groove's flat
  const groove: [number, number][] = [
    [s.beadZ - hw - snap, 0.05],
    [s.beadZ - hw, -snap],
    [s.beadZ + hw, -snap],
    [s.beadZ + hw + snap, 0.05],
  ];
  const cuts = [b.slab(round, iw, id, ri, f.floor, H + 1), b.section(round, iw, id, ri, groove)];
  const notch = f.notch !== false;
  const nw = Math.min(BOX.notchWidth, 0.4 * W), nd = BOX.notchDepth;
  if (notch) cuts.push(b.block(0, -D / 2 + t / 2, nw, 2 * t + 2, 0, H - nd, H + 1));
  const boxShape = b.unify(b.bool("cut", b.slab(round, W, D, R, 0, H), cuts));
  const box = new Body(b.oc, b.arena, f.id, boxShape);
  const grooveTop = s.beadZ + hw + snap + 1e-3, grooveBottom = s.beadZ - hw - snap - 1e-3;
  box.faceTags = box.faces.map((_, i) => {
    const p = samplePoint(b.oc, b.arena, box, i);
    const n = box.faceInfo[i]!.normal;
    const name = (x: string) => [`${f.id}.${x}`];
    const up = !!n && n[2] > 0.99, down = !!n && n[2] < -0.99;
    if (down && Math.abs(p[2]) < 1e-6) return name("bottom");
    if (up && Math.abs(p[2] - f.floor) < 1e-6) return name("floor");
    if (up && Math.abs(p[2] - H) < 1e-6) return name("rim");
    if (notch && p[1] < -D / 2 + t + 1e-3 && p[2] > H - nd - 1e-3 && Math.abs(p[0]) < nw / 2 + 1e-3) return name("notch");
    if (Math.abs(outlineDistance(p[0], p[1], W, D, R)) < 1e-3) return name("wall");
    if (p[2] > grooveBottom && p[2] < grooveTop && outlineDistance(p[0], p[1], iw, id, ri) > 1e-3) return name("groove");
    return name("inner");
  });

  // Lid: a plate as large as the box with a lip reaching in; the bead round the lip's outside.
  const [lw, ld] = s.lipOuter;
  const lr = s.lipCorner, L = s.lip;
  const z0 = H - f.lipHeight;
  const lipRing = b.bool("cut", b.slab(round, lw, ld, lr, z0, H + 0.01), [b.slab(round, lw - 2 * L, ld - 2 * L, Math.max(0, lr - L), z0 - 1, H + 0.005)]);
  const bh = s.beadFlat;
  const bead = b.bool("cut", b.section(round, lw, ld, lr, [
    [s.beadZ - bh - snap, 0.05],
    [s.beadZ - bh, -snap],
    [s.beadZ + bh, -snap],
    [s.beadZ + bh + snap, 0.05],
  ]), [b.slab(round, lw - 2 * L + 0.02, ld - 2 * L + 0.02, Math.max(0, lr - L), z0 - 1, H + 1)]);
  const lidShape = b.unify(b.bool("fuse", b.slab(round, W, D, R, H, H + T), [lipRing, bead]));
  const lid = new Body(b.oc, b.arena, `${f.id}_lid`, lidShape);
  lid.faceTags = lid.faces.map((_, i) => {
    const p = samplePoint(b.oc, b.arena, lid, i);
    const n = lid.faceInfo[i]!.normal;
    const name = (x: string) => [`${f.id}.${x}`];
    if (n && n[2] > 0.99 && Math.abs(p[2] - H - T) < 1e-6) return name("lid_top");
    if (n && n[2] < -0.99 && Math.abs(p[2] - H) < 1e-6) return name("lid_under");
    if (p[2] > H - 1e-6 && Math.abs(outlineDistance(p[0], p[1], W, D, R)) < 1e-3) return name("lid_side");
    if (p[2] > s.beadZ - bh - snap - 1e-3 && p[2] < s.beadZ + bh + snap + 1e-3 && outlineDistance(p[0], p[1], lw, ld, lr) > 1e-3) return name("lid_bead");
    return name("lid_lip");
  });
  return { box, lid, lidTop: H + T };
}

function screwBox(b: ClosureBuilder, f: ResolvedBox): { box: Body; lid: Body; lidTop: number } {
  const s = checked(() => screwBoxSizes(f));
  const { height: H, floor: fl, lidThickness: T, pitch: P, starts: n } = f;
  const { radius: R, inner: ri, neckInner: rni, neckOuter: rn, skirt: rs, threadDepth: d, rootWidth: wb, tipWidth: wt, shoulder: sh, capGap: g } = s;
  const lead = n * P;
  const zc = sh - (ri - rni);
  let boxShape = b.turned([[0, 0], [R, 0], [R, sh], [rn, sh], [rn, H], [rni, H], [rni, sh], [ri, zc], [ri, fl], [0, fl]]);
  // Ridges start a lead below the neck and run a lead past it, then are cut to height: the cut ends
  // taper the ridge over a turn, which leads the cap in.
  const e = 0.15;
  const neckProfile: [number, number][] = [[rn - e, -wb / 2 - e], [rn + d, -wt / 2], [rn + d, wt / 2], [rn - e, wb / 2 + e]];
  const capProfile: [number, number][] = [[rs + e, -wb / 2 - e], [rs - d, -wt / 2], [rs - d, wt / 2], [rs + e, wb / 2 + e]];
  const from = sh - lead, span = H - sh + 2 * lead;
  const neckRidges: TopoDS_Shape[] = [], capRidges: TopoDS_Shape[] = [];
  for (let k = 0; k < n; k++) {
    const phase = (2 * Math.PI * k) / n;
    neckRidges.push(b.ridge(neckProfile, lead, from, span, phase, sh + 1, H - 0.8));
    // Closed, the cap's ridges sit half a pitch along, in the neck's grooves.
    capRidges.push(b.ridge(capProfile, lead, from + P / 2, span, phase, sh + g + 0.8, H - 0.3));
  }
  boxShape = b.unify(b.bool("fuse", boxShape, neckRidges));
  const box = new Body(b.oc, b.arena, f.id, boxShape);
  const rad = (p: Vec3) => Math.hypot(p[0], p[1]);
  box.faceTags = box.faces.map((_, i) => {
    const p = samplePoint(b.oc, b.arena, box, i);
    const nrm = box.faceInfo[i]!.normal;
    const name = (x: string) => [`${f.id}.${x}`];
    const up = !!nrm && nrm[2] > 0.99, down = !!nrm && nrm[2] < -0.99;
    const r = rad(p);
    if (down && Math.abs(p[2]) < 1e-6) return name("bottom");
    if (up && Math.abs(p[2] - fl) < 1e-6) return name("floor");
    if (up && Math.abs(p[2] - H) < 1e-6) return name("rim");
    if (up && Math.abs(p[2] - sh) < 1e-6) return name("shoulder");
    if (Math.abs(r - R) < 1e-3) return name("wall");
    if (Math.abs(r - rn) < 1e-3 && p[2] > sh - 1e-6) return name("neck");
    if (r > rn + 1e-3 && r < rn + d + 1e-3 && p[2] > sh) return name("thread");
    return name("inner");
  });

  const capShape = b.unify(b.bool("fuse", b.turned([[0, H], [rs, H], [rs, sh + g], [R, sh + g], [R, H + T], [0, H + T]]), capRidges));
  const lid = new Body(b.oc, b.arena, `${f.id}_lid`, capShape);
  lid.faceTags = lid.faces.map((_, i) => {
    const p = samplePoint(b.oc, b.arena, lid, i);
    const nrm = lid.faceInfo[i]!.normal;
    const name = (x: string) => [`${f.id}.${x}`];
    const r = rad(p);
    if (nrm && nrm[2] > 0.99 && Math.abs(p[2] - H - T) < 1e-6) return name("lid_top");
    if (nrm && nrm[2] < -0.99 && Math.abs(p[2] - H) < 1e-6) return name("lid_under");
    if (nrm && nrm[2] < -0.99 && Math.abs(p[2] - sh - g) < 1e-6) return name("lid_rim");
    if (Math.abs(r - R) < 1e-3) return name("lid_side");
    if (Math.abs(r - rs) < 1e-3) return name("lid_inner");
    return name("lid_thread");
  });
  return { box, lid, lidTop: H + T };
}

// ---------------------------------------------------------------- snap hooks

/** The hooks (one tool body for all points) and, with clearance, the windows they click into. */
export function snapHookTools(oc: OC, arena: Arena, f: ResolvedSnapHook, frame: PlaneFrame, warnings: string[]): { hooks: Body; windows: Body } {
  checked(() => checkSnapHook(f));
  if (!f.points.length) throw new FeatureError("place at least one hook");
  const b = new ClosureBuilder(oc, arena);
  const { thickness: t, overhang: y, width: w, length: L, clearance: c } = f;
  const prof = snapHookProfile(f);
  const strain = snapHookStrain(f);
  if (strain > 0.05) warnings.push(`the hook bends ${(strain * 100).toFixed(1)} % when it snaps: make it longer or thinner, or the overhang smaller`);
  const placed = f.flip ? { ...frame, normal: frame.normal.map((v) => -v) as Vec3, v: frame.v.map((v) => -v) as Vec3 } : frame;

  const hook = new Body(oc, arena, f.id, b.unify(b.prismY(prof.points, -w / 2, w / 2)));
  const catchTop = prof.points[3]![1];
  hook.faceTags = hook.faces.map((_, i) => {
    const p = hook.facePoints[i]!;
    const n = hook.faceInfo[i]!.normal;
    const name = (x: string) => [`${f.id}.${x}`];
    if (!n) return name("lead");
    if (Math.abs(n[1]) > 0.99) return name("side");
    if (n[2] < -0.99 && p[2] < 0) return name("root");
    if (n[2] < 0 && p[2] > L - 1e-3 && p[2] < catchTop + 1e-3) return name("catch");
    if (n[0] > 0.99 && Math.abs(p[0]) < 1e-3) return name("beam");
    if ((n[0] > 0.99 && Math.abs(p[0] - y) < 1e-3) || n[2] > 0.99) return name("tip");
    if (n[0] > 0 && n[2] > 0) return name("lead");
    return name("back");
  });
  const win = new Body(oc, arena, `${f.id}_window`, b.block((y + 10 - c) / 2, 0, y + 10 + c, w + 2 * c, 0, L - c, prof.top + c));
  win.faceTags = win.faces.map(() => [`${f.id}.window`]);

  // One body each for all hooks and all windows, their faces named as the single ones.
  const merge = (one: Body, id: string) => {
    const parts = f.points.map((pt) => b.place(one, b.placement(placed, pt, f.angle), id));
    if (parts.length === 1) return parts[0]!;
    const all = new Body(oc, arena, id, b.compound(parts.map((x) => x.shape)));
    const tags: string[][] = all.faces.map(() => []);
    for (const x of parts)
      x.faces.forEach((face, i) => {
        const j = all.faceIndex(face);
        if (j >= 0) tags[j] = [...(x.faceTags[i] ?? [])];
      });
    all.faceTags = tags.map((t) => (t.length ? t : [`${f.id}.side`]));
    return all;
  };
  return { hooks: merge(hook, f.id), windows: merge(win, `${f.id}_window`) };
}

