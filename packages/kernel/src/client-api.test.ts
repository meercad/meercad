/**
 * The kernel client's requests and answers one by one: every call gets its answer, a wrong answer
 * is refused, a fatal or broken worker fails the open requests, progress reaches the caller, and
 * the design sent leaves out what the worker does not need.
 */
import { describe, expect, it } from "vitest";
import { KernelClient, SupersededError } from "./client.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

class FakeWorker {
  sent: WorkerRequest[] = [];
  terminated = false;
  private fn: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  constructor(private readonly answer: (req: WorkerRequest) => WorkerResponse | WorkerResponse[] | null) {}
  addEventListener(_: "message", fn: (e: MessageEvent<WorkerResponse>) => void) {
    this.fn = fn;
  }
  postMessage(req: WorkerRequest) {
    this.sent.push(req);
    const a = this.answer(req);
    for (const m of a === null ? [] : Array.isArray(a) ? a : [a]) queueMicrotask(() => this.fn?.({ data: m } as MessageEvent<WorkerResponse>));
  }
  say(m: WorkerResponse) {
    this.fn?.({ data: m } as MessageEvent<WorkerResponse>);
  }
  terminate() {
    this.terminated = true;
  }
}
const W = (w: FakeWorker) => w as unknown as Worker;
const doc = (extra: object = {}) => ({ format: "meercad/1", params: {}, features: [], rollback: null, ...extra }) as never;
const built = (seq: number): WorkerResponse => ({ type: "rebuilt", seq, report: { bodies: [], features: [] } as never, meshes: [], references: [] });

describe("kernel client calls", () => {
  it("each call returns its own answer", async () => {
    const w = new FakeWorker((req) => {
      switch (req.type) {
        case "sandbox": return built(req.seq);
        case "props": return { type: "props", seq: req.seq, bodies: [{ id: "b", volume: 8 }] as never };
        case "export_step": return { type: "exported", seq: req.seq, data: new Uint8Array([1, 2]) };
        case "export_mesh": return { type: "exported_mesh", seq: req.seq, meshes: [{ bodyId: "b" }] as never };
        case "clearance": return { type: "clearances", seq: req.seq, result: [{ a: "x", b: "y", distance: 1, overlap: 0 }] as never, left: 3 };
        case "drawing": return { type: "drawn", seq: req.seq, views: [{ name: "front" }] as never };
        case "measure": return { type: "measured", seq: req.seq, result: { rows: [["Distance", "5 mm"]] } as never };
        default: return null;
      }
    });
    const c = new KernelClient(W(w));
    expect((await c.sandbox(doc())).meshes).toEqual([]);
    expect(await c.bodyProps()).toEqual([{ id: "b", volume: 8 }]);
    expect(await c.exportStep(["b"], [{ id: "b", name: "Box" }])).toEqual(new Uint8Array([1, 2]));
    expect(await c.exportMeshes(["b"])).toEqual([{ bodyId: "b" }]);
    expect(await c.overlaps(["x"], { budgetMs: 10 })).toEqual({ pairs: [{ a: "x", b: "y", distance: 1, overlap: 0 }], left: 3 });
    expect(await c.clearances(["x"], {}, 2, ["wire"], { x: 1, y: 1 })).toHaveLength(1);
    expect(await c.drawing(["front"], ["b"], doc())).toEqual([{ name: "front" }]);
    expect((await c.measure({ bodyId: "b", kind: "face", index: 0 }, { bodyId: "b", kind: "face", index: 1 })).rows[0]).toEqual(["Distance", "5 mm"]);
    expect(w.sent.find((r) => r.type === "export_step")).toMatchObject({ bodies: ["b"], parts: [{ id: "b", name: "Box" }] });
    expect(w.sent.find((r) => r.type === "clearance" && "skip" in r)).toMatchObject({ within: 2, skip: ["wire"], rigid: { x: 1, y: 1 } });
  });

  it("refuses an answer of the wrong kind for every call", async () => {
    const w = new FakeWorker((req) => ({ type: "configured", seq: req.seq }) as WorkerResponse);
    const c = new KernelClient(W(w));
    for (const call of [() => c.rebuild(doc()), () => c.sandbox(doc()), () => c.bodyProps(), () => c.exportStep(), () => c.exportMeshes(), () => c.overlaps([]), () => c.clearances([], {}), () => c.drawing([]), () => c.measure({ bodyId: "b", kind: "face", index: 0 })])
      await expect(call()).rejects.toThrow("unexpected response");
  });

  it("passes progress on, reports failures, and tells a superseded rebuild apart", async () => {
    const w = new FakeWorker((req) =>
      req.type === "rebuild" && (req.doc as { n?: number }).n === 1
        ? [{ type: "progress", seq: req.seq, index: 1, total: 2, feature: "ex1" }, built(req.seq)]
        : req.type === "rebuild" && (req.doc as { n?: number }).n === 2
          ? { type: "failed", seq: req.seq, message: "superseded" }
          : { type: "failed", seq: req.seq, message: "boom" },
    );
    const c = new KernelClient(W(w));
    const steps: string[] = [];
    await c.rebuild(doc({ n: 1 }), { onProgress: (p) => steps.push(`${p.index}/${p.total} ${p.feature}`), props: false, draft: true });
    expect(steps).toEqual(["1/2 ex1"]);
    expect(w.sent[0]).toMatchObject({ props: false });
    await expect(c.rebuild(doc({ n: 2 }))).rejects.toBeInstanceOf(SupersededError);
    await expect(c.bodyProps()).rejects.toThrow("boom");
  });

  it("a fatal worker fails startup and every open request", async () => {
    const w = new FakeWorker(() => null);
    const c = new KernelClient(W(w));
    const open = c.bodyProps();
    w.say({ type: "fatal", message: "no WebAssembly" } as WorkerResponse);
    await expect(open).rejects.toThrow("no WebAssembly");
    await expect(c.ready).rejects.toThrow("no WebAssembly");
  });

  it("reports ready with how long it took and whether it runs threads", async () => {
    const w = new FakeWorker(() => null);
    const c = new KernelClient(W(w));
    w.say({ type: "ready", initMs: 120, threads: true } as WorkerResponse);
    expect(await c.ready).toEqual({ initMs: 120, threads: true });
  });

  it("without a way to replace a broken worker, its requests fail", async () => {
    const w = new FakeWorker((req) => ({ type: "crashed", seq: req.seq, message: "out of memory", threads: false }));
    await expect(new KernelClient(W(w)).bodyProps()).rejects.toThrow("out of memory");
  });

  it("sends the design without saved versions, their files and picture textures", async () => {
    const w = new FakeWorker((req) => built(req.seq));
    const c = new KernelClient(W(w));
    await c.rebuild(doc({ versions: [{ name: "v1" }], blobs: { x: "y" }, features: [{ id: "im1", op: "import", texture: { image: "big" } }, { id: "ex1", op: "extrude" }] }));
    const sent = w.sent[0] as unknown as { doc: Record<string, unknown> };
    expect(sent.doc["versions"]).toBeUndefined();
    expect(sent.doc["blobs"]).toBeUndefined();
    expect((sent.doc["features"] as object[])[0]).toEqual({ id: "im1", op: "import" });
    // A plain design goes as it is.
    const plain = doc();
    await c.rebuild(plain);
    expect((w.sent[1] as { doc: unknown }).doc).toBe(plain);
  });

  it("restarting fails what is still open as superseded and stops the old worker", async () => {
    const w = new FakeWorker(() => null);
    const c = new KernelClient(W(w));
    const open = c.bodyProps();
    const next = new FakeWorker((req) => built(req.seq));
    c.restart(W(next));
    await expect(open).rejects.toBeInstanceOf(SupersededError);
    expect(w.terminated).toBe(true);
    await c.rebuild(doc());
    expect(next.sent).toHaveLength(1);
    c.terminate();
    expect(next.terminated).toBe(true);
  });
});
