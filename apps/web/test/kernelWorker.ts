/**
 * Stands in for `./kernel.worker.ts?worker` in the app's tests (vitest project "web"): the real
 * kernel worker (startKernelWorker) in this process, with messages copied both ways as a Worker
 * copies them, so the store rebuilds designs exactly as in the app.
 */
import { startKernelWorker } from "@meercad/kernel/worker";
import type { WorkerRequest, WorkerResponse } from "@meercad/kernel";

type Listener = (e: MessageEvent<WorkerResponse>) => void;

export default class TestKernelWorker {
  static started = 0;
  readonly name: string;
  terminated = false;
  private readonly listeners = new Set<Listener>();
  private inbox: ((e: MessageEvent<WorkerRequest>) => void) | null = null;

  constructor(opts: { name?: string } = {}) {
    this.name = opts.name ?? "kernel";
    TestKernelWorker.started++;
    startKernelWorker({
      postMessage: (msg) => {
        if (this.terminated) return;
        const copy = structuredClone(msg);
        setTimeout(() => {
          if (!this.terminated) for (const l of this.listeners) l({ data: copy } as MessageEvent<WorkerResponse>);
        });
      },
      addEventListener: (_type, fn) => (this.inbox = fn),
    });
  }

  addEventListener(type: string, fn: Listener): void {
    if (type === "message") this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    if (type === "message") this.listeners.delete(fn);
  }

  postMessage(msg: WorkerRequest): void {
    if (this.terminated) return;
    const copy = structuredClone(msg);
    setTimeout(() => this.inbox?.({ data: copy } as MessageEvent<WorkerRequest>));
  }

  terminate(): void {
    this.terminated = true;
  }
}
