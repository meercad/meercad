import { RebuildEngine, type FeatureStatus } from "@opencad/model";
import type { OpencadDocument } from "@opencad/schema";
import { OcctBackend, type ModelState } from "./backend.js";
import type { Body } from "./body.js";
import { meshBody, summarizeBody, type BodyMesh, type BodySummary } from "./mesh.js";
import type { OC } from "./occt.js";

export interface RebuildReport {
  features: FeatureStatus[];
  paramErrors: Record<string, string>;
  params: Record<string, number>;
  bodies: BodySummary[];
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

  constructor(private readonly oc: OC) {
    this.engine = new RebuildEngine(new OcctBackend(oc));
  }

  rebuild(doc: OpencadDocument, opts: { mesh?: boolean } = {}): { report: RebuildReport; meshes: BodyMesh[] } {
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
    return {
      report: {
        features: r.features,
        paramErrors: r.paramErrors,
        params: r.params,
        bodies,
        rebuildMs: r.ms,
        meshMs: performance.now() - t,
        firstRecomputed: r.firstRecomputed,
      },
      meshes,
    };
  }

  /** Bodies of the most recent rebuild (for tests and exporters inside the worker). */
  get state(): ModelState | null {
    return this.last;
  }

  dispose(): void {
    this.engine.clear();
    this.last = null;
  }
}
