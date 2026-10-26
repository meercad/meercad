import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { loadOcct, occtErrorMessage, type OC } from "./occt.js";
import { KernelSession } from "./session.js";

interface WorkerScope {
  postMessage(msg: WorkerResponse): void;
  addEventListener(type: "message", fn: (e: MessageEvent<WorkerRequest>) => void): void;
}

/**
 * Worker entry: `startKernelWorker(self, wasmUrl)`. Requests are handled in order; while OCCT is busy
 * newer rebuild requests replace queued ones (latest wins), so dragging a value never builds a backlog.
 */
export function startKernelWorker(scope: WorkerScope, wasmUrl?: string): void {
  let oc: OC | null = null;
  let session: KernelSession | null = null;
  const queue: WorkerRequest[] = [];
  let busy = false;

  scope.addEventListener("message", (e) => {
    const req = e.data;
    if (req.type === "rebuild") {
      const i = queue.findIndex((q) => q.type === "rebuild");
      if (i >= 0) {
        scope.postMessage({ type: "failed", seq: queue[i]!.seq, message: "superseded" });
        queue.splice(i, 1);
      }
    }
    queue.push(req);
    void pump();
  });

  async function pump(): Promise<void> {
    if (busy || !session) return;
    busy = true;
    // Yield so messages that arrived meanwhile can supersede queued ones.
    await new Promise((r) => setTimeout(r, 0));
    const req = queue.shift();
    try {
      if (req) handle(req);
    } finally {
      busy = false;
      if (queue.length) void pump();
    }
  }

  function handle(req: WorkerRequest): void {
    try {
      if (req.type === "rebuild") {
        const { report, meshes } = session!.rebuild(req.doc, { mesh: req.mesh !== false });
        scope.postMessage({ type: "rebuilt", seq: req.seq, report, meshes });
      } else {
        const sandbox = new KernelSession(oc!);
        try {
          const { report } = sandbox.rebuild(req.doc, { mesh: false });
          scope.postMessage({ type: "rebuilt", seq: req.seq, report, meshes: [] });
        } finally {
          sandbox.dispose();
        }
      }
    } catch (err) {
      scope.postMessage({ type: "failed", seq: req.seq, message: oc ? occtErrorMessage(oc, err) : String(err) });
    }
  }

  const t0 = performance.now();
  loadOcct(wasmUrl).then(
    (loaded) => {
      oc = loaded;
      session = new KernelSession(loaded);
      scope.postMessage({ type: "ready", initMs: performance.now() - t0 });
      void pump();
    },
    (err: unknown) => scope.postMessage({ type: "fatal", message: `failed to load geometry kernel: ${String(err)}` }),
  );
}
