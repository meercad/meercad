import { SketchSolver } from "@meercad/sketch";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { crashOf, loadOcct, occtErrorMessage, type OC } from "./occt.js";
import { KernelSession } from "./session.js";
import { clearances, exportMeshes, exportStep, measure } from "./tools.js";
import { drawingViews } from "./drawing.js";

interface WorkerScope {
  postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", fn: (e: MessageEvent<WorkerRequest>) => void): void;
}

/**
 * Worker entry. Requests are handled in order; while OCCT is busy newer rebuild requests replace
 * queued ones (latest wins), so dragging a value never builds a backlog.
 *
 * `wasm.occtThreads` asks for the multi-threaded OCCT build (the page must be cross-origin
 * isolated); if it fails to start, the worker falls back to the single-threaded `wasm.occt`.
 */
export function startKernelWorker(scope: WorkerScope, wasm: { occt?: string; occtThreads?: string; planegcs?: string } = {}): void {
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
    // Replies wait until it is clear OCCT came through; a result from a broken module is not sent.
    const replies: [WorkerResponse, Transferable[]?][] = [];
    const post = (msg: WorkerResponse, transfer?: Transferable[]) => replies.push([msg, transfer]);
    try {
      run(req, post);
    } catch (err) {
      post({ type: "failed", seq: req.seq, message: oc ? occtErrorMessage(oc, err) : String(err) });
    }
    const crash = oc && crashOf(oc);
    if (crash) {
      // Stop here: the page replaces this worker and sends the open requests to the new one.
      session = null;
      scope.postMessage({ type: "crashed", seq: req.seq, message: crash, threads });
      return;
    }
    for (const [msg, transfer] of replies) scope.postMessage(msg, transfer);
  }

  function run(req: WorkerRequest, post: (msg: WorkerResponse, transfer?: Transferable[]) => void): void {
    switch (req.type) {
      case "rebuild": {
        const start = now();
        const r = session!.rebuild(req.doc, {
          mesh: req.mesh !== false,
          props: req.props !== false,
          // Sent at once, not with the replies: the page shows how far the rebuild has got.
          onFeature: (index, total, feature) => scope.postMessage({ type: "progress", seq: req.seq, index, total, feature }),
        });
        r.report.timing = { recv: received.get(req.seq) ?? start, start, post: now() };
        post({ type: "rebuilt", seq: req.seq, ...r });
        break;
      }
      case "sandbox": {
        const sandbox = new KernelSession(oc!, solver!);
        try {
          const r = sandbox.rebuild(req.doc);
          post({ type: "rebuilt", seq: req.seq, ...r });
        } finally {
          sandbox.dispose();
        }
        break;
      }
      case "export_step": {
        const data = exportStep(oc!, session!.state!, req.bodies, req.parts);
        post({ type: "exported", seq: req.seq, data }, [data.buffer]);
        break;
      }
      case "export_mesh": {
        const meshes = exportMeshes(oc!, session!.state!, req.bodies);
        post({ type: "exported_mesh", seq: req.seq, meshes }, meshes.flatMap((m) => [m.positions.buffer, m.normals.buffer, m.indices.buffer]));
        break;
      }
      case "configure":
        session!.meshCoarse = req.meshCoarse;
        post({ type: "configured", seq: req.seq });
        break;
      case "props":
        post({ type: "props", seq: req.seq, bodies: session!.bodyProps() });
        break;
      case "clearance":
        post({ type: "clearances", seq: req.seq, result: clearances(oc!, session!.state!, req.moving, req.poses, req.within) });
        break;
      case "drawing": {
        if (!req.doc) {
          post({ type: "drawn", seq: req.seq, views: drawingViews(oc!, session!.state!, req.views, req.bodies) });
          break;
        }
        const sandbox = new KernelSession(oc!, solver!);
        try {
          sandbox.rebuild(req.doc, { mesh: false, props: false });
          post({ type: "drawn", seq: req.seq, views: drawingViews(oc!, sandbox.state!, req.views, req.bodies) });
        } finally {
          sandbox.dispose();
        }
        break;
      }
      case "measure":
        post({ type: "measured", seq: req.seq, result: measure(oc!, session!.state!, req.a, req.b) });
        break;
    }
  }

  const t0 = performance.now();
  let threads = wasm.occtThreads !== undefined;
  const occt = threads
    ? loadOcct(wasm.occtThreads, true).catch(() => {
        threads = false;
        return loadOcct(wasm.occt);
      })
    : loadOcct(wasm.occt);
  Promise.all([occt, SketchSolver.create(wasm.planegcs)]).then(
    ([loaded, s]) => {
      oc = loaded;
      solver = s;
      session = new KernelSession(loaded, s);
      scope.postMessage({ type: "ready", initMs: performance.now() - t0, threads });
      void pump();
    },
    (err: unknown) => scope.postMessage({ type: "fatal", message: `failed to load geometry kernel: ${String(err)}` }),
  );
}
