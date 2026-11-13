import { RebuildEngine, type FeatureStatus, type RebuildResult } from "@meercad/model";
import type { MeercadDocument } from "@meercad/schema";
import type { PlaneFrame, SketchSolver, SolveDiagnostics, SolvedCurve, Vec2 } from "@meercad/sketch";
import { OcctBackend } from "./backend.js";
import type { Body } from "./body.js";
import { meshBody, summarizeBody, type BodyMesh, type BodySummary } from "./mesh.js";
import { gearViews, jointFrames, type GearView, type JointFrame } from "./joints.js";
import type { OC } from "./occt.js";
import type { ModelState } from "./state.js";
import { needsFineBase, texturedMesh, texturesOf } from "./texture.js";

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
  /**
   * Size of the kernel's memory after this rebuild (bytes; of 4 GB it can have), see Renewal in client.ts.
   */
  kernelMemory?: number;
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

interface RebuildOptions {
  mesh?: boolean;
  props?: boolean;
  draft?: boolean;
  textures?: boolean;
  onFeature?: (index: number, total: number, id: string) => void;
}
type RebuildOut = { report: RebuildReport; meshes: BodyMesh[]; references: ReferenceView[] };

/** One open document in the kernel: incremental rebuild plus per-body tessellation cache. */
export class KernelSession {
  private readonly engine: RebuildEngine<ModelState>;
  private meshCache = new WeakMap<Body, { mesh: BodyMesh; summary: BodySummary; props: boolean }>();
  /** Textured display meshes by body, with what they were made from (`sig`). */
  private textureCache = new WeakMap<Body, { sig: string; mesh: BodyMesh }>();
  private last: ModelState | null = null;
  /** Tessellation tolerance factor (see meshBody); set before the first rebuild. */
  meshCoarse = 1;

  constructor(
    private readonly oc: OC,
    solver: SketchSolver,
  ) {
    this.engine = new RebuildEngine(new OcctBackend(oc, solver));
  }

  rebuild(doc: MeercadDocument, opts: RebuildOptions = {}): RebuildOut {
    const r = this.engine.rebuild(doc, opts.onFeature);
    this.last = r.state;

    return this.output(doc, r, opts);
  }

  /**
   * Builds `doc` as a preview next to the open document, which stays as it is: what the two share
   * from the first feature on is taken from this session (states and meshes), so trying a change
   * near the end of a long design costs about as much as making it.
   */
  preview(doc: MeercadDocument, opts: RebuildOptions = {}): RebuildOut {
    const r = this.engine.fork(doc, opts.onFeature);

    try {
      return this.output(doc, r, opts);
    } finally {
      r.release();
    }
  }

  private output(doc: MeercadDocument, r: RebuildResult<ModelState>, opts: RebuildOptions): RebuildOut {
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

      if (opts.mesh !== false) {
        meshes.push(
          opts.textures === false
            ? cached.mesh
            : this.withTextures(r.state, body, cached.mesh, cached.summary, opts.draft === true),
        );
      }
    }

    const sketches: SketchView[] = [...r.state.sketches.values()].map((sketchResult) => ({
      id: sketchResult.id,
      frame: sketchResult.frame,
      points: [...sketchResult.solved.points].map(([id, [x, y]]) => [id, x, y]),
      curves: sketchResult.solved.curves,
      regions: sketchResult.regions.map((region) => ({
        key: region.key,
        depth: region.depth,
        area: region.area,
        polygons: region.polygons,
        sample: region.sample,
      })),
      diagnostics: sketchResult.solved.diagnostics,
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
        gears: gearViews(
          r.state,
          new Map(
            doc.features.flatMap((feature) =>
              feature.op === "gear" && feature.meshWith
                ? [[feature.id, feature.meshWith.gear] as [string, string]]
                : [],
            ),
          ),
        ),
      },
      meshes,
      references: [...r.state.references.values()].map((m) => ({
        id: m.id,
        positions: m.positions,
        indices: m.indices,
      })),
    };
  }

  /**
   * A body's display mesh with its height pictures (lithophanes), if it has any (cached while they stay the
   * same).
   */
  private withTextures(
    state: ModelState,
    body: Body,
    mesh: BodyMesh,
    summary: BodySummary,
    draft: boolean,
  ): BodyMesh {
    const tex = texturesOf(state, body);
    if (!tex) return mesh;

    const hit = this.textureCache.get(body);

    // A finished mesh also serves a draft request; a draft is redone once the value is let go.
    if (
      hit &&
      (hit.sig === tex.sig || hit.sig === `draft:${tex.sig}`) &&
      (draft || !hit.sig.startsWith("draft:"))
    ) {
      return hit.mesh;
    }

    let base = mesh;

    if (needsFineBase(this.oc, body, tex.layers)) {
      // Curved faces need a base that follows the surface closely, or its facets show through.
      base = meshBody(this.oc, body, summary.bbox, 1, true);
      this.oc.BRepTools.Clean(body.shape, true);
    }

    const textured = texturedMesh(
      this.oc,
      body,
      base,
      tex.layers,
      draft ? "draft" : "display",
      this.meshCoarse,
    );
    this.textureCache.set(body, { sig: draft ? `draft:${tex.sig}` : tex.sig, mesh: textured });

    return textured;
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
