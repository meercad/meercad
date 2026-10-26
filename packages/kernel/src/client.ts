import type { OpencadDocument } from "@opencad/schema";
import type { BodyMesh } from "./mesh.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import type { RebuildReport } from "./session.js";

export interface RebuildOutput {
  report: RebuildReport;
  meshes: BodyMesh[];
}

export class SupersededError extends Error {
  constructor() {
    super("superseded by a newer rebuild");
  }
}

/** Main-thread handle to the kernel worker. */
export class KernelClient {
  private seq = 0;
  private pending = new Map<number, { resolve: (r: RebuildOutput) => void; reject: (e: Error) => void }>();
  readonly ready: Promise<{ initMs: number }>;

  constructor(private readonly worker: Worker) {
    let onReady!: (v: { initMs: number }) => void;
    let onFatal!: (e: Error) => void;
    this.ready = new Promise((res, rej) => {
      onReady = res;
      onFatal = rej;
    });
    worker.addEventListener("message", (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      if (msg.type === "ready") return onReady({ initMs: msg.initMs });
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
      if (msg.type === "rebuilt") p.resolve({ report: msg.report, meshes: msg.meshes });
      else p.reject(msg.message === "superseded" ? new SupersededError() : new Error(msg.message));
    });
  }

  /** Rebuilds the document. Older rebuilds still queued reject with SupersededError. */
  rebuild(doc: OpencadDocument): Promise<RebuildOutput> {
    return this.send({ type: "rebuild", seq: ++this.seq, doc });
  }

  /** Rebuilds without touching the main session (for validating AI proposals). */
  sandbox(doc: OpencadDocument): Promise<RebuildReport> {
    return this.send({ type: "sandbox", seq: ++this.seq, doc }).then((r) => r.report);
  }

  private send(req: WorkerRequest): Promise<RebuildOutput> {
    return new Promise((resolve, reject) => {
      this.pending.set(req.seq, { resolve, reject });
      this.worker.postMessage(req);
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
