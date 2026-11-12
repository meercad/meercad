import { parseStl, writeStl } from "@meercad/io";
import { propagateTags, type resolveEdges, ResolveError, selectorForEdge } from "@meercad/naming";
import {
  FeatureError,
  type ExecResult,
  type KernelBackend,
  type ResolvedChamfer,
  type ResolvedCoil,
  type ResolvedCircularPattern,
  type ResolvedExtrude,
  type ResolvedFeature,
  type ResolvedFillet,
  type ResolvedLinearPattern,
  type ResolvedMeshConvert,
  type ResolvedBend,
  bendMeshes,
  BendError,
  defaultBendTolerance,
  bendInfoRecord,
  type ResolvedHole,
  type ResolvedSplit,
  holeShape,
  type InsertDims,
  insertLengths,
  HoleError,
  type ResolvedPlane,
  type ResolvedRevolve,
  type ResolvedRib,
  type ResolvedDraft,
  type ResolvedOffsetFace,
  type ResolvedText,
  type ResolvedPrimitive,
  type ResolvedStandardPart,
  type ResolvedSnapHook,
  type ResolvedAlign,
  type ResolvedScale,
  standardShape,
  StandardPartError,
  type ResolvedShell,
  type ResolvedSketch,
  type ResolvedTransform,
  type ResolvedGridfinity,
  type BinPlan,
  GRIDFINITY,
  planScanBin,
  ScanBinError,
  type Footprint,
} from "@meercad/model";
import { asArray, type AxisRef, type FaceSelector, type BooleanFeature, type BooleanMode, type ImportFeature, type LoftFeature, type MirrorFeature, type PatternSource, type PlaneSpec, type ProfileRef, type SweepFeature } from "@meercad/schema";
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
} from "@meercad/sketch";
import type { TopoDS_Edge, TopoDS_Face, TopoDS_Shape, TopoDS_Vertex, TopoDS_Wire, gp_Trsf } from "replicad-opencascadejs";
import { Arena } from "./arena.js";
import { copyMap, trackState } from "./tracking.js";
import { edgesIn, facesIn, partsReaching, reach } from "./lookup.js";
import { Body, listToArray } from "./body.js";
import { bodyBounds, booleanBodies, bounds, boundsOverlap, unify } from "./boolean.js";
import { Geom } from "./geom.js";
import { gearBody } from "./gear.js";
import { areaPlateBodies, gridfinityBody, labelBodies, type BinPocket, type OutlineRegion } from "./gridfinity.js";
import { boxBodies, snapHookTools } from "./closures.js";
import { wallBody } from "./wall.js";
import { lithophaneBody } from "./lithophane.js";
import { convertMesh } from "./meshconvert.js";
import { holeTools } from "./hole.js";
import { joinPieces } from "./splitjoint.js";
import { nest, textLoops } from "./text.js";
import { standardPartBody } from "./standardPart.js";
import { threadBody } from "./thread.js";
import { helixWire, springBody } from "./coil.js";
import { screwBody } from "./screw.js";
import { cableBody } from "./cable.js";
import { occtErrorMessage, type OC } from "./occt.js";
import type { ModelState, SketchResult, ToolRecord } from "./state.js";

export type { ModelState } from "./state.js";

interface Ctx {
  oc: OC;
  arena: Arena;
  g: Geom;
  prev: ModelState;
  warnings: string[];
  info?: Record<string, number>;
  /** What this step made on another state before (see KernelBackend.execute); `kept` once a part of it is used again. */
  earlier?: { state: ModelState; kept: boolean };
}

/** For a moved or copied part: the part it was made from and how (see transformBody). */
const movedFrom = new WeakMap<Body, { source: Body; how: string }>();

export class OcctBackend implements KernelBackend<ModelState> {
  constructor(
    private readonly oc: OC,
    private readonly solver: SketchSolver,
  ) {}

  initialState(): ModelState {
    return { bodies: new Map(), sketches: new Map(), planes: new Map(), tools: new Map(), references: new Map(), gears: new Map(), arena: new Arena() };
  }

  dispose(state: ModelState): void {
    state.arena.dispose();
  }

  execute(f: ResolvedFeature, prev: ModelState, note?: (footprint: Footprint<ModelState>) => void, earlier?: ModelState): ExecResult<ModelState> {
    const arena = new Arena();
    // Noting what the step reads, so a later rebuild can take its result over (tracking.ts).
    const tracked = note ? trackState(prev) : null;
    const ctx: Ctx = { oc: this.oc, arena, g: new Geom(this.oc, arena), prev: tracked?.view ?? prev, warnings: [], ...(earlier ? { earlier: { state: earlier, kept: false } } : {}) };
    try {
      const state = { ...this.run(f, ctx), arena };
      arena.trim();
      if (ctx.earlier?.kept) arena.adopt(earlier!.arena);
      if (tracked) {
        const fp = tracked.finish(state);
        if (fp) note!(fp);
      }
      return { state, warnings: ctx.warnings, ...(ctx.info ? { info: ctx.info } : {}), ...(ctx.earlier?.kept ? { keepsEarlier: true } : {}) };
    } catch (e) {
      arena.dispose();
      if (tracked) {
        const fp = tracked.finish(null);
        if (fp) note!(fp);
      }
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
      case "loft":
        return loft(f, ctx);
      case "sweep":
        return sweep(f, ctx);
      case "split":
        return split(f, ctx);
      case "rib":
        return rib(f, ctx);
      case "draft":
        return draft(f, ctx);
      case "offset_face":
        return offsetFace(f, ctx);
      case "text":
        return textFeature(f, ctx);
      case "primitive":
        return primitiveFeature(f, ctx);
      case "standard_part":
        return standardPartFeature(f, ctx);
      case "align":
        return alignFeature(f, ctx);
      case "scale":
        return scaleFeature(f, ctx);
      case "fillet":
      case "chamfer":
        return edgeTreatment(f, ctx);
      case "shell":
        return shell(f, ctx);
      case "thread": {
        const { body } = threadBody(ctx.oc, ctx.arena, ctx.prev.bodies, f);
        return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(body.bodyId, body) };
      }
      case "gear": {
        const partner = f.meshWith ? ctx.prev.gears.get(f.meshWith.gear) : undefined;
        if (f.meshWith && !partner) throw new FeatureError(`gear "${f.meshWith.gear}" not found`);
        const frame = partner ? partner.frame : planeFrame(f.plane ?? { ref: "origin.XY" }, ctx);
        const { body, record } = gearBody(ctx.oc, ctx.arena, f, frame, partner);
        return { ...applyTool(ctx, f.id, body, f.mode, f.targets), gears: copyMap(ctx.prev.gears).set(f.id, record) };
      }
      case "coil":
        return coil(f, ctx);
      case "spring": {
        const { body, info } = springBody(ctx.oc, ctx.arena, f, planeFrame(f.plane ?? { ref: "origin.XY" }, ctx), ctx.warnings);
        ctx.info = { pitch: round3(info.pitch), totalCoils: round3(info.totalCoils), height: round3(info.height), solidHeight: round3(info.solidHeight), rateSteel: round3(info.rateSteel), meanDiameter: round3(info.meanDiameter) };
        return applyTool(ctx, f.id, body, f.mode, f.targets);
      }
      case "screw": {
        const { body, info } = screwBody(ctx.oc, ctx.arena, f, planeFrame(f.plane ?? { ref: "origin.XY" }, ctx), ctx.warnings);
        ctx.info = { pitch: info.pitch, height: round3(info.height) };
        return applyTool(ctx, f.id, body, f.mode, f.targets);
      }
      case "cable": {
        const { body, info } = cableBody(ctx.oc, ctx.arena, f, ctx.warnings);
        ctx.info = { length: round3(info.length), mass: round3(info.mass), bendRadius: round3(info.bendRadius), ...(Number.isFinite(info.minRadius) ? { minRadius: round3(info.minRadius) } : {}) };
        return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(f.id, body) };
      }
      case "gridfinity": {
        const plate = f.baseplate ? ctx.prev.grids?.get(f.baseplate) : undefined;
        if (f.baseplate && !plate) throw new FeatureError(`baseplate "${f.baseplate}" not found`);
        if (f.kind === "baseplate" && (f.outline || f.bed || f.drawer)) {
          let frame: PlaneFrame;
          let outline: OutlineRegion[] | undefined;
          if (f.outline) {
            const { sk, regions } = sketchRegions(f.outline, ctx);
            frame = sk.frame;
            outline = regions.map((r) => ({ outer: r.polygons[0]!.map((p) => [p[0], p[1]] as [number, number]), holes: r.polygons.slice(1).map((h) => h.map((p) => [p[0], p[1]] as [number, number])) }));
          } else frame = planeFrame(f.plane ?? { ref: "origin.XY" }, ctx);
          const out = areaPlateBodies(ctx.oc, ctx.arena, f, frame, outline, ctx.warnings);
          ctx.info = out.info;
          const bodies = copyMap(ctx.prev.bodies);
          for (const b of out.bodies) bodies.set(b.bodyId, b);
          return { ...ctx.prev, bodies, grids: copyMap(ctx.prev.grids).set(f.id, out.record) };
        }
        let frame = planeFrame(f.plane ?? { ref: "origin.XY" }, ctx);
        const pocket = f.kind === "bin" && f.pocket ? pocketFor(f, frame, ctx) : undefined;
        if (pocket) {
          // Built round the part: the bin's rim at the part's sinking line.
          const lift = pocket.plan.rim - pocket.plan.height * GRIDFINITY.unit;
          frame = { ...frame, origin: frame.origin.map((v, k) => v + frame.normal[k]! * lift) as Vec3 };
          ctx.info = { width: pocket.plan.units[0], depth: pocket.plan.units[1], height: pocket.plan.height, pocketDepth: round3(pocket.plan.depth), angle: round3((pocket.plan.angle * 180) / Math.PI) };
        }
        const { body, record } = gridfinityBody(ctx.oc, ctx.arena, f, frame, plate, ctx.warnings, pocket);
        const bodies = copyMap(ctx.prev.bodies).set(f.id, body);
        return { ...ctx.prev, bodies, ...(record ? { grids: copyMap(ctx.prev.grids).set(f.id, record) } : {}) };
      }
      case "wall": {
        const board = f.board ? ctx.prev.walls?.get(f.board) : undefined;
        if (f.board && !board) throw new FeatureError(`board "${f.board}" not found`);
        const frame = planeFrame(f.plane ?? { ref: "origin.XY" }, ctx);
        const { body, record } = wallBody(ctx.oc, ctx.arena, f, frame, board, ctx.warnings);
        const bodies = copyMap(ctx.prev.bodies).set(f.id, body);
        return { ...ctx.prev, bodies, ...(record ? { walls: copyMap(ctx.prev.walls).set(f.id, record) } : {}) };
      }
      case "lithophane": {
        const { body, texture } = lithophaneBody(ctx.oc, ctx.arena, f, planeFrame(f.plane ?? { ref: "origin.XY" }, ctx));
        return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(f.id, body), textures: copyMap(ctx.prev.textures).set(f.id, texture) };
      }
      case "label": {
        const bodies = copyMap(ctx.prev.bodies);
        for (const b of labelBodies(ctx.oc, ctx.arena, f, planeFrame(f.plane ?? { ref: "origin.XY" }, ctx), ctx.warnings)) bodies.set(b.bodyId, b);
        return { ...ctx.prev, bodies };
      }
      case "box": {
        const bodies = copyMap(ctx.prev.bodies);
        for (const b of boxBodies(ctx.oc, ctx.arena, f, planeFrame(f.plane ?? { ref: "origin.XY" }, ctx))) bodies.set(b.bodyId, b);
        return { ...ctx.prev, bodies };
      }
      case "snap_hook":
        return snapHookFeature(f, ctx);
      case "linear_pattern":
      case "circular_pattern":
      case "mirror":
        return pattern(f, ctx);
      case "boolean":
        return booleanFeature(f, ctx);
      case "transform":
        return transformFeature(f, ctx);
      case "delete": {
        const bodies = copyMap(ctx.prev.bodies);
        for (const id of f.bodies) if (!bodies.delete(id)) throw new FeatureError(`body "${id}" not found`);
        return { ...ctx.prev, bodies };
      }
      case "import":
        return importFeature(f, ctx);
      case "mesh_convert":
        return meshConvertFeature(f, ctx);
      case "bend":
        return bendFeature(f, ctx);
      case "hole":
        return holeFeature(f, ctx);
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
    return { ...ctx.prev, sketches: copyMap(ctx.prev.sketches).set(f.id, result) };
  }
}

// ---------------------------------------------------------------- references

function planeFrame(spec: PlaneSpec, ctx: Ctx): PlaneFrame {
  if ("ref" in spec) {
    const named = (ORIGIN_FRAMES as Record<string, PlaneFrame>)[spec.ref] ?? ctx.prev.planes.get(spec.ref);
    if (!named) throw new FeatureError(`plane "${spec.ref}" not found`);
    return named;
  }
  const refs = facesIn(ctx.prev.bodies, spec.face);
  const faces = refs.flatMap((r) => r.faces.map((fi) => ({ body: ctx.prev.bodies.get(r.body)!, fi })));
  if (!faces.length) throw new FeatureError("face selector matches no face");
  const planes = faces.map(({ body, fi }) => ({ info: body.faceInfo[fi]!, point: body.facePoints[fi]! }));
  if (planes.some((p) => !p.info.planar || !p.info.normal)) throw new FeatureError(faces.length === 1 ? "the selected face is not planar" : `face selector matches ${faces.length} faces; pick exactly one`);
  // Pieces of one face (a top split by raised text or a rib) all lie in the same plane: that plane.
  const [first, ...rest] = planes;
  const n = first!.info.normal!;
  const coplanar = rest.every((p) => {
    const m = p.info.normal!;
    const d = [0, 1, 2].reduce((acc, k) => acc + (p.point[k]! - first!.point[k]!) * n[k]!, 0);
    return n[0] * m[0] + n[1] * m[1] + n[2] * m[2] > 1 - 1e-9 && Math.abs(d) < 1e-6;
  });
  if (!coplanar) throw new FeatureError(`face selector matches ${faces.length} faces; pick exactly one`);
  return frameFromPlane(first!.point, n);
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
  const er = edgesIn(ctx.prev.bodies, [ref.edge]);
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
  const ref = edgesIn(ctx.prev.bodies, edges);
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
  return reach(ctx.oc, ctx.prev.bodies) * 4;
}

// ---------------------------------------------------------------- features

function plane(f: ResolvedPlane, ctx: Ctx): Omit<ModelState, "arena"> {
  const frame = offsetFrame(planeFrame(f.base, ctx), f.offset, f.angle ?? 0);
  return { ...ctx.prev, planes: copyMap(ctx.prev.planes).set(f.id, frame) };
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

/**
 * Push/pull: extrudes a planar model face along its outward normal. A curved face is thickened
 * along its surface instead (outward adds material, inward with `flip` cuts it away).
 */
function extrudeFace(f: ResolvedExtrude & { profile: { face: FaceSelector } }, ctx: Ctx): Omit<ModelState, "arena"> {
  const refs = facesIn(ctx.prev.bodies, f.profile.face);
  if (refs.reduce((n, r) => n + r.faces.length, 0) !== 1) throw new FeatureError("push/pull needs exactly one face");
  const body = ctx.prev.bodies.get(refs[0]!.body)!;
  const fi = refs[0]!.faces[0]!;
  const info = body.faceInfo[fi]!;
  const d = f.extent === "through_all" ? modelSize(ctx) : f.distance;
  if (Math.abs(d) < 1e-6) throw new FeatureError("extrude distance must not be zero");
  const face = body.faces[fi]!;
  if (!info.planar || !info.normal) return thickenFace(f, ctx, body, face, f.flip ? -d : d);
  const n = f.flip ? (info.normal.map((v) => -v) as Vec3) : info.normal;
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

/** Curved push/pull: a slab between the face and its offset surface, joined to or cut from the part. */
function thickenFace(f: ResolvedExtrude, ctx: Ctx, body: Body, face: TopoDS_Shape, offset: number): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  const volume = (s: TopoDS_Shape) => {
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(s, props, false, false, false);
    return Math.abs(props.Mass());
  };
  // OCCT offsets along the surface's own normal, which on some faces (a chamfer's cone) points into
  // the material. A thin probe slab shows which way is out: it lies outside the part if so.
  const probe = thicken(ctx, face, Math.min(0.05, Math.abs(offset) / 2));
  const common = arena.track(new oc.BRepAlgoAPI_Common(body.shape, probe));
  const inward = common.IsDone() && !common.HasErrors() && volume(arena.track(common.Shape())) > volume(probe) / 2;
  const slab = thicken(ctx, face, inward ? -offset : offset);
  const tool = new Body(oc, arena, f.id, slab);
  tool.faceTags = tool.faces.map((_, i) => [`${f.id}.face[${i}]`]);
  const mode = f.mode === "new_body" ? "new_body" : f.mode;
  return applyTool(ctx, f.id, tool, mode, f.targets ?? (mode === "new_body" ? undefined : [body.bodyId]));
}

/** The solid between a face and its offset by `offset` along the face's surface normal. */
function thicken({ oc, arena }: Ctx, face: TopoDS_Shape, offset: number): TopoDS_Shape {
  const mk = arena.track(new oc.BRepOffsetAPI_MakeThickSolid());
  try {
    mk.MakeThickSolidBySimple(face, offset);
  } catch (e) {
    throw new FeatureError(`push/pull failed on this curved face: ${occtErrorMessage(oc, e)}`, "try a smaller distance");
  }
  if (!mk.IsDone()) throw new FeatureError("push/pull failed on this curved face", "try a smaller distance");
  // Thickening can yield an inside-out solid, and the slab shares its face with the part; booleans
  // reject both (an empty result), so the solid is reoriented and copied onto fresh topology.
  const solids = arena.track(new oc.TopExp_Explorer(arena.track(mk.Shape()), "TopAbs_SOLID"));
  if (!solids.More()) throw new FeatureError("push/pull failed on this curved face", "try a smaller distance");
  const solid = arena.track(oc.TopoDS.Solid(arena.track(solids.Current())));
  oc.BRepLib.OrientClosedSolid(solid);
  return arena.track(arena.track(new oc.BRepBuilderAPI_Transform(solid, arena.track(new oc.gp_Trsf()), true, false)).Shape());
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

/** One loft or sweep profile as a face: a single sketch region, or a flat model face. */
function profileFace(p: ProfileRef, ctx: Ctx, what: string): TopoDS_Face {
  if ("sketch" in p) {
    const { sk, regions } = sketchRegions(p, ctx);
    if (regions.length !== 1) throw new FeatureError(`${what}: sketch "${sk.id}" has ${regions.length} closed regions, pick one`);
    return ctx.g.regionFaces(sk.frame, regions)[0]!.face;
  }
  const refs = facesIn(ctx.prev.bodies, p.face);
  if (refs.reduce((n, r) => n + r.faces.length, 0) !== 1) throw new FeatureError(`${what}: pick exactly one face`);
  const body = ctx.prev.bodies.get(refs[0]!.body)!;
  const fi = refs[0]!.faces[0]!;
  if (!body.faceInfo[fi]?.planar) throw new FeatureError(`${what}: the face must be flat`);
  return ctx.oc.TopoDS.Face(body.faces[fi]!);
}

/** The outer wire of a face and its holes. */
function faceWires({ oc, arena }: Ctx, face: TopoDS_Face): { outer: TopoDS_Wire; holes: TopoDS_Wire[] } {
  const outer = arena.track(oc.BRepTools.OuterWire(face));
  const holes: TopoDS_Wire[] = [];
  for (const e = arena.track(new oc.TopExp_Explorer(face, "TopAbs_WIRE")); e.More(); e.Next()) {
    const w = arena.track(oc.TopoDS.Wire(arena.track(e.Current())));
    if (!w.IsSame(outer)) holes.push(w);
  }
  return { outer, holes };
}

function centroid({ oc, arena }: Ctx, s: TopoDS_Shape): Vec3 {
  const props = arena.track(new oc.GProp_GProps());
  oc.BRepGProp.LinearProperties(s, props, false, false);
  const c = arena.track(props.CentreOfMass());
  return [c.X(), c.Y(), c.Z()];
}

/** A solid through wires in order; faces tagged start_cap, end_cap and side[k]. */
function thruSections(ctx: Ctx, id: string, wires: TopoDS_Wire[], ruled: boolean): Body {
  const { oc, arena } = ctx;
  const loft = arena.track(new oc.BRepOffsetAPI_ThruSections(true, ruled, 1e-6));
  for (const w of wires) loft.AddWire(w);
  try {
    loft.Build(arena.track(new oc.Message_ProgressRange()));
  } catch (e) {
    throw new FeatureError(`loft failed: ${occtErrorMessage(oc, e)}`, "profiles with very different shapes or crossing each other cannot be joined");
  }
  if (!loft.IsDone()) throw new FeatureError("loft failed: the profiles could not be joined", "check that the profiles lie on different planes and do not cross");
  const body = new Body(oc, arena, id, arena.track(loft.Shape()));
  const first = body.faceIndex(arena.track(loft.FirstShape()));
  const last = body.faceIndex(arena.track(loft.LastShape()));
  let k = 0;
  body.faceTags = body.faces.map((_, i) => [i === first ? `${id}.start_cap` : i === last ? `${id}.end_cap` : `${id}.side[${k++}]`]);
  return body;
}

/**
 * Loft through the profiles in order. Profiles with the same number of holes give a hollow loft:
 * the holes are lofted too (each paired with the nearest one, relative to its profile) and cut out.
 */
function loft(f: LoftFeature, ctx: Ctx): Omit<ModelState, "arena"> {
  if (f.profiles.length < 2) throw new FeatureError("a loft needs at least two profiles");
  const wires = f.profiles.map((p, i) => faceWires(ctx, profileFace(p, ctx, `profile ${i + 1}`)));
  let tool = thruSections(ctx, f.id, wires.map((w) => w.outer), !!f.ruled);
  const holes = wires[0]!.holes.length;
  if (wires.some((w) => w.holes.length !== holes)) throw new FeatureError("all profiles need the same number of holes for a hollow loft");
  if (holes) {
    const centres = wires.map((w) => ({ outer: centroid(ctx, w.outer), holes: w.holes.map((h) => centroid(ctx, h)) }));
    const rel = (k: number, h: number): Vec3 => {
      const c = centres[k]!;
      return [c.holes[h]![0] - c.outer[0], c.holes[h]![1] - c.outer[1], c.holes[h]![2] - c.outer[2]];
    };
    const cuts: Body[] = [];
    for (let h = 0; h < holes; h++) {
      const chain = [wires[0]!.holes[h]!];
      let prev = rel(0, h);
      for (let k = 1; k < wires.length; k++) {
        let best = 0;
        let bestD = Infinity;
        for (let j = 0; j < holes; j++) {
          const r = rel(k, j);
          const d = Math.hypot(r[0] - prev[0], r[1] - prev[1], r[2] - prev[2]);
          if (d < bestD) [best, bestD] = [j, d];
        }
        chain.push(wires[k]!.holes[best]!);
        prev = rel(k, best);
      }
      cuts.push(thruSections(ctx, f.id, chain, !!f.ruled));
    }
    tool = booleanBodies(ctx.oc, ctx.arena, tool, cuts, "cut", f.id);
  }
  return applyTool(ctx, f.id, tool, f.mode, f.targets);
}

/**
 * The sweep path as a wire: the sketch's lines and arcs (non-construction, or the listed ones),
 * chained end to end. One chain without branches, open or closed.
 */
function pathWire(f: SweepFeature, ctx: Ctx): TopoDS_Wire {
  const { oc, arena, g } = ctx;
  const sk = ctx.prev.sketches.get(f.path.sketch);
  if (!sk) throw new FeatureError(`path sketch "${f.path.sketch}" is missing or failed`);
  const wanted = f.path.curves;
  const missing = wanted?.filter((id) => !sk.solved.curves.some((c) => c.id === id)) ?? [];
  if (missing.length) throw new FeatureError(`path curve(s) no longer exist: ${missing.join(", ")}`);
  const curves = sk.solved.curves.filter((c) => (wanted ? wanted.includes(c.id) : !c.construction && !c.external));
  if (!curves.length) throw new FeatureError(`path sketch "${sk.id}" has no lines, arcs or splines`);
  if (curves.some((c) => c.kind === "circle") && curves.length > 1) throw new FeatureError("a circle can only be a path on its own");
  // Shared vertices at shared ends, so the edges connect exactly.
  const tol = 1e-6 * Math.max(1, ...curves.flatMap((c) => (c.kind === "line" ? [...c.a, ...c.b] : c.kind === "spline" ? c.pts.flat() : [...c.center, c.radius]).map(Math.abs)));
  const verts: { p: [number, number]; v: TopoDS_Vertex; n: number }[] = [];
  const vertex = (p: [number, number]) => {
    let hit = verts.find((x) => Math.hypot(x.p[0] - p[0], x.p[1] - p[1]) < tol * 100);
    if (!hit) verts.push((hit = { p, v: g.vertex(toWorld(sk.frame, p)), n: 0 }));
    hit.n++;
    return hit;
  };
  const edges: { edge: TopoDS_Edge; ends: [number, number] }[] = curves.map((c) => {
    if (c.kind === "line") {
      const a = vertex(c.a), b = vertex(c.b);
      return { edge: arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(a.v, b.v)).Edge()), ends: [verts.indexOf(a), verts.indexOf(b)] };
    }
    if (c.kind === "spline") {
      const a = vertex(c.pts[0]!), b = vertex(c.pts[c.pts.length - 1]!);
      return { edge: g.splineEdge(sk.frame, c.pts, a.v, b.v), ends: [verts.indexOf(a), verts.indexOf(b)] };
    }
    const circ = arena.track(new oc.gp_Circ(arena.track(new oc.gp_Ax2(g.pnt(toWorld(sk.frame, c.center)), g.dir(sk.frame.normal), g.dir(sk.frame.u))), c.radius));
    if (c.kind === "circle") return { edge: arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(circ)).Edge()), ends: [-1, -1] };
    const at = (t: number): [number, number] => [c.center[0] + c.radius * Math.cos(t), c.center[1] + c.radius * Math.sin(t)];
    const a = vertex(at(c.a0)), b = vertex(at(c.a1));
    return { edge: arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(circ, a.v, b.v)).Edge()), ends: [verts.indexOf(a), verts.indexOf(b)] };
  });
  if (verts.some((x) => x.n > 2)) throw new FeatureError("the path branches: it must be one chain of lines and arcs", "list the curves to follow in path.curves");
  // Walk the chain from an open end (or anywhere when closed).
  const order: number[] = [];
  const used = new Set<number>();
  let at = verts.findIndex((x) => x.n === 1);
  let next = at < 0 ? 0 : edges.findIndex((e) => e.ends.includes(at));
  if (at < 0) at = edges[0]!.ends[0];
  while (next >= 0) {
    order.push(next);
    used.add(next);
    const e = edges[next]!;
    at = e.ends[0] === at ? e.ends[1] : e.ends[0];
    next = edges.findIndex((x, i) => !used.has(i) && x.ends.includes(at));
  }
  if (order.length !== edges.length) throw new FeatureError("the path has gaps: its lines and arcs must join end to end");
  const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
  for (const i of order) mw.Add(edges[i]!.edge);
  if (!mw.IsDone()) throw new FeatureError("the path has gaps: its lines and arcs must join end to end");
  return arena.track(mw.Wire());
}

/** The profile moved along the path, turning with it (corrected Frenet frame). */
function sweep(f: SweepFeature, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  const spine = pathWire(f, ctx);
  const make = (face: TopoDS_Shape) => {
    let pipe;
    try {
      // OCCT's default frame for pipes is the corrected Frenet one.
      pipe = arena.track(new oc.BRepOffsetAPI_MakePipe(spine, face));
    } catch (e) {
      throw new FeatureError(`sweep failed: ${occtErrorMessage(oc, e)}`, "a profile too large for a tight bend makes the sweep cross itself");
    }
    if (!pipe.IsDone()) throw new FeatureError("sweep failed", "a profile too large for a tight bend makes the sweep cross itself");
    return {
      shape: arena.track(pipe.Shape()),
      first: arena.track(pipe.FirstShape()),
      last: arena.track(pipe.LastShape()),
      generated: (s: TopoDS_Shape) => listToArray(arena, pipe.Generated(s)),
    };
  };
  let tool: Body;
  if ("sketch" in f.profile) {
    const { sk, regions } = sketchRegions(f.profile, ctx);
    tool = sweepTool(ctx, f.id, ctx.g.regionFaces(sk.frame, regions), sk.id, make);
  } else {
    const r = make(profileFace(f.profile, ctx, "profile"));
    tool = new Body(oc, arena, f.id, r.shape);
    tool.faceTags = tool.faces.map((_, i) => [`${f.id}.face[${i}]`]);
  }
  return applyTool(ctx, f.id, tool, f.mode, f.targets);
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Coil: each profile region swept along a helix round the axis. The helix runs through the region's
 * centre (its distance from the axis is the radius), so the profile keeps its place and shape.
 */
function coil(f: ResolvedCoil, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  const ax = axis(f.axis, ctx);
  const dir: Vec3 = f.flip ? [-ax.dir[0], -ax.dir[1], -ax.dir[2]] : ax.dir;
  if (!(f.pitch > 0)) throw new FeatureError("the pitch must be greater than zero");
  if (!(f.turns > 0)) throw new FeatureError("the coil needs at least a fraction of a turn");
  if (f.turns > 500) throw new FeatureError("at most 500 turns");
  const taper = f.taper ?? 0;
  if (Math.abs(taper) >= 60) throw new FeatureError("the taper must be between −60° and 60°");
  const rel = (p: Vec3): Vec3 => [p[0] - ax.origin[0], p[1] - ax.origin[1], p[2] - ax.origin[2]];
  const dotv = (p: Vec3, q: Vec3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  let rMax = 0;
  let rMin = Infinity;
  const make = (face: TopoDS_Shape) => {
    // Samples of the profile's outline: how far it reaches from the axis and along it.
    const zs: number[] = [];
    for (const ex = arena.track(new oc.TopExp_Explorer(face, "TopAbs_EDGE")); ex.More(); ex.Next()) {
      const c = arena.track(new oc.BRepAdaptor_Curve(oc.TopoDS.Edge(arena.track(ex.Current()))));
      for (let k = 0; k <= 16; k++) {
        const p = arena.track(c.Value(c.FirstParameter() + ((c.LastParameter() - c.FirstParameter()) * k) / 16));
        const v = rel([p.X(), p.Y(), p.Z()]);
        const z = dotv(v, dir);
        const r = Math.hypot(v[0] - dir[0] * z, v[1] - dir[1] * z, v[2] - dir[2] * z);
        zs.push(z);
        rMax = Math.max(rMax, r);
        rMin = Math.min(rMin, r);
      }
    }
    if (rMin < 1e-4) throw new FeatureError("the profile touches or crosses the axis", "draw the profile beside the axis, like half a thread tooth");
    const height = Math.max(...zs) - Math.min(...zs);
    if (f.turns > 1 && height >= f.pitch - 1e-6) throw new FeatureError(`the profile is ${height.toFixed(2)} mm tall along the axis, as much as the pitch: the turns would run into each other`, "raise the pitch or make the profile smaller");
    const cen = centroid(ctx, face);
    const v = rel(cen);
    const z = dotv(v, dir);
    const radial: Vec3 = [v[0] - dir[0] * z, v[1] - dir[1] * z, v[2] - dir[2] * z];
    const r = Math.hypot(...radial);
    if (r < 1e-4) throw new FeatureError("the profile's centre lies on the axis", "draw the profile beside the axis");
    const origin: Vec3 = [ax.origin[0] + dir[0] * z, ax.origin[1] + dir[1] * z, ax.origin[2] + dir[2] * z];
    const spine = helixWire(oc, arena, { origin, dir, xdir: [radial[0] / r, radial[1] / r, radial[2] / r] }, r, f.pitch, f.turns, !!f.leftHanded, taper);
    if (taper < 0 && r - f.turns * f.pitch * Math.tan((-taper * Math.PI) / 180) <= rMax - r + 1e-3) throw new FeatureError("the taper narrows the coil onto its axis", "use fewer turns or a smaller taper");
    // The profile keeps its place in the plane through the axis all the way round: its binormal
    // stays the axis, as for threads. The plain pipe (corrected Frenet) turned it about the helix,
    // ~14° per turn at r = 21, P = 5. A profile with holes has more than one wire and is swept
    // whole; there the turn stays.
    const wires: TopoDS_Shape[] = [];
    for (const ex = arena.track(new oc.TopExp_Explorer(face, "TopAbs_WIRE")); ex.More(); ex.Next()) wires.push(arena.track(ex.Current()));
    let built: { shape: TopoDS_Shape; first: TopoDS_Shape; last: TopoDS_Shape; generated: (s: TopoDS_Shape) => TopoDS_Shape[] };
    try {
      if (wires.length === 1) {
        const mk = arena.track(new oc.BRepOffsetAPI_MakePipeShell(spine));
        mk.SetMode(arena.track(new oc.gp_Dir(dir[0], dir[1], dir[2])));
        mk.Add(wires[0]!, false, false);
        mk.Build();
        if (!mk.IsDone()) throw new FeatureError("coil failed");
        mk.MakeSolid();
        built = { shape: arena.track(mk.Shape()), first: arena.track(mk.FirstShape()), last: arena.track(mk.LastShape()), generated: (s) => listToArray(arena, mk.Generated(s)) };
      } else {
        const pipe = arena.track(new oc.BRepOffsetAPI_MakePipe(spine, face));
        if (!pipe.IsDone()) throw new FeatureError("coil failed");
        built = { shape: arena.track(pipe.Shape()), first: arena.track(pipe.FirstShape()), last: arena.track(pipe.LastShape()), generated: (s) => listToArray(arena, pipe.Generated(s)) };
      }
    } catch (e) {
      if (e instanceof FeatureError) throw e;
      throw new FeatureError(`coil failed: ${occtErrorMessage(oc, e)}`);
    }
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(built.shape, props, false, false, false);
    if (props.Mass() < 0) built.shape = arena.track(built.shape.Reversed());
    return built;
  };
  let tool: Body;
  if ("sketch" in f.profile) {
    const { sk, regions } = sketchRegions(f.profile, ctx);
    tool = sweepTool(ctx, f.id, ctx.g.regionFaces(sk.frame, regions), sk.id, make);
  } else {
    const r = make(profileFace(f.profile, ctx, "profile"));
    tool = new Body(oc, arena, f.id, r.shape);
    tool.faceTags = tool.faces.map((_, i) => [`${f.id}.face[${i}]`]);
  }
  ctx.info = { height: round3(f.pitch * f.turns), radius: round3(rMax) };
  return applyTool(ctx, f.id, tool, f.mode, f.targets);
}

/** Uniform scaling of parts about their own centre (box middle) or the origin. */
function scaleFeature(f: ResolvedScale, ctx: Ctx): Omit<ModelState, "arena"> {
  if (!(f.factor > 0)) throw new FeatureError("the scale factor must be greater than zero");
  if (!f.bodies.length) throw new FeatureError("pick the parts to scale");
  const bodies = copyMap(ctx.prev.bodies);
  for (const id of f.bodies) {
    const body = bodies.get(id);
    if (!body) throw new FeatureError(`part "${id}" not found`);
    const b = bodyBounds(ctx.oc, body);
    const c: Vec3 = f.center === "origin" ? [0, 0, 0] : [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
    const t = ctx.arena.track(new ctx.oc.gp_Trsf());
    t.SetScale(ctx.g.pnt(c), f.factor);
    bodies.set(id, transformBody(ctx, body, t, id));
  }
  return { ...ctx.prev, bodies };
}

/** A flat face's plane (point, outward normal) or a round face's axis, and the part it belongs to. */
function faceGeometry(sel: FaceSelector, round: boolean, ctx: Ctx, what: string): { body: string; origin: Vec3; dir: Vec3 } {
  const refs = facesIn(ctx.prev.bodies, sel);
  if (refs.reduce((n, r) => n + r.faces.length, 0) !== 1) throw new FeatureError(`${what}: pick exactly one face`);
  const body = ctx.prev.bodies.get(refs[0]!.body)!;
  const fi = refs[0]!.faces[0]!;
  if (!round) {
    const info = body.faceInfo[fi]!;
    if (!info.planar || !info.normal) throw new FeatureError(`${what}: the face must be flat`);
    return { body: body.bodyId, origin: body.facePoints[fi]!, dir: info.normal };
  }
  const surf = ctx.arena.track(new ctx.oc.BRepAdaptor_Surface(body.faces[fi]!, true));
  const type = surf.GetType();
  const ax = type === "GeomAbs_Cylinder" ? ctx.arena.track(ctx.arena.track(surf.Cylinder()).Axis()) : null;
  if (!ax) throw new FeatureError(`${what}: the face must be round (a hole, a shaft)`);
  const p = ctx.arena.track(ax.Location());
  const d = ctx.arena.track(ax.Direction());
  return { body: body.bodyId, origin: [p.X(), p.Y(), p.Z()], dir: [d.X(), d.Y(), d.Z()] };
}

/** Rotation about `at` that turns direction `a` onto `b` (half a turn about `fallback` when they are opposite). */
function turnOnto(ctx: Ctx, a: Vec3, b: Vec3, at: Vec3, fallback: Vec3): gp_Trsf {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = Math.hypot(...cross);
  if (len < 1e-12) return dot > 0 ? ctx.arena.track(new ctx.oc.gp_Trsf()) : ctx.g.rotation(at, fallback, 180);
  return ctx.g.rotation(at, [cross[0] / len, cross[1] / len, cross[2] / len], (Math.atan2(len, dot) * 180) / Math.PI);
}

/**
 * Align: flat faces mate (normals opposed, the moving face in the target's plane, it keeps its place
 * within that plane) or lie flush with `flip`; round faces get the same axis (the part keeps its
 * place along it). Then `offset` along the target's normal or axis and `angle` about it.
 */
function alignFeature(f: ResolvedAlign, ctx: Ctx): Omit<ModelState, "arena"> {
  const round = "axisOf" in f.from;
  if (round !== "axisOf" in f.to) throw new FeatureError("align needs two flat faces or two round faces");
  const from = faceGeometry("face" in f.from ? f.from.face : f.from.axisOf, round, ctx, "the face to move");
  const to = faceGeometry("face" in f.to ? f.to.face : f.to.axisOf, round, ctx, "the target face");
  const bodies = f.bodies?.length ? f.bodies : [from.body];
  if (bodies.includes(to.body)) throw new FeatureError("the target face belongs to a part being moved", "pick a face on another part");
  const n = to.dir;
  const want: Vec3 = round ? (f.flip ? [-n[0], -n[1], -n[2]] : n) : f.flip ? n : [-n[0], -n[1], -n[2]];
  // Any direction across the moving face, for half turns.
  const across: Vec3 = Math.abs(from.dir[0]) < 0.9 ? unit([0, -from.dir[2], from.dir[1]]) : unit([-from.dir[2], 0, from.dir[0]]);
  const rot = turnOnto(ctx, from.dir, want, from.origin, across);
  // Where the face's point (or the axis point) ends up after turning: it stays put, being the centre.
  const p = from.origin;
  const d: Vec3 = [to.origin[0] - p[0], to.origin[1] - p[1], to.origin[2] - p[2]];
  const along = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
  const off = f.offset ?? 0;
  // Faces: move along the normal onto the plane. Axes: move across onto the line.
  const move: Vec3 = round ? [d[0] - n[0] * along + n[0] * off, d[1] - n[1] * along + n[1] * off, d[2] - n[2] * along + n[2] * off] : [n[0] * (along + off), n[1] * (along + off), n[2] * (along + off)];
  const combined = ctx.g.translation(move);
  combined.Multiply(rot);
  if (f.angle) {
    const spin = ctx.g.rotation([p[0] + move[0], p[1] + move[1], p[2] + move[2]], n, f.angle);
    spin.Multiply(combined);
    return moveBodies(ctx, { id: f.id, bodies } as ResolvedTransform, copyMap(ctx.prev.bodies), spin);
  }
  return moveBodies(ctx, { id: f.id, bodies } as ResolvedTransform, copyMap(ctx.prev.bodies), combined);
}

/** Standard parts: one new part per point (ids np1, np1_2, …). */
function standardPartFeature(f: ResolvedStandardPart, ctx: Ctx): Omit<ModelState, "arena"> {
  if (!f.points.length) throw new FeatureError("place at least one part");
  let shape;
  try {
    shape = standardShape(f.kind, { size: f.size, length: f.length, diameter: f.diameter, height: f.height, moving: f.withMoving });
  } catch (e) {
    if (e instanceof StandardPartError) throw new FeatureError(e.message);
    throw e;
  }
  const plane = planeFrame(f.plane, ctx);
  // Rails and brackets lie along u; `angle` turns them in the plane.
  const rad = ((f.angle ?? 0) * Math.PI) / 180, co = Math.cos(rad), si = Math.sin(rad);
  const turned = rad ? { ...plane, u: [0, 1, 2].map((i) => plane.u[i]! * co + plane.v[i]! * si) as Vec3, v: [0, 1, 2].map((i) => plane.v[i]! * co - plane.u[i]! * si) as Vec3 } : plane;
  const bodies = copyMap(ctx.prev.bodies);
  f.points.forEach((p, k) => {
    const id = k === 0 ? f.id : `${f.id}_${k + 1}`;
    // The point is in the plane as it is; only the part is turned about it.
    const frame = { ...turned, origin: toWorld(plane, p) };
    bodies.set(id, standardPartBody(ctx.oc, ctx.arena, id, frame, [0, 0], shape, !!f.flip));
    // The moving part (carriage, nut) is a part of its own: "np1_carriage", "np1_2_nut".
    if (shape.moving) bodies.set(`${id}_${shape.moving.suffix}`, standardPartBody(ctx.oc, ctx.arena, `${id}_${shape.moving.suffix}`, frame, [0, 0], { ...shape.moving.shape, label: shape.moving.label }, !!f.flip));
  });
  return { ...ctx.prev, bodies };
}

/**
 * Snap hooks: the windows are cut into the `catchIn` parts first, then the hooks join the part
 * under the face (or `targets`), never the parts they click into.
 */
function snapHookFeature(f: ResolvedSnapHook, ctx: Ctx): Omit<ModelState, "arena"> {
  const frame = planeFrame(f.plane, ctx);
  const { hooks, windows } = snapHookTools(ctx.oc, ctx.arena, f, frame, ctx.warnings);
  const catchIn = f.catchIn ?? [];
  const bodies = copyMap(ctx.prev.bodies);
  for (const id of catchIn) {
    const target = bodies.get(id);
    if (!target) throw new FeatureError(`part "${id}" not found`);
    if (!boundsOverlap(bodyBounds(ctx.oc, target), bodyBounds(ctx.oc, windows))) {
      ctx.warnings.push(`the hooks' barbs do not reach "${id}": no window cut`);
      continue;
    }
    bodies.set(id, booleanBodies(ctx.oc, ctx.arena, target, windows, "cut"));
  }
  const after = { ...ctx, prev: { ...ctx.prev, bodies } };
  const mode = f.mode ?? "join";
  let targets = f.targets;
  if (!targets?.length && mode !== "new_body") {
    if ("face" in f.plane) targets = [...new Set(facesIn(bodies, f.plane.face).map((r) => r.body))].filter((id) => !catchIn.includes(id));
    else {
      const tb = bodyBounds(ctx.oc, hooks);
      targets = partsReaching(ctx.oc, bodies, tb, (id) => catchIn.includes(id)).map((b) => b.bodyId);
    }
    if (!targets.length) {
      if (mode === "join") ctx.warnings.push("nothing to join; created a new body");
      return applyTool(after, f.id, hooks, "new_body");
    }
  }
  return applyTool(after, f.id, hooks, mode, targets);
}

/**
 * Text: the font's outlines as faces on the plane, extruded along its normal (raised) or against it
 * (engraved, from a hair above the surface so the cut opens it). Faces: tx1.top (the letters' tops
 * or the engraving's floor) and tx1.side.
 */
/**
 * A box, cylinder or sphere at its centre, tagged by side: box faces by their outward normal
 * (top +Z, bottom, front −Y, back, left −X, right), a cylinder's round side and its two caps (start
 * at the low end of the axis), a sphere's one face.
 */
function primitiveFeature(f: ResolvedPrimitive, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena, g } = ctx;
  const [cx, cy, cz] = f.center;
  let shape: TopoDS_Shape;
  let tag: (normal: Vec3 | null, center: Vec3) => string;
  if (f.shape === "box") {
    const [x, y, z] = f.size ?? [0, 0, 0];
    if (!(x > 0 && y > 0 && z > 0)) throw new FeatureError("a box needs a size greater than zero in X, Y and Z");
    shape = arena.track(arena.track(new oc.BRepPrimAPI_MakeBox(g.pnt([cx - x / 2, cy - y / 2, cz - z / 2]), g.pnt([cx + x / 2, cy + y / 2, cz + z / 2]))).Shape());
    const names: [number, number, string][] = [[2, 1, "top"], [2, -1, "bottom"], [1, -1, "front"], [1, 1, "back"], [0, -1, "left"], [0, 1, "right"]];
    tag = (n) => `${f.id}.${names.find(([k, sgn]) => n && Math.abs(n[k]! - sgn) < 1e-6)?.[2] ?? "side"}`;
  } else if (f.shape === "cylinder") {
    const d = f.diameter ?? 0;
    const h = f.height ?? 0;
    if (!(d > 0 && h > 0)) throw new FeatureError("a cylinder needs a diameter and a height greater than zero");
    const k = f.axis === "X" ? 0 : f.axis === "Y" ? 1 : 2;
    const dir: Vec3 = [0, 0, 0];
    dir[k] = 1;
    const base: Vec3 = [cx, cy, cz];
    base[k] -= h / 2;
    const ax = arena.track(new oc.gp_Ax2(g.pnt(base), g.dir(dir)));
    shape = arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax, d / 2, h)).Shape());
    tag = (n) => (n && Math.abs(Math.abs(n[k]!) - 1) < 1e-6 ? `${f.id}.${n[k]! < 0 ? "start_cap" : "end_cap"}` : `${f.id}.side`);
  } else {
    const d = f.diameter ?? 0;
    if (!(d > 0)) throw new FeatureError("a sphere needs a diameter greater than zero");
    shape = arena.track(arena.track(new oc.BRepPrimAPI_MakeSphere(g.pnt([cx, cy, cz]), d / 2)).Shape());
    tag = () => `${f.id}.side`;
  }
  const body = new Body(oc, arena, f.id, shape);
  body.faceTags = body.faceInfo.map((info) => [tag(info.normal, f.center)]);
  return applyTool(ctx, f.id, body, f.mode, f.targets);
}

function textFeature(f: ResolvedText, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena, g } = ctx;
  if (!(f.size > 0)) throw new FeatureError("the text size must be greater than zero");
  if (!(f.depth > 0)) throw new FeatureError("the text depth must be greater than zero");
  if (!f.text.trim()) throw new FeatureError("the text is empty");
  const { loops, missing } = textLoops(f.text, { font: f.font, size: f.size, align: f.align });
  if (missing.length) ctx.warnings.push(`the font has no ${missing.map((c) => `"${c}"`).join(", ")}`);
  if (!loops.length) throw new FeatureError("the text has no letters to draw");
  const frame = planeFrame(f.plane, ctx);
  const inward = f.mode === "cut" || f.mode === "intersect";
  const sign = (inward ? -1 : 1) * (f.flip ? -1 : 1);
  const lift = inward ? 0.01 : 0;
  const n = frame.normal;
  const rad = (f.angle * Math.PI) / 180;
  const [c, s] = [Math.cos(rad), Math.sin(rad)];
  const world = ([x, y]: [number, number]) => toWorld(frame, [f.position[0] + c * x - s * y, f.position[1] + s * x + c * y]).map((v, k) => v - sign * n[k]! * lift) as Vec3;
  const wire = (loop: [number, number][]) => {
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = loop.map((p) => g.vertex(world(p)));
    vs.forEach((v, i) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    return arena.track(mw.Wire());
  };
  const depth = f.depth + lift;
  const vec = g.vec([n[0] * sign * depth, n[1] * sign * depth, n[2] * sign * depth]);
  const pln = arena.track(new oc.gp_Pln(arena.track(new oc.gp_Ax3(g.pnt(world([0, 0])), g.dir(n), g.dir(frame.u)))));
  const solids: Body[] = [];
  for (const shape of nest(loops)) {
    const mf = arena.track(new oc.BRepBuilderAPI_MakeFace(pln, wire(shape.outer), true));
    for (const h of shape.holes) mf.Add(wire(h));
    if (!mf.IsDone()) continue;
    const prism = arena.track(new oc.BRepPrimAPI_MakePrism(arena.track(mf.Face()), vec, false, true));
    if (!prism.IsDone()) continue;
    const body = new Body(oc, arena, f.id, arena.track(prism.Shape()));
    const top = body.faceIndex(arena.track(prism.LastShape()));
    const bottom = body.faceIndex(arena.track(prism.FirstShape()));
    body.faceTags = body.faces.map((_, i) => [i === top ? `${f.id}.top` : i === bottom ? `${f.id}.base` : `${f.id}.side`]);
    solids.push(body);
  }
  if (!solids.length) throw new FeatureError("the text could not be built");
  // Letters do not overlap: one compound holds them all.
  const builder = arena.track(new oc.TopoDS_Builder());
  const compound = arena.track(new oc.TopoDS_Compound());
  builder.MakeCompound(compound);
  for (const b of solids) builder.Add(compound, b.shape);
  const tool = new Body(oc, arena, f.id, compound);
  tool.faceTags = tool.faces.map((face) => {
    for (const b of solids) {
      const i = b.faceIndex(face);
      if (i >= 0) return [...b.faceTags[i]!];
    }
    return [`${f.id}.side`];
  });
  return applyTool(ctx, f.id, tool, f.mode, f.targets);
}

/** Draft: the faces tilted about their line on the neutral plane, leaning in along the pull direction. */
function draft(f: ResolvedDraft, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena, g } = ctx;
  if (!(Math.abs(f.angle) > 0) || Math.abs(f.angle) >= 45) throw new FeatureError("the draft angle must be between 0 and 45 degrees");
  if (!f.faces.length) throw new FeatureError("select the faces to draft");
  const refs = f.faces.flatMap((s) => facesIn(ctx.prev.bodies, s));
  const bodyIds = new Set(refs.map((r) => r.body));
  if (bodyIds.size !== 1) throw new FeatureError("draft faces must belong to one part");
  const input = ctx.prev.bodies.get([...bodyIds][0]!)!;
  const frame = planeFrame(f.neutral, ctx);
  const pull: Vec3 = f.flip ? [-frame.normal[0], -frame.normal[1], -frame.normal[2]] : frame.normal;
  const pln = arena.track(new oc.gp_Pln(arena.track(new oc.gp_Ax3(g.pnt(frame.origin), g.dir(frame.normal), g.dir(frame.u)))));
  const mk = arena.track(new oc.BRepOffsetAPI_DraftAngle(input.shape));
  for (const r of refs) {
    for (const fi of r.faces) {
      const face = oc.TopoDS.Face(input.faces[fi]!);
      mk.Add(face, g.dir(pull), (f.angle * Math.PI) / 180, pln, true);
      if (!mk.AddDone()) throw new FeatureError(`face ${input.faceTags[fi]?.[0] ?? fi} cannot be drafted`, "draft side faces that cross the neutral plane or stand on it; flat faces parallel to it cannot be drafted");
    }
  }
  try {
    mk.Build(arena.track(new oc.Message_ProgressRange()));
  } catch (e) {
    throw new FeatureError(`draft failed: ${occtErrorMessage(oc, e)}`, "try a smaller angle or fewer faces");
  }
  if (!mk.IsDone()) throw new FeatureError("draft failed", "try a smaller angle, or draft faces that meet the neutral plane");
  const body = new Body(oc, arena, input.bodyId, arena.track(mk.Shape()));
  const descendants = input.faces.map((face) => {
    const same = body.faceIndex(face);
    if (same >= 0) return [same];
    return listToArray(arena, mk.Modified(face)).map((s) => body.faceIndex(s)).filter((i) => i >= 0);
  });
  body.faceTags = propagateTags(input.faceTags, body.faces.length, { descendants, generated: [] }, `${f.id}.face`).tags;
  return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(body.bodyId, body) };
}

/**
 * Faces moved along their normals. Each face is thickened into a slab of the distance (out of the
 * material, or into it for a negative distance), which is joined to the part or cut from it. The
 * slab's far side takes the face's tags, so later steps on that face still find it; its sides are
 * `<step>.side`. Neighbours at right angles extend flush; slanted ones get a step.
 */
const OVERLAP = 1e-3;

function offsetFace(f: ResolvedOffsetFace, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena, g } = ctx;
  if (!f.faces.length) throw new FeatureError("select the faces to move");
  const refs = f.faces.flatMap((s) => facesIn(ctx.prev.bodies, s));
  const bodyIds = new Set(refs.map((r) => r.body));
  if (bodyIds.size !== 1) throw new FeatureError("the faces must belong to one part");
  const input = ctx.prev.bodies.get([...bodyIds][0]!)!;
  const faces = [...new Set(refs.flatMap((r) => r.faces))];
  // Up to a plane: each flat face moves by its own distance onto it.
  const target = f.upTo ? planeFrame(f.upTo, ctx) : null;
  const distanceOf = (fi: number): number => {
    if (!target) return f.distance;
    const info = input.faceInfo[fi]!;
    if (!info.planar || !info.normal) throw new FeatureError(`face ${input.faceTags[fi]?.[0] ?? fi} is not flat`, "only flat faces can be moved up to a plane");
    const n = info.normal;
    const dot = n[0] * target.normal[0] + n[1] * target.normal[1] + n[2] * target.normal[2];
    if (Math.abs(Math.abs(dot) - 1) > 1e-6) throw new FeatureError(`face ${input.faceTags[fi]?.[0] ?? fi} is not parallel to the plane`, "pick a plane or flat face parallel to the faces");
    const p = input.facePoints[fi]!;
    const gap = (target.origin[0] - p[0]) * n[0] + (target.origin[1] - p[1]) * n[1] + (target.origin[2] - p[2]) * n[2];
    return gap - f.distance;
  };
  const moves = faces.map((fi) => ({ fi, d: distanceOf(fi) })).filter((m) => Math.abs(m.d) > 1e-7);
  if (!moves.length) throw new FeatureError(target ? "the faces already lie on the plane" : "the distance must not be zero");
  let body = input;
  // Growing faces first, then shrinking ones: each slab is made from the face as it was.
  for (const sign of [1, -1]) {
    const these = moves.filter((m) => Math.sign(m.d) === sign);
    if (!these.length) continue;
    const slabs = these.map(({ fi, d }) => {
      const face = input.faces[fi]!;
      const info = input.faceInfo[fi]!;
      const name = input.faceTags[fi]?.[0] ?? fi;
      let shape: TopoDS_Shape;
      if (info.planar && info.normal) {
        // A flat face: a prism along its outward normal (a positive distance grows the part). Its
        // sides are real planes and cylinders, so they merge with the neighbours they continue.
        const n = info.normal;
        shape = arena.track(arena.track(new oc.BRepPrimAPI_MakePrism(face, g.vec([n[0] * d, n[1] * d, n[2] * d]), false, true)).Shape());
      } else {
        // A curved face is thickened along its normals instead. A growing slab starts a hair inside
        // the part: curved faces exactly on top of each other (a hole wall) fail to fuse.
        const mk = arena.track(new oc.BRepOffsetAPI_MakeThickSolid());
        try {
          let from: TopoDS_Shape = face;
          if (d > 0) {
            const off = arena.track(new oc.BRepOffsetAPI_MakeOffsetShape());
            off.PerformBySimple(face, -OVERLAP);
            from = arena.track(off.Shape());
          }
          mk.MakeThickSolidBySimple(from, d > 0 ? d + OVERLAP : d);
        } catch (e) {
          throw new FeatureError(`face ${name} cannot be moved: ${occtErrorMessage(oc, e)}`, "try a smaller distance");
        }
        if (!mk.IsDone()) throw new FeatureError(`face ${name} cannot be moved`, "try a smaller distance");
        // The slab can come out inside out (negative volume): rebuild the solid from its shell, which orients it outwards.
        const ex = arena.track(new oc.TopExp_Explorer(arena.track(mk.Shape()), oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE));
        if (!ex.More()) throw new FeatureError(`face ${name} cannot be moved`, "try a smaller distance");
        shape = arena.track(arena.track(new oc.ShapeFix_Solid()).SolidFromShell(oc.TopoDS.Shell(ex.Current())));
      }
      const slab = new Body(oc, arena, f.id, shape);
      // The far side lies |d| from the face; the near side and the sides touch it.
      slab.faceTags = slab.faces.map((sf) => {
        const dist = arena.track(new oc.BRepExtrema_DistShapeShape(sf, face));
        const far = dist.IsDone() && dist.Value() > Math.abs(d) * 0.5;
        return far ? [...(input.faceTags[fi] ?? []), `${f.id}.face`] : [`${f.id}.side`];
      });
      return slab;
    });
    const tool = slabs.length === 1 ? slabs[0]! : booleanBodies(oc, arena, slabs[0]!, slabs.slice(1), "fuse", f.id);
    body = booleanBodies(oc, arena, body, tool, sign > 0 ? "fuse" : "cut");
  }
  return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(body.bodyId, body) };
}

/**
 * Ribs: per sketch line, a slab of the rib's thickness reaching far beyond the line (along it, and
 * to one side of it in the sketch plane), minus the parts. The piece that holds the line is the rib:
 * it runs from the line to the walls it meets. Without `flip` the side is the one closed by walls
 * (the smaller piece when both are).
 */
function rib(f: ResolvedRib, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena, g } = ctx;
  if (!(f.thickness > 0)) throw new FeatureError("the rib's thickness must be greater than zero");
  const sk = ctx.prev.sketches.get(f.sketch);
  if (!sk) throw new FeatureError(`sketch "${f.sketch}" is missing or failed`);
  const missing = f.curves?.filter((id) => !sk.solved.curves.some((c) => c.id === id)) ?? [];
  if (missing.length) throw new FeatureError(`rib line(s) no longer exist: ${missing.join(", ")}`);
  const lines = sk.solved.curves.filter((c): c is Extract<SolvedCurve, { kind: "line" }> => c.kind === "line" && (f.curves ? f.curves.includes(c.id) : !c.construction && !c.external));
  if (!lines.length) throw new FeatureError(`sketch "${sk.id}" has no lines for a rib`, "draw an open line from wall to wall");
  const parts = [...ctx.prev.bodies.values()];
  if (!parts.length) throw new FeatureError("a rib needs a part to stand on");
  const big = modelSize(ctx);
  const n = sk.frame.normal;
  const half = f.thickness / 2;
  const add = (p: Vec3, d: Vec3, s: number): Vec3 => [p[0] + d[0] * s, p[1] + d[1] * s, p[2] + d[2] * s];
  const solidsOf = (s: TopoDS_Shape) => {
    const out: TopoDS_Shape[] = [];
    for (const e = arena.track(new oc.TopExp_Explorer(s, "TopAbs_SOLID")); e.More(); e.Next()) out.push(arena.track(e.Current()));
    return out;
  };
  const volume = (s: TopoDS_Shape) => {
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(s, props, false, false, false);
    return Math.abs(props.Mass());
  };
  // The line lies on the boundary of the piece that holds it, and away from every other piece.
  const touches = (s: TopoDS_Shape, p: Vec3) => {
    const d = arena.track(new oc.BRepExtrema_DistShapeShape(g.vertex(p), s));
    return d.IsDone() && d.Value() < 1e-6 * big;
  };
  const quad = (pts: Vec3[]) => {
    const mw = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const vs = pts.map((p) => g.vertex(p));
    vs.forEach((v, i) => mw.Add(arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v, vs[(i + 1) % vs.length]!)).Edge())));
    return arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(mw.Wire()), true)).Face());
  };
  // A piece closed in by walls stays within the parts' bounds; an open one runs out to the slab's end.
  const pb = parts.map((p) => bodyBounds(oc, p));
  const lo = [0, 1, 2].map((k) => Math.min(...pb.map((b) => b.min[k]!)) - 1e-3);
  const hi = [0, 1, 2].map((k) => Math.max(...pb.map((b) => b.max[k]!)) + 1e-3);
  const within = (s: TopoDS_Shape) => {
    const b = bounds(oc, arena, s);
    return [0, 1, 2].every((k) => b.min[k]! >= lo[k]! - f.thickness && b.max[k]! <= hi[k]! + f.thickness);
  };
  const pieces: Body[] = [];
  for (const line of lines) {
    const a = toWorld(sk.frame, line.a), b = toWorld(sk.frame, line.b);
    const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    if (len < 1e-6) continue;
    const t: Vec3 = [(b[0] - a[0]) / len, (b[1] - a[1]) / len, (b[2] - a[2]) / len];
    const side: Vec3 = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const mid = add(a, t, len / 2);
    // The piece of one side's slab that holds the line, and whether walls close it.
    const fill = (dir: 1 | -1) => {
      const a0 = add(add(a, t, -big), n, -half), b0 = add(add(b, t, big), n, -half);
      const face = quad([a0, b0, add(b0, side, dir * big), add(a0, side, dir * big)]);
      const slab = arena.track(arena.track(new oc.BRepPrimAPI_MakePrism(face, g.vec([n[0] * f.thickness, n[1] * f.thickness, n[2] * f.thickness]), false, true)).Shape());
      let rest: TopoDS_Shape = slab;
      for (const part of parts) {
        const cut = arena.track(new oc.BRepAlgoAPI_Cut(rest, part.shape));
        if (cut.IsDone() && !cut.HasErrors()) rest = arena.track(cut.Shape());
      }
      const piece = solidsOf(rest).find((s) => touches(s, mid));
      if (!piece) return null;
      const v = volume(piece);
      return { piece, v, closed: within(piece) };
    };
    const one = fill(1), other = fill(-1);
    // The side closed by walls (the smaller piece when both are); `flip` takes the other side.
    const otherFirst = !one?.closed || (!!other?.closed && other.v < one.v);
    const pick = otherFirst !== !!f.flip ? other : one;
    if (!pick?.closed) throw new FeatureError(`rib line ${line.id} does not meet a wall on that side`, "draw the line so that walls of the part close it in, or flip the rib");
    const body = new Body(oc, arena, f.id, pick.piece);
    body.faceTags = body.faces.map(() => [`${f.id}.face`]);
    pieces.push(body);
  }
  if (!pieces.length) throw new FeatureError("the rib lines have no length");
  const tool = pieces.length === 1 ? pieces[0]! : booleanBodies(oc, arena, pieces[0]!, pieces.slice(1), "fuse", f.id);
  return applyTool(ctx, f.id, tool, "join");
}

/**
 * Parts cut in two at a plane: each kept piece is the part in common with a large box on that side.
 * The new faces at the plane are tagged `<step>.cut`.
 */
function split(f: ResolvedSplit, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena, g } = ctx;
  const frame = planeFrame(f.plane, ctx);
  const size = modelSize(ctx) * 2;
  const n = frame.normal;
  const box = (side: 1 | -1): Body => {
    const corner: Vec3 = [0, 1, 2].map((k) => frame.origin[k]! - frame.u[k]! * size - frame.v[k]! * size + (side < 0 ? -n[k]! * size : 0)) as Vec3;
    const ax = arena.track(new oc.gp_Ax2(g.pnt(corner), g.dir(n), g.dir(frame.u)));
    const b = new Body(oc, arena, f.id, arena.track(arena.track(new oc.BRepPrimAPI_MakeBox(ax, 2 * size, 2 * size, size)).Shape()));
    b.faceTags = b.faces.map(() => [`${f.id}.cut`]);
    return b;
  };
  const front = box(1), back = box(-1);
  const bodies = copyMap(ctx.prev.bodies);
  const chosen = f.bodies.length ? f.bodies : [...bodies.keys()];
  const keep = f.keep ?? "both";
  let crossed = 0;
  for (const id of chosen) {
    const body = bodies.get(id);
    if (!body) throw new FeatureError(`part "${id}" not found`);
    const piece = (side: Body, resultId: string) => {
      try {
        return booleanBodies(oc, arena, body, side, "common", resultId);
      } catch (e) {
        if (e instanceof FeatureError) return null;
        throw e;
      }
    };
    const otherId = chosen.length === 1 ? f.id : `${f.id}_${id}`;
    const a = piece(front, id);
    const b = piece(back, keep === "back" ? id : otherId);
    // A part wholly on one side stays as it is.
    if (!a || !b) {
      if (f.bodies.length) ctx.warnings.push(`the plane does not cross part "${id}"`);
      continue;
    }
    crossed++;
    bodies.delete(id);
    if (f.connectors && keep === "both") {
      const c = f.connectors;
      const joined = joinPieces(oc, arena, frame, { ...f, connectors: c }, body, a, b, (k) => `${otherId}_dowel${k}`, ctx.warnings);
      bodies.set(id, joined.front);
      bodies.set(joined.back.bodyId, joined.back);
      for (const d of joined.dowels) bodies.set(d.bodyId, d);
      continue;
    }
    if (keep !== "back") bodies.set(id, a);
    if (keep !== "front") bodies.set(b.bodyId, b);
  }
  if (!crossed) throw new FeatureError("the plane does not cross any part", "move the plane into the part, or pick another face");
  return { ...ctx.prev, bodies };
}

/** Copy of a body under a transform; tags get `suffix` appended (for pattern instances). */
function transformBody(ctx: Ctx, body: Body, trsf: gp_Trsf, id: string, suffix = ""): Body {
  // The same part moved the same way as when this step last ran: that result again, the very same
  // object, so a move of many parts does not hand on new parts (and new meshes) for all of them
  // when one of them changed.
  let how = `${id}|${suffix}`;
  for (let r = 1; r <= 3; r++) for (let c = 1; c <= 4; c++) how += `|${trsf.Value(r, c)}`;
  const before = ctx.earlier?.state.bodies.get(id);
  const made = before && movedFrom.get(before);
  if (before && made && made.source === body && made.how === how) {
    ctx.earlier!.kept = true;
    return before;
  }
  const out = moved(ctx, body, trsf, id, suffix);
  movedFrom.set(out, { source: body, how });
  return out;
}

function moved(ctx: Ctx, body: Body, trsf: gp_Trsf, id: string, suffix: string): Body {
  const t = ctx.g.transform(body.shape, trsf);
  const out = new Body(ctx.oc, ctx.arena, id, t.shape);
  const tags: string[][] = out.faces.map(() => []);
  body.faces.forEach((face, i) => {
    const j = out.faceIndex(t.map(face));
    if (j >= 0) tags[j]!.push(...(body.faceTags[i] ?? []).map((tag) => tag + suffix));
  });
  out.faceTags = tags.map((tg, i) => (tg.length ? tg : [`${id}.face[${i}]`]));
  // A moved or copied mesh keeps its triangles, moved the same way (as long as faces keep their order).
  if (body.sourceMesh && body.faces.every((f, i) => out.faceIndex(t.map(f)) === i)) {
    const src = body.sourceMesh;
    const m = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) {
      const p = ctx.arena.track(new ctx.oc.gp_Pnt(src[i]!, src[i + 1]!, src[i + 2]!));
      p.Transform(trsf);
      m[i] = p.X();
      m[i + 1] = p.Y();
      m[i + 2] = p.Z();
    }
    out.sourceMesh = m;
    out.sourceFeature = body.sourceFeature;
  }
  return out;
}

/** Combines a tool solid with the model according to the boolean mode. */
function applyTool(ctx: Ctx, featureId: string, tool: Body, mode: BooleanMode, targets?: string[], newBodyId = featureId): Omit<ModelState, "arena"> {
  const bodies = copyMap(ctx.prev.bodies);
  const tools = copyMap(ctx.prev.tools).set(featureId, { mode, body: tool } satisfies ToolRecord);
  if (mode === "new_body") {
    let body = tool;
    if (newBodyId !== tool.bodyId) {
      body = new Body(ctx.oc, ctx.arena, newBodyId, tool.shape);
      body.faceTags = body.faces.map((face) => [...(tool.faceTags[tool.faceIndex(face)] ?? [])]);
    }
    bodies.set(newBodyId, body);
    return { ...ctx.prev, bodies, tools };
  }
  const tb = bodyBounds(ctx.oc, tool);
  const candidates = targets?.length
    ? targets.map((t) => {
        const b = bodies.get(t);
        if (!b) throw new FeatureError(`target body "${t}" not found`);
        return b;
      })
    : partsReaching(ctx.oc, bodies, tb);
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
  const ref = edgesIn(ctx.prev.bodies, asArray(f.edges));
  const input = ctx.prev.bodies.get(ref.body)!;

  // Variable rounding: from `radius` at one end of each edge to `radius2` at the other.
  const r2 = f.op === "fillet" ? f.radius2 : undefined;
  if (r2 !== undefined && !(r2 > 0)) throw new FeatureError("the end radius must be greater than zero");
  const attempt = (r: number) => {
    const mk = f.op === "fillet" ? arena.track(new oc.BRepFilletAPI_MakeFillet(input.shape, "ChFi3d_Rational")) : arena.track(new oc.BRepFilletAPI_MakeChamfer(input.shape));
    for (const ei of ref.edges) {
      if (r2 !== undefined && mk instanceof oc.BRepFilletAPI_MakeFillet) mk.Add(r, (r2 * r) / size, input.edges[ei]!);
      else mk.Add(r, input.edges[ei]!);
    }
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
  return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(body.bodyId, body) };
}

function shell(f: ResolvedShell, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  if (!(f.thickness > 0)) throw new FeatureError("shell thickness must be greater than zero");
  if (!f.faces.length) throw new FeatureError("select at least one face to remove");
  const refs = f.faces.flatMap((s) => facesIn(ctx.prev.bodies, s));
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
  return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(body.bodyId, body) };
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
      const copies = transforms.map((t, k) => transformBody(ctx, rec.body, t, `${featureId}_${k + 1}`, `@${featureId}.${k + 1}`));
      const batched = applyCopies({ ...ctx, prev: { ...state, arena: ctx.arena } }, copies, rec.mode);
      if (batched) {
        state = batched;
        continue;
      }
      copies.forEach((copy, k) => {
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
        step((c) => ({ ...c.prev, bodies: copyMap(c.prev.bodies).set(newId, copy) }));
      });
    }
  }
  return state;
}

/**
 * All pattern copies cut from (or joined to) the model in one boolean per target body, instead of one
 * boolean, unify and re-tag per copy. Returns null when the copies don't map onto the bodies that
 * simply (a copy touching nothing, a join bridging bodies, intersect), and the caller goes copy by copy.
 */
function applyCopies(ctx: Ctx, copies: Body[], mode: BooleanMode): Omit<ModelState, "arena"> | null {
  if (mode !== "cut" && mode !== "join") return null;
  const groups = new Map<Body, Body[]>();
  for (const copy of copies) {
    const hit = partsReaching(ctx.oc, ctx.prev.bodies, bodyBounds(ctx.oc, copy));
    if (!hit.length || (mode === "join" && hit.length > 1)) return null;
    for (const b of hit) groups.set(b, [...(groups.get(b) ?? []), copy]);
  }
  if (mode === "join" && groups.size > 1) return null;
  const next = copyMap(ctx.prev.bodies);
  try {
    for (const [target, tools] of groups) next.set(target.bodyId, booleanBodies(ctx.oc, ctx.arena, target, tools, mode === "cut" ? "cut" : "fuse"));
  } catch (e) {
    if (e instanceof FeatureError) return null;
    throw e;
  }
  return { ...ctx.prev, bodies: next };
}

function booleanFeature(f: BooleanFeature, ctx: Ctx): Omit<ModelState, "arena"> {
  const bodies = copyMap(ctx.prev.bodies);
  const get = (id: string) => {
    const b = bodies.get(id);
    if (!b) throw new FeatureError(`body "${id}" not found`);
    return b;
  };
  let target = get(f.target);
  const op = f.operation === "union" ? "fuse" : f.operation === "subtract" ? "cut" : "common";
  // Union and subtract with several tools in one OCCT call: much faster than one boolean per tool
  // against an ever more complex result (intersect means something else with several tools).
  let done = false;
  if (op !== "common" && f.tools.length > 1) {
    try {
      target = booleanBodies(ctx.oc, ctx.arena, target, f.tools.map(get), op, f.target);
      done = true;
    } catch (e) {
      if (!(e instanceof FeatureError)) throw e;
    }
  }
  if (!done) for (const t of f.tools) target = booleanBodies(ctx.oc, ctx.arena, target, get(t), op, f.target);
  if (!f.keepTools) for (const t of f.tools) bodies.delete(t);
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
  return moveBodies(ctx, f, copyMap(ctx.prev.bodies), combined);
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
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  } catch {
    throw new FeatureError(`import "${f.fileName}": data must be the file's contents encoded as base64`, "through MCP, pass the file's path in `path` instead of `data`");
  }
  const { oc, arena } = ctx;
  if (f.format === "stl") {
    const body = new Body(oc, arena, f.id, stlSolid(ctx, f, bytes));
    body.faceTags = body.faces.map((_, i) => [`${f.id}.face[${i}]`]);
    // One face per triangle, in file order: show and export the file's own triangles.
    const corners = parseStl(bytes).positions;
    if (corners.length === body.faces.length * 9) {
      body.sourceMesh = corners;
      body.sourceFeature = f.id;
    }
    return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(f.id, body) };
  }
  const path = `/import-${f.id}.step`;
  oc.FS.writeFile(path, bytes);
  try {
    const reader = arena.track(new oc.STEPControl_Reader());
    if (String(reader.ReadFile(path)) !== "IFSelect_RetDone") throw new FeatureError(`could not read STEP file "${f.fileName}"`);
    reader.TransferRoots();
    const shape = arena.track(reader.OneShape());
    const solids: TopoDS_Shape[] = [];
    if (f.split) for (const e = arena.track(new oc.TopExp_Explorer(shape, "TopAbs_SOLID")); e.More(); e.Next()) solids.push(arena.track(e.Current()));
    // One part, or (split) one per solid: an assembly from another CAD tool keeps its parts apart.
    const pieces = solids.length > 1 ? solids : [shape];
    const bodies = copyMap(ctx.prev.bodies);
    pieces.forEach((s, k) => {
      const id = k === 0 ? f.id : `${f.id}_${k + 1}`;
      const body = new Body(oc, arena, id, s);
      if (!body.faces.length) throw new FeatureError(`STEP file "${f.fileName}" contains no faces`);
      body.faceTags = body.faces.map((_, i) => [`${id}.face[${i}]`]);
      bodies.set(id, unifyIfNeeded(ctx, body));
    });
    return { ...ctx.prev, bodies };
  } finally {
    oc.FS.unlink(path);
  }
}

/**
 * A closed STL mesh as a solid: OCCT reads one face per triangle with shared edges; those form a
 * shell and then a solid (sewn first if the mesh has tiny gaps), which booleans can work with. An
 * open mesh is reported, not dropped silently.
 */
function stlSolid(ctx: Ctx, f: ImportFeature, bytes: Uint8Array): TopoDS_Shape {
  return meshSolid(ctx, `import-${f.id}`, bytes, `STL file "${f.fileName}"`);
}

/**
 * Solid from a binary STL in memory, one face per triangle (see `stlSolid`). `trusted`: the
 * triangles are known to be closed, manifold and wound outwards (made here, e.g. by a bend), so
 * the slow checks (validity, orientation, volume) are skipped.
 */
function meshSolid({ oc, arena }: Ctx, name: string, bytes: Uint8Array, what: string, trusted = false): TopoDS_Shape {
  const path = `/${name}.stl`;
  oc.FS.writeFile(path, bytes);
  let faces: TopoDS_Shape;
  try {
    faces = arena.track(new oc.TopoDS_Shape());
    if (!arena.track(new oc.StlAPI_Reader()).Read(faces, path)) throw new FeatureError(`could not read ${what}`);
  } finally {
    oc.FS.unlink(path);
  }
  const triangles = (s: TopoDS_Shape) => {
    let n = 0;
    for (const e = arena.track(new oc.TopExp_Explorer(s, "TopAbs_FACE")); e.More(); e.Next()) n++;
    return n;
  };
  const count = triangles(faces);
  if (!count) throw new FeatureError(`${what} contains no triangles`);
  const toSolid = (shape: TopoDS_Shape): TopoDS_Shape | null => {
    const builder = arena.track(new oc.TopoDS_Builder());
    const shell = arena.track(new oc.TopoDS_Shell());
    builder.MakeShell(shell);
    for (const e = arena.track(new oc.TopExp_Explorer(shape, "TopAbs_FACE")); e.More(); e.Next()) builder.Add(shell, arena.track(e.Current()));
    const solid = arena.track(oc.TopoDS.Solid(arena.track(arena.track(new oc.BRepBuilderAPI_MakeSolid(shell)).Solid())));
    // Trusted triangles all came through (none dropped as degenerate): the solid is closed.
    if (trusted && count * 50 + 84 === bytes.length) return solid;
    oc.BRepLib.OrientClosedSolid(solid);
    if (!arena.track(new oc.BRepCheck_Analyzer(solid, true, false)).IsValid()) return null;
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(solid, props, false, false, false);
    return props.Mass() > 0 ? solid : null;
  };
  let solid = toSolid(faces);
  if (!solid) {
    // Small gaps between triangles: sew them shut, then try again.
    const sew = arena.track(new oc.BRepBuilderAPI_Sewing(1e-3, true, true, true, false));
    sew.Load(faces);
    sew.Perform(arena.track(new oc.Message_ProgressRange()));
    solid = toSolid(arena.track(sew.SewedShape()));
  }
  if (!solid) throw new FeatureError(`${what} is not a closed solid (${count} triangles)`, "repair the mesh so it has no holes, e.g. in your slicer or mesh tool, and import it again");
  // Faces stay one per triangle: imported meshes are edited as whole parts, and keeping the file's
  // triangles lets display and export skip OCCT's meshing.
  return solid;
}

/** Holes cut into the parts they meet; tapped ones get a modelled thread in their bore. */
function holeFeature(f: ResolvedHole, ctx: Ctx): Omit<ModelState, "arena"> {
  if (!f.points.length) throw new FeatureError("place at least one hole");
  let shape;
  try {
    shape = holeShape(f.kind, { size: f.size, diameter: f.diameter, fit: f.fit, depth: f.depth, allowance: f.allowance, length: f.length });
  } catch (e) {
    if (e instanceof HoleError) throw new FeatureError(e.message);
    throw e;
  }
  const frame = planeFrame(f.plane, ctx);
  const through = shape.depth === undefined;
  const depth = shape.depth ?? modelSize(ctx);
  const tool = holeTools(ctx.oc, ctx.arena, f.id, frame, f.points, shape, depth, !!f.flip);
  let next = applyTool(ctx, f.id, tool, "cut");
  if (shape.thread) {
    // One thread per bore, found by its wall near the hole's centre line.
    const a: Vec3 = f.flip ? frame.normal : [-frame.normal[0], -frame.normal[1], -frame.normal[2]];
    const bodies = copyMap(next.bodies);
    for (const [u, v] of f.points) {
      const c = toWorld(frame, [u, v]);
      const t = through ? 0.5 : Math.min(depth / 2, 0.5);
      const near: Vec3 = [c[0] + a[0] * t + frame.u[0] * shape.diameter / 2, c[1] + a[1] * t + frame.u[1] * shape.diameter / 2, c[2] + a[2] * t + frame.u[2] * shape.diameter / 2];
      const { body } = threadBody(ctx.oc, ctx.arena, bodies, { id: f.id, op: "thread", face: { face: `${f.id}.wall`, near }, size: shape.thread.size, pitch: shape.thread.pitch } as Parameters<typeof threadBody>[3]);
      bodies.set(body.bodyId, body);
    }
    next = { ...next, bodies };
  }
  if (shape.insert) {
    insertWalls(ctx, next, f, frame, shape.diameter / 2, shape.insert);
    if (f.withInserts) {
      // The inserts as parts of their own, flush in their holes: "ho1_insert", "ho1_insert_2", …
      const part = standardShape("insert", { size: shape.insert.size, length: shape.insert.length });
      const bodies = copyMap(next.bodies);
      f.points.forEach((p, k) => {
        const id = `${f.id}_insert${k === 0 ? "" : `_${k + 1}`}`;
        bodies.set(id, standardPartBody(ctx.oc, ctx.arena, id, { ...frame, origin: toWorld(frame, p) }, [0, 0], part, !!f.flip));
      });
      next = { ...next, bodies };
    }
  }
  return next;
}

/**
 * Warns where the wall around an insert's hole is thinner than the insert needs (it would bulge
 * or crack when melted in): a cylinder as wide as hole plus wall, as deep as the insert, must lie
 * in the material all round the hole.
 */
function insertWalls(ctx: Ctx, state: Omit<ModelState, "arena">, f: ResolvedHole, frame: PlaneFrame, r: number, ins: InsertDims): void {
  const { oc, arena } = ctx;
  const a: Vec3 = f.flip ? frame.normal : [-frame.normal[0], -frame.normal[1], -frame.normal[2]];
  const volume = (s: TopoDS_Shape) => {
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(s, props, false, false, false);
    return Math.abs(props.Mass());
  };
  /** Material within radius R of the axis, as deep as the insert. */
  const material = (c: Vec3, R: number) => {
    const ax = arena.track(new oc.gp_Ax2(arena.track(new oc.gp_Pnt(...c)), arena.track(new oc.gp_Dir(...a))));
    const probe = arena.track(arena.track(new oc.BRepPrimAPI_MakeCylinder(ax, R, ins.length)).Shape());
    const pb = bounds(oc, arena, probe);
    let inside = 0;
    const own = `${f.id}_insert`;
    for (const b of partsReaching(oc, state.bodies, pb, (id) => id.startsWith(own))) {
      const common = arena.track(new oc.BRepAlgoAPI_Common(b.shape, probe));
      if (common.IsDone() && !common.HasErrors()) inside += volume(arena.track(common.Shape()));
    }
    return inside;
  };
  const annulus = (R: number) => Math.PI * (R * R - r * r);
  const shallow: { k: number; depth: number }[] = [];
  const thin: number[] = [];
  f.points.forEach((p, k) => {
    const c = toWorld(frame, p);
    // Right beside the hole: the material must reach as deep as the insert.
    const near = r + 0.3;
    const depth = material(c, near) / annulus(near);
    // A little slack for the faceted volume integral.
    if (depth < ins.length * 0.98) shallow.push({ k: k + 1, depth });
    else if (material(c, r + ins.wall) < annulus(r + ins.wall) * ins.length * 0.98) thin.push(k + 1);
  });
  const which = (ks: number[]) => (f.points.length === 1 ? "the insert" : ks.length === f.points.length ? "every insert" : `insert${ks.length === 1 ? "" : "s"} ${ks.join(", ")}`);
  if (shallow.length) {
    const least = Math.min(...shallow.map((x) => x.depth));
    const shorter = insertLengths(ins.size).filter((l) => l < ins.length && l <= least + 1e-6);
    ctx.warnings.push(
      `the part is too thin for ${which(shallow.map((x) => x.k))}: about ${+least.toFixed(1)} mm of material, the ${ins.size}×${ins.length} insert is ${ins.length} mm long; ${shorter.length ? `use a shorter one (${shorter.join(" or ")} mm) or ` : ""}make the part thicker`,
    );
  }
  if (thin.length) ctx.warnings.push(`the wall around ${which(thin)} is thinner than the ${ins.wall} mm an ${ins.size} insert needs: move it away from the edge`);
}

/**
 * A mesh part as a solid with real faces (see `meshconvert.ts`). The part keeps its id; its faces
 * are tagged by the kind of surface they were recognised as, e.g. `mc1.cylinder[2]`.
 */
function meshConvertFeature(f: ResolvedMeshConvert, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  const input = ctx.prev.bodies.get(f.body);
  if (!input) throw new FeatureError(`body "${f.body}" not found`);
  const corners = input.sourceMesh ?? trianglesOf(ctx, input);
  if (!corners) throw new FeatureError(`"${f.body}" is not a mesh part`, "convert the imported mesh before cutting or combining it");
  if (f.tolerance !== undefined && !(f.tolerance > 0)) throw new FeatureError("tolerance must be greater than zero");
  const r = convertMesh(oc, arena, corners, { tolerance: f.tolerance, sharpAngle: f.angle });
  const body = new Body(oc, arena, input.bodyId, r.shape);
  const counters: Record<string, number> = {};
  const names = new Map<number, string>();
  body.faceTags = body.faces.map((face, i) => {
    const ri = r.regionOf(face);
    if (ri < 0) return [`${f.id}.face[${i}]`];
    let name = names.get(ri);
    if (!name) {
      const kind = r.fit.regions[ri]!.primitive?.kind ?? "facet";
      name = `${f.id}.${kind}[${(counters[kind] = (counters[kind] ?? 0) + 1) - 1}]`;
      names.set(ri, name);
    }
    return [name];
  });
  const parts = (["plane", "cylinder", "cone", "sphere"] as const).filter((k) => r.counts[k]).map((k) => `${r.counts[k]} ${k}${r.counts[k] === 1 ? "" : "s"}`);
  if (r.counts.facet) ctx.warnings.push(`${r.counts.facet} triangles match no surface and stay flat facets (found ${parts.join(", ") || "no surfaces"})`);
  return { ...ctx.prev, bodies: copyMap(ctx.prev.bodies).set(body.bodyId, body) };
}

/**
 * Parts bent round an axis, wrapped onto a cylinder or rolled into a flat spiral (see
 * model/bend.ts). The parts are cut into triangles fine enough for the tolerance, bent together
 * as one piece and become mesh parts with the same ids.
 */
function bendFeature(f: ResolvedBend, ctx: Ctx): Omit<ModelState, "arena"> {
  const { oc, arena } = ctx;
  if (!f.bodies.length) throw new FeatureError("pick the parts to bend");
  const inputs = f.bodies.map((id) => {
    const body = ctx.prev.bodies.get(id);
    if (!body) throw new FeatureError(`part "${id}" not found`);
    return body;
  });
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const b of inputs) {
    const bb = bodyBounds(oc, b);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, bb.min[k]!);
      hi[k] = Math.max(hi[k]!, bb.max[k]!);
    }
  }
  const tolerance = f.tolerance ?? defaultBendTolerance(Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!));
  if (!(tolerance > 0)) throw new FeatureError("the tolerance must be greater than zero");
  const ax = axis(f.axis, ctx).dir;
  let bent;
  try {
    bent = bendMeshes(
      inputs.map((b) => b.sourceMesh ?? surfaceTriangles(ctx, b, tolerance)),
      { mode: f.mode, axis: ax, angle: f.angle, radius: f.radius, gap: f.gap, flip: f.flip, reverse: f.reverse, tolerance },
    );
  } catch (e) {
    if (e instanceof BendError) throw new FeatureError(e.message, e.hint);
    throw e;
  }
  const bodies = copyMap(ctx.prev.bodies);
  bent.forEach((m, k) => {
    const id = inputs[k]!.bodyId;
    const n = m.corners.length / 9;
    const indices = Uint32Array.from({ length: n * 3 }, (_, i) => i);
    const shape = meshSolid(ctx, `bend-${f.id}-${k}`, writeStl([{ positions: m.corners, indices }]), `the bent part "${id}"`, true);
    const body = new Body(oc, arena, id, shape);
    body.faceTags = body.faces.map((_, i) => [`${f.id}.face[${i}]`]);
    if (body.faces.length === n) body.sourceMesh = m.corners;
    bodies.set(id, body);
  });
  ctx.warnings.push(...bent[0]!.warnings);
  ctx.info = bendInfoRecord(bent[0]!.info);
  return { ...ctx.prev, bodies };
}

/**
 * The plan of a bin with a nest for a part (model/scanbin.ts): the part's triangles in the plane's
 * frame, and the nest as a solid in the bin's local frame.
 */
function pocketFor(f: ResolvedGridfinity, frame: PlaneFrame, ctx: Ctx): BinPocket {
  const p = f.pocket!;
  const part = ctx.prev.bodies.get(p.body);
  if (!part) throw new FeatureError(`part "${p.body}" not found`, "pick the part the bin should hold");
  const bb = bodyBounds(ctx.oc, part);
  const diag = Math.hypot(bb.max[0]! - bb.min[0]!, bb.max[1]! - bb.min[1]!, bb.max[2]! - bb.min[2]!);
  const world = part.sourceMesh ?? surfaceTriangles(ctx, part, Math.max(0.05, Math.min(0.2, diag / 500)));
  const local = new Float64Array(world.length);
  const { origin: o, u, v, normal: n } = frame;
  for (let i = 0; i < world.length; i += 3) {
    const x = world[i]! - o[0], y = world[i + 1]! - o[1], z = world[i + 2]! - o[2];
    local[i] = x * u[0] + y * u[1] + z * u[2];
    local[i + 1] = x * v[0] + y * v[1] + z * v[2];
    local[i + 2] = x * n[0] + y * n[1] + z * n[2];
  }
  let plan: BinPlan;
  try {
    plan = planScanBin({ corners: local, sink: p.sink, clearance: p.clearance, grip: p.grip, ...(f.autoUnits ? {} : { units: f.units }), ...(f.autoHeight ? {} : { height: f.height }) });
  } catch (e) {
    if (e instanceof ScanBinError) throw new FeatureError(e.message);
    throw e;
  }
  const tool = meshSolid(ctx, `nest-${f.id}`, writeStl([{ positions: plan.tool, indices: Uint32Array.from({ length: plan.tool.length / 3 }, (_, i) => i) }]), "the nest", true);
  return { plan, tool };
}

/** A body's surface as triangle corners, within `tolerance` of its faces. */
function surfaceTriangles({ oc }: Ctx, body: Body, tolerance: number): Float32Array {
  const m = oc.ReplicadMeshExtractor.extract(body.shape, tolerance, 0.2, false);
  try {
    const buf = oc.wasmMemory.buffer;
    const positions = new Float32Array(buf, m.getVerticesPtr() >>> 0, m.getVerticesSize()).slice();
    const indices = new Uint32Array(buf, m.getTrianglesPtr() >>> 0, m.getTrianglesSize()).slice();
    const out = new Float32Array(indices.length * 3);
    for (let i = 0; i < indices.length; i++) out.set(positions.subarray(indices[i]! * 3, indices[i]! * 3 + 3), i * 3);
    return out;
  } finally {
    m.delete();
    // The fine triangulation would otherwise stay on the shape and be reused for display.
    oc.BRepTools.Clean(body.shape, true);
  }
}

/** Triangle corners of a body whose faces are all triangles (a mesh part without its source mesh), else null. */
function trianglesOf({ oc, arena }: Ctx, body: Body): Float32Array | null {
  const out = new Float32Array(body.faces.length * 9);
  for (let i = 0; i < body.faces.length; i++) {
    const pts: Vec3[] = [];
    for (const ex = arena.track(new oc.TopExp_Explorer(body.faces[i]!, "TopAbs_VERTEX")); ex.More(); ex.Next()) {
      const v = arena.track(oc.BRep_Tool.Pnt(arena.track(oc.TopoDS.Vertex(arena.track(ex.Current())))));
      const q: Vec3 = [v.X(), v.Y(), v.Z()];
      if (!pts.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1], o[2] - q[2]) < 1e-9)) pts.push(q);
    }
    const n = body.faceInfo[i]?.normal;
    if (pts.length !== 3 || !n) return null;
    const [a, b, c] = pts as [Vec3, Vec3, Vec3];
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cx = u[1]! * w[2]! - u[2]! * w[1]!, cy = u[2]! * w[0]! - u[0]! * w[2]!, cz = u[0]! * w[1]! - u[1]! * w[0]!;
    out.set(cx * n[0] + cy * n[1] + cz * n[2] < 0 ? [...a, ...c, ...b] : [...a, ...b, ...c], i * 9);
  }
  return out;
}

function unifyIfNeeded(ctx: Ctx, body: Body): Body {
  return body.faces.length > 2000 ? body : unify(ctx.oc, ctx.arena, body);
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
