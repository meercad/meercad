import { SketchSolver } from "@meercad/sketch";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { loadOcct, occtErrorMessage, type OC } from "./occt.js";
import { KernelSession } from "./session.js";
import { exportStep, measure } from "./tools.js";

interface WorkerScope {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: MessageEvent<WorkerRequest>) => void): void;
}

/**
 * Worker entry. Requests are handled in order; while OCCT is busy newer rebuild requests replace
 * queued ones (latest wins), so dragging a value never builds a backlog.
 */
export function startKernelWorker(scope: WorkerScope, wasm: { occt?: string; planegcs?: string } = {}): void {
  let oc: OC | null = null;
  let solver: SketchSolver | null = null;
  let session: KernelSession | null = null;
  const queue: WorkerRequest[] = [];
  let busy = false;
  const now = () => performance.timeOrigin + performance.now();
  const received = new Map<number, number>();

  scope.addEventListener("message", (e) => {
    const req = e.data;
    if ("seq" in req) received.set(req.seq, now());
    if (req.type === "rebuild" || req.type === "sandbox") {
      const i = queue.findIndex((q) => q.type === req.type);
      if (i >= 0) {
        scope.postMessage({ type: "failed", seq: queue[i]!.seq, message: "superseded" });
        received.delete(queue[i]!.seq);
        queue.splice(i, 1);
      }
    }
    queue.push(req);
    void pump();
  });

  async function pump(): Promise<void> {
    if (busy || !session) return;
    busy = true;
    await new Promise((r) => setTimeout(r, 0));
    const req = queue.shift();
    try {
      if (req) handle(req);
    } finally {
      if (req) received.delete(req.seq);
      busy = false;
      if (queue.length) void pump();
    }
  }

  function handle(req: WorkerRequest): void {
    try {
      switch (req.type) {
        case "rebuild": {
          const start = now();
          const r = session!.rebuild(req.doc, { mesh: req.mesh !== false, props: req.props !== false });
          r.report.timing = { recv: received.get(req.seq) ?? start, start, post: now() };
          scope.postMessage({ type: "rebuilt", seq: req.seq, ...r });
          break;
        }
        case "sandbox": {
          const sandbox = new KernelSession(oc!, solver!);
          try {
            const r = sandbox.rebuild(req.doc);
            scope.postMessage({ type: "rebuilt", seq: req.seq, ...r });
          } finally {
            sandbox.dispose();
          }
          break;
        }
        case "export_step": {
          const data = exportStep(oc!, session!.state!, req.bodies);
          scope.postMessage({ type: "exported", seq: req.seq, data }, [data.buffer]);
          break;
        }
        case "measure":
          scope.postMessage({ type: "measured", seq: req.seq, result: measure(oc!, session!.state!, req.a, req.b) });
          break;
      }
    } catch (err) {
      scope.postMessage({ type: "failed", seq: req.seq, message: oc ? occtErrorMessage(oc, err) : String(err) });
    }
  }

  const t0 = performance.now();
  Promise.all([loadOcct(wasm.occt), SketchSolver.create(wasm.planegcs)]).then(
    ([loaded, s]) => {
      oc = loaded;
      solver = s;
      session = new KernelSession(loaded, s);
      scope.postMessage({ type: "ready", initMs: performance.now() - t0 });
      void pump();
    },
    (err: unknown) => scope.postMessage({ type: "fatal", message: `failed to load geometry kernel: ${String(err)}` }),
  );
}
