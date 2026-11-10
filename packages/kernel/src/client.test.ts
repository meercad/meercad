import { describe, expect, it } from "vitest";
import { KernelClient } from "./client.js";
import { crashOf, occtErrorMessage, type OC } from "./occt.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

/** A stand-in worker: `answer` decides the reply to each request. */
class FakeWorker {
  sent: WorkerRequest[] = [];
  terminated = false;
  private fn: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  constructor(private readonly answer: (req: WorkerRequest) => WorkerResponse) {}
  addEventListener(_: "message", fn: (e: MessageEvent<WorkerResponse>) => void) {
    this.fn = fn;
  }
  postMessage(req: WorkerRequest) {
    this.sent.push(req);
    queueMicrotask(() => this.fn?.({ data: this.answer(req) } as MessageEvent<WorkerResponse>));
  }
  terminate() {
    this.terminated = true;
  }
}

const doc = (n: number) => ({ format: "meercad/1", params: {}, features: [], name: `d${n}` }) as never;
const rebuilt = (seq: number): WorkerResponse => ({ type: "rebuilt", seq, report: { bodies: [], features: [] } as never, meshes: [], references: [] });

describe("kernel client", () => {
  it("replaces a broken worker and sends the open request to the new one", async () => {
    const broken = new FakeWorker((req) => ({ type: "crashed", seq: req.seq, message: "memory access out of bounds", threads: true }));
    const fresh = new FakeWorker((req) => rebuilt(req.seq));
    const asked: boolean[] = [];
    const client = new KernelClient(broken as unknown as Worker, (c) => (asked.push(c.threads), fresh as unknown as Worker));
    await client.rebuild(doc(1));
    expect(broken.terminated).toBe(true);
    expect(asked).toEqual([true]);
    expect(fresh.sent.map((r) => r.type)).toEqual(["rebuild"]);
  });

  it("gives the new worker the last model before an export", async () => {
    let crash = false;
    const first = new FakeWorker((req) => (req.type === "rebuild" ? rebuilt(req.seq) : crash ? { type: "crashed", seq: req.seq, message: "null function", threads: true } : rebuilt(req.seq)));
    const fresh = new FakeWorker((req) => (req.type === "rebuild" ? rebuilt(req.seq) : { type: "exported", seq: req.seq, data: new Uint8Array([1]) }));
    const client = new KernelClient(first as unknown as Worker, () => fresh as unknown as Worker);
    await client.rebuild(doc(1));
    crash = true;
    expect(await client.exportStep()).toEqual(new Uint8Array([1]));
    expect(fresh.sent.map((r) => r.type)).toEqual(["rebuild", "export_step"]);
  });

  it("fails a request that breaks the new worker too", async () => {
    const crashing = () => new FakeWorker((req) => ({ type: "crashed", seq: req.seq, message: "memory access out of bounds", threads: false }));
    const client = new KernelClient(crashing() as unknown as Worker, crashing as unknown as () => Worker);
    await expect(client.rebuild(doc(1))).rejects.toThrow("the geometry kernel broke: memory access out of bounds");
  });

  it("puts back the meshes the worker names as kept, and asks for all when it cannot", async () => {
    const mesh = (bodyId: string) => ({ bodyId, positions: new Float32Array(3) }) as never;
    const a = mesh("a");
    const b2 = mesh("b");
    const replies: ((seq: number) => WorkerResponse)[] = [
      (seq) => ({ ...rebuilt(seq), meshes: [a, mesh("b")] } as WorkerResponse),
      (seq) => ({ ...rebuilt(seq), meshes: [{ bodyId: "a", kept: true }, b2] } as WorkerResponse),
      (seq) => ({ ...rebuilt(seq), meshes: [{ bodyId: "x", kept: true }] } as WorkerResponse),
      (seq) => ({ ...rebuilt(seq), meshes: [a] } as WorkerResponse),
    ];
    const worker = new FakeWorker((req) => replies.shift()!(req.seq));
    const client = new KernelClient(worker as unknown as Worker);
    await client.rebuild(doc(1));
    const second = await client.rebuild(doc(2));
    // The same object as before, so the view keeps its geometry.
    expect(second.meshes[0]).toBe(a);
    expect(second.meshes[1]).toBe(b2);
    await expect(client.rebuild(doc(3))).rejects.toThrow("out of step");
    await client.rebuild(doc(4));
    expect(worker.sent.map((r) => r.type === "rebuild" && r.fresh === true)).toEqual([false, false, false, true]);
  });

  it("remembers that OCCT hit a WebAssembly runtime error", () => {
    const oc = {} as OC;
    expect(crashOf(oc)).toBeUndefined();
    expect(occtErrorMessage(oc, new Error("Standard_Failure"))).toBe("Standard_Failure");
    expect(crashOf(oc)).toBeUndefined();
    occtErrorMessage(oc, new WebAssembly.RuntimeError("memory access out of bounds"));
    expect(crashOf(oc)).toBe("memory access out of bounds");
  });

  describe("a fresh kernel before the running one is full", () => {
    const GB = 2 ** 30;
    const mesh = (bodyId: string, x = 1) => ({ bodyId, positions: new Float32Array([x, 2, 3]), indices: new Uint32Array([0]), faceRanges: new Int32Array(0), edgeLines: new Float32Array(0) }) as never;
    const built = (seq: number, kernelMemory: number, meshes: unknown[] = []): WorkerResponse => ({ type: "rebuilt", seq, report: { bodies: [], features: [], kernelMemory } as never, meshes: meshes as never, references: [] });
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it("warms one up in the background and lets it take over between two requests", async () => {
      const memory = [1 * GB, 2 * GB, 3 * GB];
      const a = mesh("a");
      // Each worker sends the mesh with its first rebuild and names it as kept after that.
      const sending = (first: unknown) => {
        let n = 0;
        return () => (n++ ? [{ bodyId: "a", kept: true }] : [first]);
      };
      const fromOld = sending(a), fromFresh = sending(mesh("a"));
      const old = new FakeWorker((req) => built(req.seq, memory.shift()!, fromOld()));
      const fresh = new FakeWorker((req) => (req.type === "rebuild" ? built(req.seq, 1 * GB, fromFresh()) : { type: "exported", seq: req.seq, data: new Uint8Array([7]) }));
      let started = 0;
      const client = new KernelClient(old as unknown as Worker, undefined, { worker: () => (started++, fresh as unknown as Worker) });
      await client.rebuild(doc(1));
      await client.rebuild(doc(2));
      // 2 GB: not far enough yet.
      expect(started).toBe(0);
      const third = await client.rebuild(doc(3));
      await settle();
      expect(started).toBe(1);
      // The fresh kernel was given the design as it is now, asked for every mesh, and has taken over.
      expect(fresh.sent[0]).toMatchObject({ type: "rebuild", fresh: true, doc: { name: "d3" } });
      expect(old.terminated).toBe(true);
      expect(await client.exportStep()).toEqual(new Uint8Array([7]));
      // A mesh that came out the same stays the object the page already has.
      const next = await client.rebuild(doc(4));
      expect(next.meshes[0]).toBe(third.meshes[0]);
      expect(third.meshes[0]).toBe(a);
    });

    it("starts over in a fresh kernel when asked and the running one holds too much (iPad)", async () => {
      const old = new FakeWorker((req) => built(req.seq, 1.5 * GB));
      const fresh = new FakeWorker((req) => (req.type === "rebuild" ? built(req.seq, 0.2 * GB) : { type: "configured", seq: req.seq }));
      const client = new KernelClient(old as unknown as Worker);
      await client.configure(2);
      const make = () => fresh as unknown as Worker;
      // Nothing built yet: nothing to give back.
      expect(client.restartIfAbove(GB, make)).toBe(false);
      await client.rebuild(doc(1));
      expect(client.restartIfAbove(2 * GB, make)).toBe(false);
      expect(client.restartIfAbove(GB, make)).toBe(true);
      expect(old.terminated).toBe(true);
      // The fresh kernel meshes as the old one did, builds the next design from scratch and is small again.
      expect(fresh.sent[0]).toMatchObject({ type: "configure", meshCoarse: 2 });
      await client.rebuild(doc(2));
      expect(fresh.sent[1]).toMatchObject({ type: "rebuild", doc: { name: "d2" } });
      expect(client.restartIfAbove(GB, make)).toBe(false);
    });

    it("gives the fresh kernel a change made while it warmed up before it takes over", async () => {
      const old = new FakeWorker((req) => built(req.seq, 3 * GB));
      let release: (() => void) | null = null;
      const fresh = new (class extends FakeWorker {
        held = false;
        override postMessage(req: WorkerRequest) {
          // The first build takes a while: it answers only once released.
          if (this.held) return super.postMessage(req);
          this.held = true;
          release = () => super.postMessage(req);
        }
      })((req) => built(req.seq, 1 * GB));
      const client = new KernelClient(old as unknown as Worker, undefined, { worker: () => fresh as unknown as Worker, grown: 0 });
      await client.rebuild(doc(1));
      await settle();
      expect(release).not.toBeNull();
      // Work goes on in the running kernel meanwhile.
      await client.rebuild(doc(2));
      expect(old.terminated).toBe(false);
      release!();
      await settle();
      // It built design 1, the design is 2 by now: it builds that too, then takes over.
      expect(fresh.sent.map((r) => (r as unknown as { doc: { name: string } }).doc.name)).toEqual(["d1", "d2"]);
      expect(old.terminated).toBe(true);
    });

    it("starts a kernel of the same kind when the running one broke nearly full", async () => {
      let crash = false;
      const old = new FakeWorker((req) => (crash ? { type: "crashed", seq: req.seq, message: "Aborted()", threads: true } : built(req.seq, 3.5 * GB)));
      const kinds: string[] = [];
      // No room to warm one up in time (`above` out of reach): the kernel breaks first.
      const client = new KernelClient(old as unknown as Worker, () => (kinds.push("single"), new FakeWorker((req) => built(req.seq, GB)) as unknown as Worker), { worker: () => (kinds.push("same"), new FakeWorker((req) => built(req.seq, GB)) as unknown as Worker), above: 5 * GB });
      await client.rebuild(doc(1));
      crash = true;
      await client.rebuild(doc(2));
      expect(kinds).toEqual(["same"]);
    });
  });
});
