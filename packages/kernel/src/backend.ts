import { propagateTags, resolveEdges, resolveFaces, ResolveError, selectorForEdge } from "@leocad/naming";
import {
  FeatureError,
  type ExecResult,
  type KernelBackend,
  type ResolvedChamfer,
  type ResolvedCircularPattern,
  type ResolvedExtrude,
  type ResolvedFeature,
  type ResolvedFillet,
  type ResolvedLinearPattern,
  type ResolvedPlane,
  type ResolvedRevolve,
  type ResolvedShell,
  type ResolvedSketch,
  type ResolvedTransform,
} from "@leocad/model";
import { parseStl } from "@leocad/io";
import { asArray, type AxisRef, type FaceSelector, type BooleanFeature, type BooleanMode, type ImportFeature, type MirrorFeature, type PatternSource, type PlaneSpec, type ProfileRef } from "@leocad/schema";
import {
  findRegions,
  frameFromPlane,
  ORIGIN_FRAMES,
  offsetFrame,
  selectRegions,
  SketchSolveError,
  toSketch,
  toWorld,
  type PlaneFrame,
  type SketchSolver,
  type SolvedCurve,
  type Vec3,
} from "@leocad/sketch";
import type { TopoDS_Shape, gp_Trsf } from "replicad-opencascadejs";
import { Arena } from "./arena.js";
import { Body, listToArray } from "./body.js";
import { booleanBodies, bounds, boundsOverlap, unify } from "./boolean.js";
import { Geom } from "./geom.js";
import { occtErrorMessage, type OC } from "./occt.js";
import type { ModelState, SketchResult, ToolRecord } from "./state.js";

export type { ModelState } from "./state.js";

interface Ctx {
  oc: OC;
  arena: Arena;
  g: Geom;
  prev: ModelState;
  warnings: string[];
}

export class OcctBackend implements KernelBackend<ModelState> {
  constructor(
    private readonly oc: OC,
    private readonly solver: SketchSolver,
  ) {}

  initialState(): ModelState {
    return { bodies: new Map(), sketches: new Map(), planes: new Map(), tools: new Map(), references: new Map(), arena: new Arena() };
  }

  dispose(state: ModelState): void {
    state.arena.dispose();
  }

  execute(f: ResolvedFeature, prev: ModelState): ExecResult<ModelState> {
    const arena = new Arena();
    const ctx: Ctx = { oc: this.oc, arena, g: new Geom(this.oc, arena), prev, warnings: [] };
    try {
      const next = this.run(f, ctx);
      return { state: { ...next, arena }, warnings: ctx.warnings };
    } catch (e) {
      arena.dispose();
      if (e instanceof FeatureError) throw e;
      if (e instanceof ResolveError || e instanceof SketchSolveError) throw new FeatureError(e.message);
      throw new FeatureError(`kernel error: ${occtErrorMessage(this.oc, e)}`);
    }
  }

  private run(f: ResolvedFeature, ctx: Ctx): Omit<ModelState, "arena"> {
    switch (f.op) {
      case "sketch":
        return this.sketch(f, ctx);
      case "plane":
        return plane(f, ctx);
      case "extrude":
        return extrude(f, ctx);
      case "revolve":
        return revolve(f, ctx);
      case "fillet":
      case "chamfer":
        return edgeTreatment(f, ctx);
      case "shell":
        return shell(f, ctx);
      case "linear_pattern":
      case "circular_pattern":
      case "mirror":
        return pattern(f, ctx);
      case "boolean":
        return booleanFeature(f, ctx);
      case "transform":
        return transformFeature(f, ctx);
      case "import":
        return importFeature(f, ctx);
    }
  }

  private sketch(f: ResolvedSketch, ctx: Ctx): Omit<ModelState, "arena"> {
    const frame = planeFrame(f.plane, ctx);
    const external: SolvedCurve[] = [];
    for (const e of f.entities) if (e.type === "projection") external.push(...project(e.id, e.edges, !!e.construction, frame, ctx));
    const solved = this.solver.solve({ entities: f.entities, constraints: f.constraints, external });
    if (solved.diagnostics.message) ctx.warnings.push(solved.diagnostics.message);
    if (solved.diagnostics.redundant.length) ctx.warnings.push(`redundant constraints: ${solved.diagnostics.redundant.join(", ")}`);
    const result: SketchResult = { id: f.id, frame, solved, regions: findRegions(solved.curves) };
    return { ...ctx.prev, sketches: new Map(ctx.prev.sketches).set(f.id, result) };
  }
}

// ---------------------------------------------------------------- references

function planeFrame(spec: PlaneSpec, ctx: Ctx): PlaneFrame {
  if ("ref" in spec) {
    const named = (ORIGIN_FRAMES as Record<string, PlaneFrame>)[spec.ref] ?? ctx.prev.planes.get(spec.ref);
    if (!named) throw new FeatureError(`plane "${spec.ref}" not found`);
    return named;
  }
  const refs = resolveFaces(spec.face, [...ctx.prev.bodies.values()]);
  const count = refs.reduce((n, r) => n + r.faces.length, 0);
  if (count !== 1) throw new FeatureError(`face selector matches ${count} faces; pick exactly one`);
  const body = ctx.prev.bodies.get(refs[0]!.body)!;
  const fi = refs[0]!.faces[0]!;
  const info = body.faceInfo[fi]!;
  if (!info.planar || !info.normal) throw new FeatureError("the selected face is not planar");
  return frameFromPlane(body.facePoints[fi]!, info.normal);
}

function axis(ref: AxisRef, ctx: Ctx): { origin: Vec3; dir: Vec3 } {
  if ("ref" in ref) return { origin: [0, 0, 0], dir: ref.ref === "origin.X" ? [1, 0, 0] : ref.ref === "origin.Y" ? [0, 1, 0] : [0, 0, 1] };
  if ("line" in ref) {
    const [skId, ...rest] = ref.line.split(".");
    const sk = ctx.prev.sketches.get(skId!);
    const curve = sk?.solved.curves.find((c) => c.id === rest.join("."));
    if (!sk || !curve || curve.kind !== "line") throw new FeatureError(`axis line "${ref.line}" not found`);
    const a = toWorld(sk.frame, curve.a);
    const b = toWorld(sk.frame, curve.b);
    return { origin: a, dir: unit([b[0] - a[0], b[1] - a[1], b[2] - a[2]]) };
  }
  const er = resolveEdges([ref.edge], [...ctx.prev.bodies.values()]);
  if (er.edges.length !== 1) throw new FeatureError("axis edge selector must match exactly one edge");
  const edge = ctx.prev.bodies.get(er.body)!.edges[er.edges[0]!]!;
  const c = ctx.arena.track(new ctx.oc.BRepAdaptor_Curve(edge));
  if (c.GetType() !== "GeomAbs_Line") {
    if (c.GetType() === "GeomAbs_Circle") {
      const ax = ctx.arena.track(ctx.arena.track(c.Circle()).Axis());
      const p = ctx.arena.track(ax.Location());
      const d = ctx.arena.track(ax.Direction());
      return { origin: [p.X(), p.Y(), p.Z()], dir: [d.X(), d.Y(), d.Z()] };
    }
    throw new FeatureError("axis edge must be straight or circular");
  }
  const p0 = ctx.arena.track(c.Value(c.FirstParameter()));
  const p1 = ctx.arena.track(c.Value(c.LastParameter()));
  return { origin: [p0.X(), p0.Y(), p0.Z()], dir: unit([p1.X() - p0.X(), p1.Y() - p0.Y(), p1.Z() - p0.Z()]) };
}

function project(id: string, edges: Parameters<typeof resolveEdges>[0], construction: boolean, frame: PlaneFrame, ctx: Ctx): SolvedCurve[] {
  const ref = resolveEdges(edges, [...ctx.prev.bodies.values()]);
  const body = ctx.prev.bodies.get(ref.body)!;
  return ref.edges.map((ei, k) => {
    const cid = `${id}.${k}`;
    const c = ctx.arena.track(new ctx.oc.BRepAdaptor_Curve(body.edges[ei]!));
    const first = c.FirstParameter();
    const last = c.LastParameter();
    const at = (u: number) => {
      const p = ctx.arena.track(c.Value(u));
      return toSketch(frame, [p.X(), p.Y(), p.Z()]);
    };
    const type = c.GetType();
    if (type === "GeomAbs_Line") return { id: cid, kind: "line", a: at(first), b: at(last), p1: `${cid}.p1`, p2: `${cid}.p2`, construction, external: true };
    if (type === "GeomAbs_Circle") {
      const circ = ctx.arena.track(c.Circle());
      const ax = ctx.arena.track(ctx.arena.track(circ.Axis()).Direction());
      const n: Vec3 = [ax.X(), ax.Y(), ax.Z()];
      const cosN = n[0] * frame.normal[0] + n[1] * frame.normal[1] + n[2] * frame.normal[2];
      if (Math.abs(cosN) < 1 - 1e-6) throw new FeatureError("only circles parallel to the sketch plane can be projected");
      const loc = ctx.arena.track(circ.Location());
      const center = toSketch(frame, [loc.X(), loc.Y(), loc.Z()]);
      const radius = circ.Radius();
      if (Math.abs(last - first - 2 * Math.PI) < 1e-6) return { id: cid, kind: "circle", center, radius, c: `${cid}.center`, construction, external: true };
      let [s, e] = [at(first), at(last)];
      if (cosN < 0) [s, e] = [e, s];
      const ang = (p: [number, number]) => Math.atan2(p[1] - center[1], p[0] - center[0]);
      return { id: cid, kind: "arc", center, radius, a0: ang(s), a1: ang(e), c: `${cid}.center`, start: `${cid}.start`, end: `${cid}.end`, construction, external: true };
    }
    throw new FeatureError("only straight and circular edges can be projected");
  });
}

function sketchRegions(profile: Extract<ProfileRef, { sketch: string }>, ctx: Ctx) {
  const sk = ctx.prev.sketches.get(profile.sketch);
  if (!sk) throw new FeatureError(`sketch "${profile.sketch}" is missing or failed`);
  const { regions, missing } = selectRegions(sk.regions, profile.regions);
  if (missing.length) throw new FeatureError(`sketch region(s) no longer exist: ${missing.join(", ")}`);
  if (!regions.length) throw new FeatureError(`sketch "${profile.sketch}" has no closed region`);
  return { sk, regions };
}

const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function modelSize(ctx: Ctx): number {
  let size = 100;
  for (const b of ctx.prev.bodies.values()) {
    const bb = bounds(ctx.oc, ctx.arena, b.shape);
    size = Math.max(size, ...bb.max.map(Math.abs), ...bb.min.map(Math.abs));
  }
  return size * 4;
}

// ---------------------------------------------------------------- features

function plane(f: ResolvedPlane, ctx: Ctx): Omit<ModelState, "arena"> {
  const frame = offsetFrame(planeFrame(f.base, ctx), f.offset, f.angle ?? 0);
  return { ...ctx.prev, planes: new Map(ctx.prev.planes).set(f.id, frame) };
}

/** Tags the solid of a sweep from history and fuses multiple region solids into one tool. */
function sweepTool(
  ctx: Ctx,
  featureId: string,
  faces: ReturnType<Geom["regionFaces"]>,
  sketchId: string,
  make: (face: TopoDS_Shape) => { shape: TopoDS_Shape; first: TopoDS_Shape | null; last: TopoDS_Shape | null; generated: (s: TopoDS_Shape) => TopoDS_Shape[] },
): Body {
  const { oc, arena } = ctx;
  let tool: Body | null = null;
  for (const { face, edges } of faces) {
    const r = make(face);
    const body = new Body(oc, arena, featureId, r.shape);
    const tags: string[][] = body.faces.map(() => []);
    const tag = (s: TopoDS_Shape | null, t: string) => s && tags[body.faceIndex(s)]?.push(t);
    tag(r.first, `${featureId}.start_cap`);
    tag(r.last, `${featureId}.end_cap`);
    for (const { edge, name } of edges) for (const s of r.generated(edge)) tag(s, `${featureId}.side[${sketchId}.${name}]`);
    body.faceTags = tags.map((t, i) => (t.length ? t : [`${featureId}.face[${i}]`]));
    tool = tool ? booleanBodies(oc, arena, tool, body, "fuse", featureId) : body;
  }
  return tool!;
}

/** Push/pull: extrudes a planar model face along its outward normal. */
function extrudeFace(f: ResolvedExtrude & { profile: { face: FaceSelector } }, ctx: Ctx): Omit<ModelState, "arena"> {
  const refs = resolveFaces(f.profile.face, [...ctx.prev.bodies.values()]);
  if (refs.reduce((n, r) => n + r.faces.length, 0) !== 1) throw new FeatureError("push/pull needs exactly one face");
  const body = ctx.prev.bodies.get(refs[0]!.body)!;
  const fi = refs[0]!.faces[0]!;
  const info = body.faceInfo[fi]!;
  if (!info.planar || !info.normal) throw new FeatureError("push/pull works on flat faces");
  const n = f.flip ? (info.normal.map((v) => -v) as Vec3) : info.normal;
  const d = f.extent === "through_all" ? modelSize(ctx) : f.distance;
  if (Math.abs(d) < 1e-6) throw new FeatureError("extrude distance must not be zero");
  const face = body.faces[fi]!;
  const prism = ctx.arena.track(new ctx.oc.BRepPrimAPI_MakePrism(face, ctx.g.vec([n[0] * d, n[1] * d, n[2] * d]), true, true));
  if (!prism.IsDone()) throw new FeatureError("extrude failed");
  const tool = new Body(ctx.oc, ctx.arena, f.id, ctx.arena.track(prism.Shape()));
  const tags: string[][] = tool.faces.map(() => []);
  const tag = (s: TopoDS_Shape, t: string) => tags[tool.faceIndex(s)]?.push(t);
  tag(ctx.arena.track(prism.FirstShape()), `${f.id}.start_cap`);
  tag(ctx.arena.track(prism.LastShape()), `${f.id}.end_cap`);
  // Side faces are named after the model face on the other side of each boundary edge.
  const ex = ctx.arena.track(new ctx.oc.TopExp_Explorer(face, "TopAbs_EDGE"));
  for (let k = 0; ex.More(); ex.Next(), k++) {
    const edge = ctx.arena.track(ex.Current());
    const ei = body.edgeIndex(edge);
    const other = (body.edgeFaces[ei] ?? []).find((x) => x !== fi);
    const name = other !== undefined ? (body.faceTags[other]?.[0] ?? `e${k}`) : `e${k}`;
    for (const s of listToArray(ctx.arena, prism.Generated(edge))) tag(s, `${f.id}.side[${name}]`);
  }
  tool.faceTags = tags.map((t, i) => (t.length ? t : [`${f.id}.face[${i}]`]));
  const mode = f.mode === "new_body" ? "new_body" : f.mode;
  return applyTool(ctx, f.id, tool, mode, f.targets ?? (mode === "new_body" ? undefined : [body.bodyId]));
}

function extrude(f: ResolvedExtrude, ctx: Ctx): Omit<ModelState, "arena"> {
  if ("face" in f.profile) return extrudeFace(f as ResolvedExtrude & { profile: { face: FaceSelector } }, ctx);
  const { sk, regions } = sketchRegions(f.profile, ctx);
  const dir: Vec3 = f.flip ? [-sk.frame.normal[0], -sk.frame.normal[1], -sk.frame.normal[2]] : sk.frame.normal;
  let start = 0;
  let length = f.distance;
  if (f.extent === "symmetric") {
    start = -f.distance / 2;
  } else if (f.extent === "two_sided") {
    start = -(f.distance2 ?? 0);
    length = f.distance + (f.distance2 ?? 0);
  } else if (f.extent === "through_all") {
    length = modelSize(ctx);
    if (f.mode === "cut" || f.mode === "intersect") start = -length / 2;
  }
  if (Math.abs(length) < 1e-6) throw new FeatureError("extrude distance must not be zero");
  const frame: PlaneFrame = { ...sk.frame, origin: [sk.frame.origin[0] + dir[0] * start, sk.frame.origin[1] + dir[1] * start, sk.frame.origin[2] + dir[2] * start] };
  const faces = ctx.g.regionFaces(frame, regions);
  const vec = ctx.g.vec([dir[0] * length, dir[1] * length, dir[2] * length]);
  const tool = sweepTool(ctx, f.id, faces, sk.id, (face) => {
    const prism = ctx.arena.track(new ctx.oc.BRepPrimAPI_MakePrism(face, vec, false, true));
    if (!prism.IsDone()) throw new FeatureError("extrude failed");
    return {
      shape: ctx.arena.track(prism.Shape()),
      first: ctx.arena.track(prism.FirstShape()),
      last: ctx.arena.track(prism.LastShape()),
      generated: (s) => listToArray(ctx.arena, prism.Generated(s)),
    };
  });
  return applyTool(ctx, f.id, tool, f.mode, f.targets);
}

function revolve(f: ResolvedRevolve, ctx: Ctx): Omit<ModelState, "arena"> {
  if ("face" in f.profile) throw new FeatureError("revolve needs a sketch profile");
  const { sk, regions } = sketchRegions(f.profile, ctx);
  const ax = axis(f.axis, ctx);
  const angle = Math.max(-360, Math.min(360, f.angle));
  if (Math.abs(angle) < 1e-6) throw new FeatureError("revolve angle must not be zero");
  const full = Math.abs(Math.abs(angle) - 360) < 1e-9;
  const faces = ctx.g.regionFaces(sk.frame, regions);
  const gpAx = ctx.g.ax1(ax.origin, ax.dir);
  let tool = sweepTool(ctx, f.id, faces, sk.id, (face) => {
    const rev = ctx.arena.track(new ctx.oc.BRepPrimAPI_MakeRevol(face, gpAx, (angle * Math.PI) / 180, false));
    if (!rev.IsDone()) throw new FeatureError("revolve failed (does the profile cross the axis?)");
    return {
      shape: ctx.arena.track(rev.Shape()),
      first: full ? null : ctx.arena.track(rev.FirstShape()),
      last: full ? null : ctx.arena.track(rev.LastShape()),
      generated: (s) => listToArray(ctx.arena, rev.Generated(s)),
    };
  });
  if (f.symmetric && !full) tool = transformBody(ctx, tool, ctx.g.rotation(ax.origin, ax.dir, -angle / 2), f.id);
  return applyTool(ctx, f.id, tool, f.mode, f.targets);
}

/** Copy of a body under a transform; tags get `suffix` appended (for pattern instances). */
function transformBody(ctx: Ctx, body: Body, trsf: gp_Trsf, id: string, suffix = ""): Body {
  const t = ctx.g.transform(body.shape, trsf);
  const out = new Body(ctx.oc, ctx.arena, id, t.shape);
  const tags: string[][] = out.faces.map(() => []);
  body.faces.forEach((face, i) => {
    const j = out.faceIndex(t.map(face));
    if (j >= 0) tags[j]!.push(...(body.faceTags[i] ?? []).map((tag) => tag + suffix));
  });
  out.faceTags = tags.map((tg, i) => (tg.length ? tg : [`${id}.face[${i}]`]));
  return out;
}

/** Combines a tool solid with the model according to the boolean mode. */
function applyTool(ctx: Ctx, featureId: string, tool: Body, mode: BooleanMode, targets?: string[], newBodyId = featureId): Omit<ModelState, "arena"> {
  const bodies = new Map(ctx.prev.bodies);
  const tools = new Map(ctx.prev.tools).set(featureId, { mode, body: tool } satisfies ToolRecord);
  if (mode === "new_body") {
    let body = tool;
    if (newBodyId !== tool.bodyId) {
      body = new Body(ctx.oc, ctx.arena, newBodyId, tool.shape);
      body.faceTags = body.faces.map((face) => [...(tool.faceTags[tool.faceIndex(face)] ?? [])]);
    }
    bodies.set(newBodyId, body);
    return { ...ctx.prev, bodies, tools };
  }
  const tb = bounds(ctx.oc, ctx.arena, tool.shape);
  const candidates = targets?.length
    ? targets.map((t) => {
        const b = bodies.get(t);
        if (!b) throw new FeatureError(`target body "${t}" not found`);
        return b;
      })
    : [...bodies.values()].filter((b) => boundsOverlap(bounds(ctx.oc, ctx.arena, b.shape), tb));
  if (!candidates.length) {
    if (mode === "join") {
      ctx.warnings.push("nothing to join; created a new body");
      bodies.set(newBodyId, tool);
      return { ...ctx.prev, bodies, tools };
    }
    throw new FeatureError(mode === "cut" ? "nothing to cut: the tool does not touch any body" : "no body to intersect with");
  }
  if (mode === "join") {
    let merged = booleanBodies(ctx.oc, ctx.arena, candidates[0]!, tool, "fuse");
    for (const other of candidates.slice(1)) {
      merged = booleanBodies(ctx.oc, ctx.arena, merged, other, "fuse");
      bodies.delete(other.bodyId);
    }
    bodies.set(merged.bodyId, merged);
  } else {
    let changed = 0;
    for (const target of candidates) {
      try {
        bodies.set(target.bodyId, booleanBodies(ctx.oc, ctx.arena, target, tool, mode === "cut" ? "cut" : "common"));
        changed++;
      } catch (e) {
        if (mode === "intersect") bodies.delete(target.bodyId);
        else if (!(e instanceof FeatureError)) throw e;
      }
    }
    if (mode === "cut" && changed === 0) throw new FeatureError("nothing to cut: the tool does not intersect any body");
  }
  return { ...ctx.prev, bodies, tools };
}

function edgeTreatment(f: ResolvedFillet | ResolvedChamfer, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  const size = f.op === "fillet" ? f.radius : f.distance;
  const what = f.op === "fillet" ? "fillet radius" : "chamfer distance";
  if (!(size > 0)) throw new FeatureError(`${what} must be greater than zero`);
  const ref = resolveEdges(asArray(f.edges), [...ctx.prev.bodies.values()]);
  const input = ctx.prev.bodies.get(ref.body)!;

  const attempt = (r: number) => {
    const mk = f.op === "fillet" ? arena.track(new oc.BRepFilletAPI_MakeFillet(input.shape, "ChFi3d_Rational")) : arena.track(new oc.BRepFilletAPI_MakeChamfer(input.shape));
    for (const ei of ref.edges) mk.Add(r, input.edges[ei]!);
    try {
      mk.Build();
    } catch {
      return null;
    }
    if (!mk.IsDone()) return null;
    const shape = arena.track(mk.Shape());
    const check = arena.track(new oc.BRepCheck_Analyzer(shape, true, false, false));
    return check.IsValid() ? { mk, shape } : null;
  };

  const ok = attempt(size);
  if (!ok) {
    let r = size;
    for (let i = 0; i < 6; i++) {
      r /= 2;
      if (attempt(r)) throw new FeatureError(`${f.op} of ${fmt(size)} mm failed`, `${fmt(r)} mm works; the edges or neighbouring faces may be too short for ${fmt(size)} mm`);
    }
    throw new FeatureError(`${f.op} of ${fmt(size)} mm failed`, "the selected edges cannot be treated");
  }
  const { mk, shape } = ok;
  const body = new Body(oc, arena, input.bodyId, shape);
  const descendants = input.faces.map((face) => {
    if (mk.IsDeleted(face)) return [];
    const modified = listToArray(arena, mk.Modified(face)).map((s) => body.faceIndex(s));
    if (modified.length) return modified.filter((i) => i >= 0);
    const same = body.faceIndex(face);
    return same >= 0 ? [same] : [];
  });
  const generated: { face: number; tag: string }[] = [];
  const kind = f.op === "fillet" ? "round" : "bevel";
  for (const ei of ref.edges) {
    const sel = selectorForEdge(input, ei);
    const name = sel && "edge" in sel ? sel.edge.join("|") : `edge${ei}`;
    for (const s of listToArray(arena, mk.Generated(input.edges[ei]!))) {
      const i = body.faceIndex(s);
      if (i >= 0) generated.push({ face: i, tag: `${f.id}.${kind}[${name}]` });
    }
  }
  body.faceTags = propagateTags(input.faceTags, body.faces.length, { descendants, generated }, `${f.id}.blend`).tags;
  return { ...ctx.prev, bodies: new Map(ctx.prev.bodies).set(body.bodyId, body) };
}

function shell(f: ResolvedShell, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  if (!(f.thickness > 0)) throw new FeatureError("shell thickness must be greater than zero");
  if (!f.faces.length) throw new FeatureError("select at least one face to remove");
  const refs = f.faces.flatMap((s) => resolveFaces(s, [...ctx.prev.bodies.values()]));
  const bodyIds = new Set(refs.map((r) => r.body));
  if (bodyIds.size !== 1) throw new FeatureError("shell faces must belong to one body");
  const input = ctx.prev.bodies.get([...bodyIds][0]!)!;
  const list = arena.track(new oc.NCollection_List_TopoDS_Shape());
  for (const r of refs) for (const fi of r.faces) list.Append(input.faces[fi]!);
  const mk = arena.track(new oc.BRepOffsetAPI_MakeThickSolid());
  try {
    mk.MakeThickSolidByJoin(input.shape, list, f.outward ? f.thickness : -f.thickness, 1e-3);
  } catch (e) {
    throw new FeatureError(`shell failed: ${occtErrorMessage(oc, e)}`, "try a smaller thickness");
  }
  if (!mk.IsDone()) throw new FeatureError("shell failed", "try a smaller thickness or remove fewer faces");
  const body = new Body(oc, arena, input.bodyId, arena.track(mk.Shape()));
  const descendants = input.faces.map((face) => {
    const same = body.faceIndex(face);
    if (same >= 0) return [same];
    return listToArray(arena, mk.Modified(face)).map((s) => body.faceIndex(s)).filter((i) => i >= 0).slice(0, 1);
  });
  const claimed = new Set(descendants.flat());
  const generated: { face: number; tag: string }[] = [];
  input.faces.forEach((face, i) => {
    const tag = input.faceTags[i]?.[0];
    if (!tag) return;
    for (const s of [...listToArray(arena, mk.Modified(face)), ...listToArray(arena, mk.Generated(face))]) {
      const j = body.faceIndex(s);
      if (j >= 0 && !claimed.has(j)) generated.push({ face: j, tag: `${f.id}.inner[${tag}]` });
    }
  });
  body.faceTags = propagateTags(input.faceTags, body.faces.length, { descendants, generated }, `${f.id}.face`).tags;
  return { ...ctx.prev, bodies: new Map(ctx.prev.bodies).set(body.bodyId, body) };
}

function pattern(f: ResolvedLinearPattern | ResolvedCircularPattern | MirrorFeature, ctx: Ctx): Omit<ModelState, "arena"> {
  const transforms: gp_Trsf[] = [];
  if (f.op === "linear_pattern") {
    const d1 = axis(f.direction, ctx).dir;
    const d2 = f.direction2 ? axis(f.direction2, ctx).dir : null;
    const n2 = d2 ? (f.count2 ?? 1) : 1;
    for (let j = 0; j < n2; j++) {
      for (let i = 0; i < f.count; i++) {
        if (i === 0 && j === 0) continue;
        const s1 = f.spacing * i;
        const s2 = (f.spacing2 ?? 0) * j;
        transforms.push(ctx.g.translation([0, 1, 2].map((k) => d1[k]! * s1 + (d2 ? d2[k]! * s2 : 0)) as Vec3));
      }
    }
  } else if (f.op === "circular_pattern") {
    const ax = axis(f.axis, ctx);
    const total = f.angle ?? 360;
    const step = Math.abs(Math.abs(total) - 360) < 1e-9 ? total / f.count : total / Math.max(1, f.count - 1);
    for (let i = 1; i < f.count; i++) transforms.push(ctx.g.rotation(ax.origin, ax.dir, step * i));
  } else {
    transforms.push(ctx.g.mirror(planeFrame(f.plane, ctx)));
  }
  if (!transforms.length) throw new FeatureError("pattern needs a count of at least 2");
  return replicate(ctx, f.id, f.source, transforms);
}

function replicate(ctx: Ctx, featureId: string, source: PatternSource, transforms: gp_Trsf[]): Omit<ModelState, "arena"> {
  let state: Omit<ModelState, "arena"> = ctx.prev;
  const step = (fn: (c: Ctx) => Omit<ModelState, "arena">) => {
    state = fn({ ...ctx, prev: { ...state, arena: ctx.arena } });
  };
  if ("features" in source) {
    for (const sid of source.features) {
      const rec = ctx.prev.tools.get(sid);
      if (!rec) throw new FeatureError(`feature "${sid}" cannot be patterned (only extrude and revolve)`);
      transforms.forEach((t, k) => {
        const copy = transformBody(ctx, rec.body, t, `${featureId}_${k + 1}`, `@${featureId}.${k + 1}`);
        const newId = source.features.length > 1 ? `${featureId}_${sid}_${k + 1}` : `${featureId}_${k + 1}`;
        step((c) => {
          const r = applyTool(c, `${featureId}#${sid}#${k}`, copy, rec.mode, undefined, newId);
          return { ...r, tools: c.prev.tools };
        });
      });
    }
  } else {
    for (const bid of source.bodies) {
      const body = ctx.prev.bodies.get(bid);
      if (!body) throw new FeatureError(`body "${bid}" not found`);
      transforms.forEach((t, k) => {
        const newId = source.bodies.length > 1 ? `${featureId}_${bid}_${k + 1}` : `${featureId}_${k + 1}`;
        const copy = transformBody(ctx, body, t, newId, `@${featureId}.${k + 1}`);
        step((c) => ({ ...c.prev, bodies: new Map(c.prev.bodies).set(newId, copy) }));
      });
    }
  }
  return state;
}

function booleanFeature(f: BooleanFeature, ctx: Ctx): Omit<ModelState, "arena"> {
  const bodies = new Map(ctx.prev.bodies);
  const get = (id: string) => {
    const b = bodies.get(id);
    if (!b) throw new FeatureError(`body "${id}" not found`);
    return b;
  };
  let target = get(f.target);
  const op = f.operation === "union" ? "fuse" : f.operation === "subtract" ? "cut" : "common";
  for (const t of f.tools) {
    target = booleanBodies(ctx.oc, ctx.arena, target, get(t), op, f.target);
    if (!f.keepTools) bodies.delete(t);
  }
  bodies.set(f.target, target);
  return { ...ctx.prev, bodies };
}

function transformFeature(f: ResolvedTransform, ctx: Ctx): Omit<ModelState, "arena"> {
  // Rotation first, then translation: combined = T · R.
  const combined = ctx.g.translation(f.translate ?? [0, 0, 0]);
  if (f.rotate) {
    const ax = axis(f.rotate.axis, ctx);
    combined.Multiply(ctx.g.rotation(ax.origin, ax.dir, f.rotate.angle));
  }
  return moveBodies(ctx, f, new Map(ctx.prev.bodies), combined);
}

function moveBodies(ctx: Ctx, f: ResolvedTransform, bodies: Map<string, Body>, trsf: gp_Trsf): Omit<ModelState, "arena"> {
  for (const id of f.bodies) {
    const body = bodies.get(id);
    if (!body) throw new FeatureError(`body "${id}" not found`);
    const newId = f.copy ? `${f.id}_${id}` : id;
    bodies.set(newId, transformBody(ctx, body, trsf, newId, f.copy ? `@${f.id}` : ""));
  }
  return { ...ctx.prev, bodies };
}

function importFeature(f: ImportFeature, ctx: Ctx): Omit<ModelState, "arena"> {
  const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  if (f.format === "stl") {
    const mesh = parseStl(bytes);
    return { ...ctx.prev, references: new Map(ctx.prev.references).set(f.id, { id: f.id, ...mesh }) };
  }
  const { oc, arena } = ctx;
  const path = `/import-${f.id}.step`;
  oc.FS.writeFile(path, bytes);
  try {
    const reader = arena.track(new oc.STEPControl_Reader());
    if (String(reader.ReadFile(path)) !== "IFSelect_RetDone") throw new FeatureError(`could not read STEP file "${f.fileName}"`);
    reader.TransferRoots();
    const shape = arena.track(reader.OneShape());
    const body = new Body(oc, arena, f.id, shape);
    if (!body.faces.length) throw new FeatureError(`STEP file "${f.fileName}" contains no faces`);
    body.faceTags = body.faces.map((_, i) => [`${f.id}.face[${i}]`]);
    return { ...ctx.prev, bodies: new Map(ctx.prev.bodies).set(f.id, unifyIfNeeded(ctx, body)) };
  } finally {
    oc.FS.unlink(path);
  }
}

function unifyIfNeeded(ctx: Ctx, body: Body): Body {
  return body.faces.length > 2000 ? body : unify(ctx.oc, ctx.arena, body);
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
