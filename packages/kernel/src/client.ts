import type { MeercadDocument } from "@meercad/schema";
import type { BodyMesh, BodySummary } from "./mesh.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import type { RebuildReport, ReferenceView } from "./session.js";
import type { Clearance, Measurement, PickRef, StepPart } from "./tools.js";
import type { DrawingView, ViewName } from "./drawing.js";

export type { Measurement, PickRef } from "./tools.js";
export type { DrawingView, ViewName } from "./drawing.js";

export interface RebuildOutput {
  report: RebuildReport;
  meshes: BodyMesh[];
  references: ReferenceView[];
}

export class SupersededError extends Error {
  constructor() {
    super("superseded by a newer rebuild");
  }
}

export type RebuildProgress = (p: { index: number; total: number; feature: string }) => void;
type Pending = { req: WorkerRequest; retried: boolean; resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; onProgress?: RebuildProgress };
type Distribute<T> = T extends unknown ? Omit<T, "seq"> : never;

/**
 * Main-thread handle to the kernel worker. When OCCT breaks inside the worker (a WebAssembly runtime
 * error, after which its memory cannot be trusted), `replace` gives a new worker: the open requests
 * go to it once more, after the last document so exports and measuring still have a model. A
 * request that breaks the new worker too fails with the error.
 */
export class KernelClient {
  private seq = 0;
  /** When the latest message from the worker arrived (ms since the epoch). */
  private lastReceived = 0;
  private pending = new Map<number, Pending>();
  private lastRebuild: WorkerRequest | null = null;
  private worker!: Worker;
  readonly ready: Promise<{ initMs: number; threads: boolean }>;
  private onReady!: (v: { initMs: number; threads: boolean }) => void;
  private onFatal!: (e: Error) => void;

  constructor(
    worker: Worker,
    private readonly replace?: (crashed: { threads: boolean; message: string }) => Worker,
  ) {
    this.ready = new Promise((res, rej) => {
      this.onReady = res;
      this.onFatal = rej;
    });
    this.attach(worker);
  }

  private attach(worker: Worker): void {
    this.worker = worker;
    worker.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
      if (worker !== this.worker) return;
      this.lastReceived = performance.timeOrigin + performance.now();
      const msg = e.data;
      if (msg.type === "ready") return this.onReady({ initMs: msg.initMs, threads: msg.threads });
      if (msg.type === "fatal") {
        const err = new Error(msg.message);
        this.onFatal(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        return;
      }
      if (msg.type === "crashed") return this.crashed(msg);
      const p = this.pending.get(msg.seq);
      if (!p) return;
      if (msg.type === "progress") return p.onProgress?.({ index: msg.index, total: msg.total, feature: msg.feature });
      this.pending.delete(msg.seq);
      if (msg.type === "failed") p.reject(msg.message === "superseded" ? new SupersededError() : new Error(msg.message));
      else {
        if (msg.type === "rebuilt" && p.req.type === "rebuild") this.lastRebuild = p.req;
        p.resolve(msg);
      }
    });
  }

  private crashed(msg: Extract<WorkerResponse, { type: "crashed" }>): void {
    const culprit = this.pending.get(msg.seq);
    if (!this.replace) {
      for (const p of this.pending.values()) p.reject(new Error(msg.message));
      this.pending.clear();
      return;
    }
    console.warn(`geometry kernel broke (${msg.message}); starting a new one`);
    this.worker.terminate();
    this.attach(this.replace({ threads: msg.threads, message: msg.message }));
    if (culprit?.retried) {
      this.pending.delete(msg.seq);
      culprit.reject(new Error(`the geometry kernel broke: ${msg.message}`));
    }
    if (culprit) culprit.retried = true;
    // The new worker knows no model yet: the last one first, unless a newer rebuild is waiting.
    const open = [...this.pending.entries()].sort(([a], [b]) => a - b);
    if (this.lastRebuild && !open.some(([, p]) => p.req.type === "rebuild")) this.worker.postMessage({ ...this.lastRebuild, seq: ++this.seq });
    for (const [, p] of open) this.worker.postMessage(p.req);
  }

  /**
   * Rebuilds the document. Older rebuilds still queued reject with SupersededError. `props: false`
   * leaves out volume and surface area (NaN), which are slow to integrate on curved parts.
   */
  async rebuild(doc: MeercadDocument, opts: { props?: boolean; draft?: boolean; textures?: boolean; onProgress?: RebuildProgress } = {}): Promise<RebuildOutput> {
    const sent = performance.timeOrigin + performance.now();
    const r = await this.send({ type: "rebuild", doc: design(doc), ...(opts.props === false ? { props: false } : {}), ...(opts.draft ? { draft: true } : {}), ...(opts.textures === false ? { textures: false } : {}) }, opts.onProgress);
    if (r.type !== "rebuilt") throw new Error("unexpected response");
    if (r.report.timing) r.report.timing = { ...r.report.timing, sent, received: this.lastReceived };
    return { report: r.report, meshes: r.meshes, references: r.references };
  }

  /** Rebuilds without touching the main session (AI proposals, feature previews). */
  async sandbox(doc: MeercadDocument): Promise<RebuildOutput> {
    const r = await this.send({ type: "sandbox", doc: design(doc) });
    if (r.type !== "rebuilt") throw new Error("unexpected response");
    return { report: r.report, meshes: r.meshes, references: r.references };
  }

  /** Loosens tessellation by `meshCoarse` for all later rebuilds. */
  async configure(meshCoarse: number): Promise<void> {
    await this.send({ type: "configure", meshCoarse });
  }

  /** Volume and surface area of the last rebuild's bodies (after `props: false` rebuilds). */
  async bodyProps(): Promise<BodySummary[]> {
    const r = await this.send({ type: "props" });
    if (r.type !== "props") throw new Error("unexpected response");
    return r.bodies;
  }

  async exportStep(bodies?: string[], parts?: StepPart[]): Promise<Uint8Array> {
    const r = await this.send({ type: "export_step", ...(bodies ? { bodies } : {}) , ...(parts ? { parts } : {}) });
    if (r.type !== "exported") throw new Error("unexpected response");
    return r.data;
  }

  /** Print/CNC-quality triangles for STL/3MF export. */
  async exportMeshes(bodies?: string[]): Promise<BodyMesh[]> {
    const r = await this.send({ type: "export_mesh", ...(bodies ? { bodies } : {}) });
    if (r.type !== "exported_mesh") throw new Error("unexpected response");
    return r.meshes;
  }

  async clearances(moving: string[], poses: Record<string, number[]>, within?: number): Promise<Clearance[]> {
    const r = await this.send({ type: "clearance", moving, poses, ...(within !== undefined ? { within } : {}) });
    if (r.type !== "clearances") throw new Error("unexpected response");
    return r.result;
  }

  /** Views of the parts for a technical drawing, visible and hidden lines. */
  async drawing(views: ViewName[], bodies?: string[], doc?: MeercadDocument): Promise<DrawingView[]> {
    const r = await this.send({ type: "drawing", views, ...(bodies ? { bodies } : {}), ...(doc ? { doc: design(doc) } : {}) });
    if (r.type !== "drawn") throw new Error("unexpected response");
    return r.views;
  }

  async measure(a: PickRef, b?: PickRef): Promise<Measurement> {
    const r = await this.send({ type: "measure", a, ...(b ? { b } : {}) });
    if (r.type !== "measured") throw new Error("unexpected response");
    return r.result;
  }

  private send(req: Distribute<WorkerRequest>, onProgress?: RebuildProgress): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const full = { ...req, seq: ++this.seq } as WorkerRequest;
      this.pending.set(full.seq, { req: full, retried: false, resolve, reject, ...(onProgress ? { onProgress } : {}) });
      this.worker.postMessage(full);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

/**
 * The document without its saved versions and mesh pictures: the worker builds the design only,
 * and need not be sent the versions' files or the textures (which only change the look).
 */
function design(doc: MeercadDocument): MeercadDocument {
  const textured = doc.features.some((f) => f.op === "import" && f.texture);
  if (!doc.versions && !doc.blobs && !textured) return doc;
  const { versions: _v, blobs: _b, ...rest } = doc;
  if (textured) rest.features = rest.features.map((f) => (f.op === "import" && f.texture ? (({ texture: _t, ...plain }) => plain)(f) : f));
  return rest;
}
