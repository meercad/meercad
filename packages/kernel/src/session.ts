import { RebuildEngine, type FeatureStatus } from "@meercad/model";
import type { MeercadDocument } from "@meercad/schema";
import type { PlaneFrame, SketchSolver, SolveDiagnostics, SolvedCurve, Vec2 } from "@meercad/sketch";
import { OcctBackend } from "./backend.js";
import type { Body } from "./body.js";
import { meshBody, summarizeBody, type BodyMesh, type BodySummary } from "./mesh.js";
import { gearViews, jointFrames, type GearView, type JointFrame } from "./joints.js";
import type { OC } from "./occt.js";
import type { ModelState } from "./state.js";

/** Solved sketch geometry for the editor and for drawing sketches in the viewport. */
export interface SketchView {
  id: string;
  frame: PlaneFrame;
  points: [string, number, number][];
  curves: SolvedCurve[];
  regions: { key: string; depth: number; area: number; polygons: Vec2[][]; sample: Vec2 }[];
  diagnostics: SolveDiagnostics;
}

export interface ReferenceView {
  id: string;
  positions: Float32Array;
  indices: Uint32Array;
}

export interface RebuildReport {
  features: FeatureStatus[];
  paramErrors: Record<string, string>;
  params: Record<string, number>;
  bodies: BodySummary[];
  sketches: SketchView[];
  planes: { id: string; frame: PlaneFrame }[];
  /** Feature evaluation time (ms). */
  rebuildMs: number;
  /** Tessellation and summaries (ms). */
  meshMs: number;
  firstRecomputed: number;
  /** Axes of the document's joints. */
  joints: JointFrame[];
  /** Gears with their axes, for adding joints to them. */
  gears: GearView[];
  /** Wall-clock milestones (ms since the epoch, comparable across threads) for diagnostics. */
  timing?: Partial<RebuildTiming>;
}

export interface RebuildTiming {
  /** Main thread posted the request. */
  sent: number;
  /** Worker received it. */
  recv: number;
  /** Worker started on it (after anything queued before). */
  start: number;
  /** Worker posted the result. */
  post: number;
  /** Main thread received the result. */
  received: number;
}

/** One open document in the kernel: incremental rebuild plus per-body tessellation cache. */
export class KernelSession {
  private readonly engine: RebuildEngine<ModelState>;
  private meshCache = new WeakMap<Body, { mesh: BodyMesh; summary: BodySummary; props: boolean }>();
  private last: ModelState | null = null;
  /** Tessellation tolerance factor (see meshBody); set before the first rebuild. */
  meshCoarse = 1;

  constructor(
    private readonly oc: OC,
    solver: SketchSolver,
  ) {
    this.engine = new RebuildEngine(new OcctBackend(oc, solver));
  }

  rebuild(doc: MeercadDocument, opts: { mesh?: boolean; props?: boolean } = {}): { report: RebuildReport; meshes: BodyMesh[]; references: ReferenceView[] } {
    const r = this.engine.rebuild(doc);
    this.last = r.state;
    const t = performance.now();
    const meshes: BodyMesh[] = [];
    const bodies: BodySummary[] = [];
    for (const body of r.state.bodies.values()) {
      const props = opts.props !== false;
      let cached = this.meshCache.get(body);
      if (!cached) {
        const summary = summarizeBody(this.oc, body, props);
        cached = { summary, mesh: meshBody(this.oc, body, summary.bbox, this.meshCoarse), props };
        this.meshCache.set(body, cached);
      } else if (props && !cached.props) {
        cached.summary = summarizeBody(this.oc, body, true);
        cached.props = true;
      }
      bodies.push(cached.summary);
      if (opts.mesh !== false) meshes.push(cached.mesh);
    }
    const sketches: SketchView[] = [...r.state.sketches.values()].map((s) => ({
      id: s.id,
      frame: s.frame,
      points: [...s.solved.points].map(([id, [x, y]]) => [id, x, y]),
      curves: s.solved.curves,
      regions: s.regions.map((g) => ({ key: g.key, depth: g.depth, area: g.area, polygons: g.polygons, sample: g.sample })),
      diagnostics: s.solved.diagnostics,
    }));
    return {
      report: {
        features: r.features,
        paramErrors: r.paramErrors,
        params: r.params,
        bodies,
        sketches,
        planes: [...r.state.planes].map(([id, frame]) => ({ id, frame })),
        rebuildMs: r.ms,
        meshMs: performance.now() - t,
        firstRecomputed: r.firstRecomputed,
        joints: jointFrames(this.oc, r.state, doc.mechanism),
        gears: gearViews(r.state, new Map(doc.features.flatMap((f) => (f.op === "gear" && f.meshWith ? [[f.id, f.meshWith.gear] as [string, string]] : [])))),
      },
      meshes,
      references: [...r.state.references.values()].map((m) => ({ id: m.id, positions: m.positions, indices: m.indices })),
    };
  }

  /** Summaries with volume and area for the last rebuild's bodies, filling in what `props: false` skipped. */
  bodyProps(): BodySummary[] {
    const out: BodySummary[] = [];
    for (const body of this.last?.bodies.values() ?? []) {
      const cached = this.meshCache.get(body);
      if (cached && !cached.props) {
        cached.summary = summarizeBody(this.oc, body, true);
        cached.props = true;
      }
      out.push(cached?.summary ?? summarizeBody(this.oc, body, true));
    }
    return out;
  }

  /** Bodies of the most recent rebuild (for exporters and measuring inside the worker). */
  get state(): ModelState | null {
    return this.last;
  }

  dispose(): void {
    this.engine.clear();
    this.last = null;
  }
}
