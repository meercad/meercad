import { RebuildEngine, type FeatureStatus } from "@opencad/model";
import type { OpencadDocument } from "@opencad/schema";
import type { PlaneFrame, SketchSolver, SolveDiagnostics, SolvedCurve, Vec2 } from "@opencad/sketch";
import { OcctBackend } from "./backend.js";
import type { Body } from "./body.js";
import { meshBody, summarizeBody, type BodyMesh, type BodySummary } from "./mesh.js";
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
}

/** One open document in the kernel: incremental rebuild plus per-body tessellation cache. */
export class KernelSession {
  private readonly engine: RebuildEngine<ModelState>;
  private meshCache = new WeakMap<Body, { mesh: BodyMesh; summary: BodySummary }>();
  private last: ModelState | null = null;

  constructor(
    private readonly oc: OC,
    solver: SketchSolver,
  ) {
    this.engine = new RebuildEngine(new OcctBackend(oc, solver));
  }

  rebuild(doc: OpencadDocument, opts: { mesh?: boolean } = {}): { report: RebuildReport; meshes: BodyMesh[]; references: ReferenceView[] } {
    const r = this.engine.rebuild(doc);
    this.last = r.state;
    const t = performance.now();
    const meshes: BodyMesh[] = [];
    const bodies: BodySummary[] = [];
    for (const body of r.state.bodies.values()) {
      let cached = this.meshCache.get(body);
      if (!cached) {
        const summary = summarizeBody(this.oc, body);
        cached = { summary, mesh: meshBody(this.oc, body, summary.bbox) };
        this.meshCache.set(body, cached);
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
      },
      meshes,
      references: [...r.state.references.values()].map((m) => ({ id: m.id, positions: m.positions, indices: m.indices })),
    };
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
