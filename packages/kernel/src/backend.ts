import { edgeSelectorFor, propagateTags, resolveEdges, ResolveError } from "@opencad/naming";
import { FeatureError, type ExecResult, type KernelBackend, type ResolvedExtrude, type ResolvedFeature, type ResolvedFillet, type ResolvedSketch } from "@opencad/model";
import { asArray } from "@opencad/schema";
import { evaluateSketch, SketchError, toWorld, type SketchResult } from "@opencad/sketch";
import type { TopoDS_Edge, TopoDS_Shape } from "replicad-opencascadejs";
import { Arena } from "./arena.js";
import { Body, listToArray } from "./body.js";
import { occtErrorMessage, type OC } from "./occt.js";

export interface ModelState {
  readonly bodies: ReadonlyMap<string, Body>;
  readonly sketches: ReadonlyMap<string, SketchResult>;
  /** Objects created by the feature that produced this state. */
  readonly arena: Arena;
}

export class OcctBackend implements KernelBackend<ModelState> {
  constructor(private readonly oc: OC) {}

  initialState(): ModelState {
    return { bodies: new Map(), sketches: new Map(), arena: new Arena() };
  }

  dispose(state: ModelState): void {
    state.arena.dispose();
  }

  execute(f: ResolvedFeature, prev: ModelState): ExecResult<ModelState> {
    const arena = new Arena();
    try {
      switch (f.op) {
        case "sketch":
          return this.sketch(f, prev, arena);
        case "extrude":
          return this.extrude(f, prev, arena);
        case "fillet":
          return this.fillet(f, prev, arena);
      }
    } catch (e) {
      arena.dispose();
      if (e instanceof FeatureError) throw e;
      if (e instanceof ResolveError || e instanceof SketchError) throw new FeatureError(e.message);
      throw new FeatureError(`kernel error: ${occtErrorMessage(this.oc, e)}`);
    }
  }

  private sketch(f: ResolvedSketch, prev: ModelState, arena: Arena): ExecResult<ModelState> {
    const result = evaluateSketch(f);
    const sketches = new Map(prev.sketches).set(f.id, result);
    return { state: { ...prev, sketches, arena }, warnings: result.warnings };
  }

  private extrude(f: ResolvedExtrude, prev: ModelState, arena: Arena): ExecResult<ModelState> {
    const oc = this.oc;
    const sketchId = f.profile.ref.split(".")[0]!;
    const sketch = prev.sketches.get(sketchId);
    if (!sketch) throw new FeatureError(`sketch "${sketchId}" is missing or failed`);
    const profile = sketch.profiles.get(f.profile.ref);
    if (!profile) throw new FeatureError(`profile "${f.profile.ref}" not found`);
    if (Math.abs(f.distance) < 1e-6) throw new FeatureError("extrude distance must not be zero");
    if (profile.loops.length !== 1) throw new FeatureError("profiles with holes are not supported yet");

    const loop = profile.loops[0]!;
    const vertices = loop.points.map((p) => {
      const pnt = arena.track(new oc.gp_Pnt(...toWorld(sketch.frame, p)));
      return arena.track(arena.track(new oc.BRepBuilderAPI_MakeVertex(pnt)).Vertex());
    });
    const wireMaker = arena.track(new oc.BRepBuilderAPI_MakeWire());
    const edges: TopoDS_Edge[] = vertices.map((v, i) => {
      const edge = arena.track(arena.track(new oc.BRepBuilderAPI_MakeEdge(v, vertices[(i + 1) % vertices.length]!)).Edge());
      wireMaker.Add(edge);
      return edge;
    });
    const face = arena.track(arena.track(new oc.BRepBuilderAPI_MakeFace(arena.track(wireMaker.Wire()), true)).Face());
    const [nx, ny, nz] = sketch.frame.normal;
    const d = f.distance;
    const prism = arena.track(new oc.BRepPrimAPI_MakePrism(face, arena.track(new oc.gp_Vec(nx * d, ny * d, nz * d)), false, true));
    if (!prism.IsDone()) throw new FeatureError("extrude failed");

    const body = new Body(oc, arena, f.id, arena.track(prism.Shape()));
    const tags: string[][] = body.faces.map(() => []);
    const tag = (s: TopoDS_Shape, t: string) => tags[body.faceIndex(s)]?.push(t);
    tag(arena.track(prism.FirstShape()), `${f.id}.start_cap`);
    tag(arena.track(prism.LastShape()), `${f.id}.end_cap`);
    edges.forEach((e, i) => {
      for (const s of listToArray(arena, prism.Generated(e))) tag(s, `${f.id}.side[${loop.edgeNames[i]}]`);
    });
    const missing = tags.findIndex((t) => t.length === 0);
    if (missing >= 0) throw new FeatureError(`internal naming error: face ${missing} of extrude got no tag`);
    body.faceTags = tags;

    const bodies = new Map(prev.bodies).set(body.bodyId, body);
    return { state: { ...prev, bodies, arena } };
  }

  private fillet(f: ResolvedFillet, prev: ModelState, arena: Arena): ExecResult<ModelState> {
    const oc = this.oc;
    if (!(f.radius > 0)) throw new FeatureError("fillet radius must be greater than zero");
    const ref = resolveEdges(asArray(f.edges), [...prev.bodies.values()]);
    const input = prev.bodies.get(ref.body)!;

    const attempt = (radius: number) => {
      const mk = arena.track(new oc.BRepFilletAPI_MakeFillet(input.shape, "ChFi3d_Rational"));
      for (const ei of ref.edges) mk.Add(radius, input.edges[ei]!);
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

    const ok = attempt(f.radius);
    if (!ok) {
      // R2: tell the user what would work instead of only "failed".
      let r = f.radius;
      for (let i = 0; i < 6; i++) {
        r /= 2;
        if (attempt(r)) {
          throw new FeatureError(
            `fillet with radius ${fmt(f.radius)} mm failed`,
            `a radius of ${fmt(r)} mm works; the edges or neighbouring faces may be too short for ${fmt(f.radius)} mm`,
          );
        }
      }
      throw new FeatureError(`fillet with radius ${fmt(f.radius)} mm failed`, "the selected edges cannot be filleted");
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
    for (const ei of ref.edges) {
      const [fa, fb] = input.edgeFaces[ei] ?? [];
      const sel = edgeSelectorFor(input.faceTags[fa ?? -1] ?? [], input.faceTags[fb ?? -1] ?? []);
      const name = sel && "edge" in sel ? sel.edge.join("|") : `edge${ei}`;
      for (const s of listToArray(arena, mk.Generated(input.edges[ei]!))) {
        const i = body.faceIndex(s);
        if (i >= 0) generated.push({ face: i, tag: `${f.id}.round[${name}]` });
      }
    }
    // Corner blends where filleted edges meet come from vertices; they get positional tags.
    const { tags } = propagateTags(input.faceTags, body.faces.length, { descendants, generated }, `${f.id}.blend`);
    body.faceTags = tags;

    const bodies = new Map(prev.bodies).set(body.bodyId, body);
    return { state: { ...prev, bodies, arena } };
  }
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);
