import type { MeercadDocument } from "@meercad/schema";
import type { BodyMesh, BodySummary } from "./mesh.js";
import type { KeptMesh, WorkerRequest, WorkerResponse } from "./protocol.js";
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
 * Starting a fresh kernel before the running one is full. OCCT keeps some memory of every cut and
 * join for good (about 1 MB per step of a big design), so over a long session the kernel's 4 GB fill
 * up, and a kernel that breaks in the middle of a request costs that request and a whole rebuild.
 * Instead a second worker builds the open design in the background and takes over between two
 * requests; nothing is waited for. Only where there is room for two kernels at once (the Mac).
 */
export interface Renewal {
  /** A worker like the running one. */
  worker: () => Worker;
  /** Renew once the kernel's memory is above this (bytes; default 2.6 GB) … */
  above?: number;
  /** … and has grown by this much since the design was first built in it (bytes; default 600 MB). */
  grown?: number;
}
const GB = 2 ** 30;
/** How often a multi-threaded kernel may take over again after one broke on the model (see KernelClient.backToThreads). */
const BACK_TO_THREADS = 2;

/** A kernel being warmed up to take over (see Renewal). */
interface Spare {
  worker: Worker;
  /** The rebuild it has finished, and the one it is working on. */
  built: WorkerRequest | null;
  building: WorkerRequest | null;
  meshes: BodyMesh[];
  memory: number;
}

const sameArray = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const sameMesh = (a: BodyMesh, b: BodyMesh) => sameArray(a.indices, b.indices) && sameArray(a.positions, b.positions) && sameArray(a.faceRanges, b.faceRanges) && sameArray(a.edgeLines, b.edgeLines);

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
  /**
   * The meshes of the last main-session rebuild by body id, to put back the ones the worker only
   * names as unchanged (KeptMesh); null when they are not known, then the next rebuild asks for all.
   */
  private known: Map<string, BodyMesh> | null = new Map();
  /** The kernel's memory (bytes) after the first rebuild in this worker and after the latest. */
  private memory = { start: 0, now: 0 };
  private spare: Spare | null = null;
  private coarse: number | null = null;
  /** How often a fresh kernel has taken over (see Renewal). */
  renewed = 0;
  /**
   * A multi-threaded kernel broke on the model and a single-threaded one carries on (see `crashed`):
   * once the open requests are answered, a multi-threaded kernel builds the design in the background
   * and takes over again, as in a Renewal. Without that, everything after one break ran on a single
   * core until the app was restarted (booleans on a big design about ten times slower).
   */
  private backToThreads = false;
  /** Multi-threaded kernels that broke on a model; after BACK_TO_THREADS of them the single-threaded one stays. */
  private threadedBreaks = 0;
  /** The kernel's memory after the latest rebuild (bytes; 0 before the first). */
  get memoryUsed(): number {
    return this.memory.now;
  }

  constructor(
    worker: Worker,
    private readonly replace?: (crashed: { threads: boolean; message: string }) => Worker,
    private readonly renewal?: Renewal,
  ) {
    this.ready = new Promise((res, rej) => {
      this.onReady = res;
      this.onFatal = rej;
    });
    this.attach(worker);
  }

  private attach(worker: Worker): void {
    this.worker = worker;
    // A new worker has sent nothing yet, so it names no mesh as kept.
    this.known = new Map();
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
      if (msg.type === "rebuilt" && (!p || p.req.type === "rebuild")) {
        // Every main-session result moves the known meshes on, also one nobody waits for any more.
        const meshes = this.restore(msg.meshes);
        if (!meshes) {
          this.pending.delete(msg.seq);
          return p?.reject(new Error("the geometry kernel's meshes got out of step; build again"));
        }
        msg.meshes = meshes;
      }
      // The worker's memory, whichever session built (previews and pictures too).
      const memory = msg.type === "rebuilt" ? msg.report.kernelMemory : undefined;
      if (memory) this.memory = { start: this.memory.start || memory, now: memory };
      if (!p) return;
      if (msg.type === "progress") return p.onProgress?.({ index: msg.index, total: msg.total, feature: msg.feature });
      this.pending.delete(msg.seq);
      if (msg.type === "failed") p.reject(msg.message === "superseded" ? new SupersededError() : new Error(msg.message));
      else {
        if (msg.type === "rebuilt" && p.req.type === "rebuild") this.lastRebuild = p.req;
        p.resolve(msg);
      }
      if (this.spare) this.takeOver();
      else this.renew();
    });
  }

  /** Starts warming up a fresh kernel once this one's memory has grown far enough (see Renewal). */
  private renew(): void {
    const r = this.renewal;
    if (!r || this.spare || !this.lastRebuild) return;
    if (!this.backToThreads && (this.memory.now < (r.above ?? 2.6 * GB) || this.memory.now - this.memory.start < (r.grown ?? 0.6 * GB))) return;
    const worker = r.worker();
    const spare: Spare = { worker, built: null, building: null, meshes: [], memory: 0 };
    this.spare = spare;
    worker.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
      if (this.spare !== spare) return;
      const msg = e.data;
      if (msg.type === "fatal" || msg.type === "crashed" || msg.type === "failed") {
        // No fresh kernel this time: go on in the running one, and try again when it has grown more.
        // (A multi-threaded one that breaks on the design again is not tried any more.)
        worker.terminate();
        this.spare = null;
        this.backToThreads = false;
        this.memory.start = this.memory.now;
        return;
      }
      if (msg.type !== "rebuilt") return;
      spare.built = spare.building;
      spare.building = null;
      spare.meshes = msg.meshes as BodyMesh[];
      spare.memory = msg.report.kernelMemory ?? 0;
      this.takeOver();
    });
    if (this.coarse !== null) worker.postMessage({ type: "configure", seq: -1, meshCoarse: this.coarse } satisfies WorkerRequest);
    this.warm(spare);
  }

  private warm(spare: Spare): void {
    spare.building = this.lastRebuild;
    spare.worker.postMessage({ ...this.lastRebuild!, seq: -1, fresh: true });
  }

  /** The warmed-up kernel takes over, between two requests and once it holds the design as it is now. */
  private takeOver(): void {
    const spare = this.spare;
    if (!spare || !spare.built || spare.building || this.pending.size) return;
    if (spare.built !== this.lastRebuild) return this.warm(spare);
    const before = this.known;
    this.spare = null;
    this.worker.terminate();
    this.attach(spare.worker);
    // Its meshes are the ones it will name as kept. A part whose mesh came out the same keeps the
    // object the page already shows, so the view does not load every part again.
    this.known = new Map(
      spare.meshes.map((m) => {
        const had = before?.get(m.bodyId);
        return [m.bodyId, had && sameMesh(had, m) ? had : m];
      }),
    );
    this.memory = { start: spare.memory, now: spare.memory };
    this.backToThreads = false;
    this.renewed++;
  }

  private restore(list: (BodyMesh | KeptMesh)[]): BodyMesh[] | null {
    const known = this.known;
    const out: BodyMesh[] = [];
    for (const m of list) {
      const mesh = "kept" in m ? known?.get(m.bodyId) : m;
      if (!mesh) {
        this.known = null;
        return null;
      }
      out.push(mesh);
    }
    this.known = new Map(out.map((m) => [m.bodyId, m]));
    return out;
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
    this.spare?.worker.terminate();
    this.spare = null;
    // A kernel that broke when it was nearly full ran out of memory: a fresh one of the same kind
    // has room again. Otherwise the model broke OCCT, and `replace` gives a kernel that copes better.
    const full = this.renewal && this.memory.now > 3.2 * GB;
    // The single-threaded kernel is for the request that broke the other one, not for good.
    if (!full && msg.threads && this.renewal) this.backToThreads = ++this.threadedBreaks <= BACK_TO_THREADS;
    this.memory = { start: 0, now: 0 };
    this.attach(full ? this.renewal!.worker() : this.replace({ threads: msg.threads, message: msg.message }));
    if (this.coarse !== null) this.worker.postMessage({ type: "configure", seq: ++this.seq, meshCoarse: this.coarse } satisfies WorkerRequest);
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
   * Starts over in a fresh kernel from `worker` when this one holds more than `above` bytes, and says
   * whether it did. For the iPad and iPhone, where a second kernel does not fit (see Renewal): before
   * another design is built there, since OCCT does not give back what the last one took and the
   * kernels of two big designs one after the other outgrow the page. Requests still open reject with
   * SupersededError; the fresh kernel knows no design until the next rebuild.
   */
  restartIfAbove(above: number, worker: () => Worker): boolean {
    if (this.memory.now <= above) return false;
    this.restart(worker());
    return true;
  }

  /**
   * Goes on in `worker` from now on, e.g. a kernel of another kind (single-threaded for a big design
   * on the iPad). As restartIfAbove: requests still open reject with SupersededError.
   */
  restart(worker: Worker): void {
    this.spare?.worker.terminate();
    this.spare = null;
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new SupersededError());
    this.pending.clear();
    this.lastRebuild = null;
    this.memory = { start: 0, now: 0 };
    this.attach(worker);
    if (this.coarse !== null) this.worker.postMessage({ type: "configure", seq: ++this.seq, meshCoarse: this.coarse } satisfies WorkerRequest);
    this.renewed++;
  }

  /**
   * Rebuilds the document. Older rebuilds still queued reject with SupersededError. `props: false`
   * leaves out volume and surface area (NaN), which are slow to integrate on curved parts.
   */
  async rebuild(doc: MeercadDocument, opts: { props?: boolean; draft?: boolean; textures?: boolean; onProgress?: RebuildProgress } = {}): Promise<RebuildOutput> {
    const sent = performance.timeOrigin + performance.now();
    const r = await this.send({ type: "rebuild", doc: design(doc), ...(this.known ? {} : { fresh: true }), ...(opts.props === false ? { props: false } : {}), ...(opts.draft ? { draft: true } : {}), ...(opts.textures === false ? { textures: false } : {}) }, opts.onProgress);
    if (r.type !== "rebuilt") throw new Error("unexpected response");
    if (r.report.timing) r.report.timing = { ...r.report.timing, sent, received: this.lastReceived };
    return { report: r.report, meshes: r.meshes as BodyMesh[], references: r.references };
  }

  /** Rebuilds without touching the main session (AI proposals, feature previews). */
  async sandbox(doc: MeercadDocument): Promise<RebuildOutput> {
    const r = await this.send({ type: "sandbox", doc: design(doc) });
    if (r.type !== "rebuilt") throw new Error("unexpected response");
    // A sandbox session never names a mesh as kept.
    return { report: r.report, meshes: r.meshes as BodyMesh[], references: r.references };
  }

  /** Loosens tessellation by `meshCoarse` for all later rebuilds. */
  async configure(meshCoarse: number): Promise<void> {
    this.coarse = meshCoarse;
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

  /**
   * `skip`: parts left out altogether. `rigid`: parts with the same number are held together; their
   * pairs are left out.
   */
  /**
   * Overlaps of parts where they are modelled, for a big design: only pairs with one of `parts` (all
   * when left out), only parts reaching into `box`, and at most `budgetMs` of work; `left` counts
   * the pairs there was no time for, `fine` the imported meshes too fine to check (see FINE_MESH_FACES).
   */
  async overlaps(parts: string[], limits: { box?: { min: [number, number, number]; max: [number, number, number] }; budgetMs?: number } = {}): Promise<{ pairs: Clearance[]; left: number; fine: string[] }> {
    const r = await this.send({ type: "clearance", moving: parts, poses: {}, within: 0, ...limits });
    if (r.type !== "clearances") throw new Error("unexpected response");
    return { pairs: r.result, left: r.left ?? 0, fine: r.fine ?? [] };
  }

  async clearances(moving: string[], poses: Record<string, number[]>, within?: number, skip?: string[], rigid?: Record<string, number>): Promise<Clearance[]> {
    const r = await this.send({ type: "clearance", moving, poses, ...(within !== undefined ? { within } : {}), ...(skip?.length ? { skip } : {}), ...(rigid && Object.keys(rigid).length ? { rigid } : {}) });
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
