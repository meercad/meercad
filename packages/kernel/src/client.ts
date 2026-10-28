import type { MeercadDocument } from "@meercad/schema";
import type { BodyMesh, BodySummary } from "./mesh.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import type { RebuildReport, ReferenceView } from "./session.js";
import type { Measurement, PickRef } from "./tools.js";

export type { Measurement, PickRef } from "./tools.js";

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

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void };
type Distribute<T> = T extends unknown ? Omit<T, "seq"> : never;

/** Main-thread handle to the kernel worker. */
export class KernelClient {
  private seq = 0;
  /** When the latest message from the worker arrived (ms since the epoch). */
  private lastReceived = 0;
  private pending = new Map<number, Pending>();
  readonly ready: Promise<{ initMs: number; threads: boolean }>;

  constructor(private readonly worker: Worker) {
    let onReady!: (v: { initMs: number; threads: boolean }) => void;
    let onFatal!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      onReady = res;
      onFatal = rej;
    });
    worker.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
      this.lastReceived = performance.timeOrigin + performance.now();
      const msg = e.data;
      if (msg.type === "ready") return onReady({ initMs: msg.initMs, threads: msg.threads });
      if (msg.type === "fatal") {
        const err = new Error(msg.message);
        onFatal(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        return;
      }
      const p = this.pending.get(msg.seq);
      if (!p) return;
      this.pending.delete(msg.seq);
      if (msg.type === "failed") p.reject(msg.message === "superseded" ? new SupersededError() : new Error(msg.message));
      else p.resolve(msg);
    });
  }

  /**
   * Rebuilds the document. Older rebuilds still queued reject with SupersededError. `props: false`
   * leaves out volume and surface area (NaN), which are slow to integrate on curved parts.
   */
  async rebuild(doc: MeercadDocument, opts: { props?: boolean } = {}): Promise<RebuildOutput> {
    const sent = performance.timeOrigin + performance.now();
    const r = await this.send({ type: "rebuild", doc, ...(opts.props === false ? { props: false } : {}) });
    if (r.type !== "rebuilt") throw new Error("unexpected response");
    if (r.report.timing) r.report.timing = { ...r.report.timing, sent, received: this.lastReceived };
    return { report: r.report, meshes: r.meshes, references: r.references };
  }

  /** Rebuilds without touching the main session (AI proposals, feature previews). */
  async sandbox(doc: MeercadDocument): Promise<RebuildOutput> {
    const r = await this.send({ type: "sandbox", doc });
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

  async exportStep(bodies?: string[]): Promise<Uint8Array> {
    const r = await this.send({ type: "export_step", ...(bodies ? { bodies } : {}) });
    if (r.type !== "exported") throw new Error("unexpected response");
    return r.data;
  }

  /** Print/CNC-quality triangles for STL/3MF export. */
  async exportMeshes(bodies?: string[]): Promise<BodyMesh[]> {
    const r = await this.send({ type: "export_mesh", ...(bodies ? { bodies } : {}) });
    if (r.type !== "exported_mesh") throw new Error("unexpected response");
    return r.meshes;
  }

  async measure(a: PickRef, b?: PickRef): Promise<Measurement> {
    const r = await this.send({ type: "measure", a, ...(b ? { b } : {}) });
    if (r.type !== "measured") throw new Error("unexpected response");
    return r.result;
  }

  private send(req: Distribute<WorkerRequest>): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const seq = ++this.seq;
      this.pending.set(seq, { resolve, reject });
      this.worker.postMessage({ ...req, seq } as WorkerRequest);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
