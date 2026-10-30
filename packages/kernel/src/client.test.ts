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

  it("remembers that OCCT hit a WebAssembly runtime error", () => {
    const oc = {} as OC;
    expect(crashOf(oc)).toBeUndefined();
    expect(occtErrorMessage(oc, new Error("Standard_Failure"))).toBe("Standard_Failure");
    expect(crashOf(oc)).toBeUndefined();
    occtErrorMessage(oc, new WebAssembly.RuntimeError("memory access out of bounds"));
    expect(crashOf(oc)).toBe("memory access out of bounds");
  });
});
