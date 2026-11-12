/**
 * The kernel worker (worker.ts) driven through a stand-in for the Web Worker scope: every request
 * the app sends gets its answer, newer rebuilds replace queued ones, and a kernel that cannot
 * load or breaks says so.
 */
import { describe, expect, it, vi } from "vitest";
import { KernelSession, type WorkerRequest, type WorkerResponse } from "@meercad/kernel";
import { startKernelWorker } from "@meercad/kernel/worker";
import type { Feature } from "@meercad/schema";
import { doc, rect, sketch } from "./helpers.js";

const box = (w: number): Feature[] => [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, w, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const two = (w: number): Feature[] => [
  ...box(w),
  sketch("sk2", { ref: "origin.XY" }, rect("m", 100, 0, 10, 10)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 5, mode: "new_body" },
];

/** A worker with a scope that collects what it posts; `send` waits for the answer to `seq`. */
function worker(wasm?: Parameters<typeof startKernelWorker>[1]) {
  const out: WorkerResponse[] = [];
  const waiting: { test: (m: WorkerResponse) => boolean; done: (m: WorkerResponse) => void }[] = [];
  let listener: ((e: MessageEvent<WorkerRequest>) => void) | null = null;
  startKernelWorker(
    {
      postMessage(msg) {
        out.push(msg);
        for (const w of [...waiting]) if (w.test(msg)) waiting.splice(waiting.indexOf(w), 1), w.done(msg);
      },
      addEventListener(_type, fn) {
        listener = fn;
      },
    },
    wasm,
  );
  const until = (test: (m: WorkerResponse) => boolean) => {
    const hit = out.find(test);
    return hit ? Promise.resolve(hit) : new Promise<WorkerResponse>((done) => waiting.push({ test, done }));
  };
  const post = (req: WorkerRequest) => listener!({ data: req } as MessageEvent<WorkerRequest>);
  const send = (req: WorkerRequest) => (post(req), until((m) => "seq" in m && m.seq === req.seq && m.type !== "progress"));
  return { out, until, post, send };
}

describe("kernel worker", () => {
  it("answers every kind of request", async () => {
    const w = worker({ reserve: 256 * 2 ** 20 });
    // Sent before the kernel is loaded: handled once it is.
    const first = (await w.send({ type: "rebuild", seq: 1, doc: doc(two(40)) })) as Extract<WorkerResponse, { type: "rebuilt" }>;
    const ready = w.out.find((m) => m.type === "ready") as Extract<WorkerResponse, { type: "ready" }>;
    expect(ready.threads).toBe(false);
    expect(first.report.bodies.map((b) => Math.round(b.volume))).toEqual([8000, 500]);
    expect(first.report.timing!.post).toBeGreaterThanOrEqual(first.report.timing!.start!);
    expect(first.report.kernelMemory).toBeGreaterThanOrEqual(256 * 2 ** 20);
    expect(w.out.filter((m) => m.type === "progress" && m.seq === 1).length).toBeGreaterThan(0);

    // The second part did not change: its mesh is not sent again, unless asked for afresh.
    const second = (await w.send({ type: "rebuild", seq: 2, doc: doc(two(50)) })) as Extract<WorkerResponse, { type: "rebuilt" }>;
    expect(second.meshes.map((m) => "kept" in m)).toEqual([false, true]);
    const fresh = (await w.send({ type: "rebuild", seq: 3, doc: doc(two(50)), fresh: true, props: false, mesh: true, draft: true, textures: false })) as Extract<WorkerResponse, { type: "rebuilt" }>;
    expect(fresh.meshes.map((m) => "kept" in m)).toEqual([false, false]);

    const props = (await w.send({ type: "props", seq: 4 })) as Extract<WorkerResponse, { type: "props" }>;
    expect(props.bodies.map((b) => Math.round(b.volume))).toEqual([10000, 500]);

    const step = (await w.send({ type: "export_step", seq: 5, bodies: ["ex1"] })) as Extract<WorkerResponse, { type: "exported" }>;
    expect(new TextDecoder().decode(step.data.slice(0, 9))).toBe("ISO-10303");
    const mesh = (await w.send({ type: "export_mesh", seq: 6, bodies: ["ex2"] })) as Extract<WorkerResponse, { type: "exported_mesh" }>;
    expect(mesh.meshes.map((m) => m.bodyId)).toEqual(["ex2"]);

    expect((await w.send({ type: "configure", seq: 7, meshCoarse: 2 })).type).toBe("configured");

    const top = fresh.meshes[0] as Extract<(typeof fresh.meshes)[number], { faceTags: string[][] }>;
    const index = top.faceTags.findIndex((t) => t.includes("ex1.end_cap"));
    const measured = (await w.send({ type: "measure", seq: 8, a: { bodyId: "ex1", kind: "face", index } })) as Extract<WorkerResponse, { type: "measured" }>;
    expect(measured.result.rows.find((r) => r[0] === "Area")?.[1]).toMatch(/^1000(\.0+)? mm²/);

    const clear = (await w.send({ type: "clearance", seq: 9, moving: ["ex2"], poses: {}, within: 100, box: { min: [-1, -1, -1], max: [200, 200, 200] }, budgetMs: 5000 })) as Extract<WorkerResponse, { type: "clearances" }>;
    expect(clear.type).toBe("clearances");
    const clear2 = (await w.send({ type: "clearance", seq: 10, moving: ["ex2"], poses: {} })) as Extract<WorkerResponse, { type: "clearances" }>;
    expect(clear2.type).toBe("clearances");

    const drawn = (await w.send({ type: "drawing", seq: 11, views: ["top"] })) as Extract<WorkerResponse, { type: "drawn" }>;
    expect(drawn.views).toHaveLength(1);
    const other = (await w.send({ type: "drawing", seq: 12, views: ["front"], doc: doc(box(30)) })) as Extract<WorkerResponse, { type: "drawn" }>;
    expect(other.views).toHaveLength(1);

    const sandbox = (await w.send({ type: "sandbox", seq: 13, doc: doc(two(60)) })) as Extract<WorkerResponse, { type: "rebuilt" }>;
    expect(sandbox.report.bodies.map((b) => Math.round(b.volume))).toEqual([12000, 500]);

    // A request that cannot be answered says why; the worker carries on.
    const failed = (await w.send({ type: "measure", seq: 14, a: { bodyId: "zz", kind: "face", index: 0 } })) as Extract<WorkerResponse, { type: "failed" }>;
    expect(failed.type).toBe("failed");
    expect(failed.message.length).toBeGreaterThan(0);
    expect((await w.send({ type: "props", seq: 15 })).type).toBe("props");
  });

  it("drops a queued rebuild when a newer one comes", async () => {
    const w = worker();
    await w.until((m) => m.type === "ready");
    w.post({ type: "rebuild", seq: 1, doc: doc(box(10)) });
    w.post({ type: "rebuild", seq: 2, doc: doc(box(20)) });
    w.post({ type: "sandbox", seq: 3, doc: doc(box(20)) });
    w.post({ type: "rebuild", seq: 4, doc: doc(box(30)) });
    const last = (await w.until((m) => m.type === "rebuilt" && m.seq === 4)) as Extract<WorkerResponse, { type: "rebuilt" }>;
    expect(last.report.bodies[0]!.volume).toBeCloseTo(6000, 6);
    expect(w.out.filter((m) => m.type === "failed").map((m) => [m.seq, (m as { message: string }).message])).toEqual([
      [1, "superseded"],
      [2, "superseded"],
    ]);
    expect(w.out.some((m) => m.type === "rebuilt" && m.seq === 3)).toBe(true);
  });

  it("stops after OCCT broke and tells the page to start a new worker", async () => {
    const w = worker();
    await w.until((m) => m.type === "ready");
    const spy = vi.spyOn(KernelSession.prototype, "rebuild").mockImplementationOnce(() => {
      throw new WebAssembly.RuntimeError("memory access out of bounds");
    });
    try {
      const crashed = await w.send({ type: "rebuild", seq: 1, doc: doc(box(10)) });
      expect(crashed).toEqual({ type: "crashed", seq: 1, message: "memory access out of bounds", threads: false });
    } finally {
      spy.mockRestore();
    }
    // Nothing more is handled.
    w.post({ type: "props", seq: 2 });
    await new Promise((r) => setTimeout(r, 50));
    expect(w.out.some((m) => "seq" in m && m.seq === 2)).toBe(false);
  });

  it("falls back to the single-threaded kernel when the threaded one does not start", async () => {
    const w = worker({ occtThreads: "/nonexistent/replicad_multi.wasm" });
    const ready = (await w.until((m) => m.type === "ready" || m.type === "fatal")) as Extract<WorkerResponse, { type: "ready" }>;
    expect(ready).toMatchObject({ type: "ready", threads: false });
  });

  it("reports a kernel that cannot be loaded", async () => {
    const w = worker({ planegcs: "/nonexistent/planegcs.wasm" });
    const fatal = (await w.until((m) => m.type === "ready" || m.type === "fatal")) as Extract<WorkerResponse, { type: "fatal" }>;
    expect(fatal.type).toBe("fatal");
    expect(fatal.message).toMatch(/^failed to load geometry kernel: /);
  });
});
