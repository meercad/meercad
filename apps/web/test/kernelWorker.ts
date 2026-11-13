/**
 * Stands in for `./kernel.worker.ts?worker` in the app's tests (vitest project "web"): the real
 * kernel worker (startKernelWorker) in this process, with messages copied both ways as a Worker
 * copies them, so the store rebuilds designs exactly as in the app.
 */
import { startKernelWorker } from "@meercad/kernel/worker";
import type { WorkerRequest, WorkerResponse } from "@meercad/kernel";

type Listener = (event: MessageEvent<WorkerResponse>) => void;

export default class TestKernelWorker {
  static started = 0;
  readonly name: string;
  terminated = false;
  private readonly listeners = new Set<Listener>();
  private inbox: ((event: MessageEvent<WorkerRequest>) => void) | null = null;

  constructor(opts: { name?: string } = {}) {
    this.name = opts.name ?? "kernel";
    TestKernelWorker.started++;
    startKernelWorker({
      postMessage: (msg) => {
        if (this.terminated) return;

        const copy = structuredClone(msg);
        setTimeout(() => {
          if (!this.terminated) {
            for (const listener of this.listeners) listener({ data: copy } as MessageEvent<WorkerResponse>);
          }
        });
      },
      addEventListener: (_type, fn) => (this.inbox = fn),
    });
  }

  addEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    if (type === "message") this.listeners.delete(listener);
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
