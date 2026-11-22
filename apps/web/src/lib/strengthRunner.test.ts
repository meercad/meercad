/**
 * Running a strength request (strengthRunner.ts): in a worker where there are workers (progress
 * passed on, the worker ended with the answer, on a failure or on cancel), in place where not.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StrengthRequest } from "@meercad/model";
import { runStrength } from "./strengthRunner";

const request = { kind: "check", job: { holds: [] } } as unknown as StrengthRequest;

class FakeWorker {
  static last: FakeWorker;
  onmessage: (event: { data: unknown }) => void = () => undefined;
  onerror: () => void = () => undefined;
  posted: unknown[] = [];
  ended = false;

  constructor() {
    FakeWorker.last = this;
  }

  postMessage(message: unknown) {
    this.posted.push(message);
  }

  terminate() {
    this.ended = true;
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("without workers", () => {
  it("answers in place", async () => {
    vi.stubGlobal("Worker", undefined);

    const run = runStrength(request, () => undefined);

    run.cancel();
    expect(await run.answer).toEqual({ kind: "error", reason: "failed" });
  });
});

describe("in a worker", () => {
  it("passes the progress on and ends the worker with the answer", async () => {
    vi.stubGlobal("Worker", FakeWorker);

    const progress: number[] = [];
    const run = runStrength(request, (share) => progress.push(share));
    const worker = FakeWorker.last;

    expect(worker.posted).toEqual([request]);
    worker.onmessage({ data: { kind: "progress", progress: 0.5 } });
    expect(progress).toEqual([0.5]);
    expect(worker.ended).toBe(false);
    worker.onmessage({ data: { kind: "error", reason: "hold" } });
    expect(await run.answer).toEqual({ kind: "error", reason: "hold" });
    expect(worker.ended).toBe(true);
  });

  it("answers failed when the worker breaks, and nothing when cancelled", async () => {
    vi.stubGlobal("Worker", FakeWorker);

    const broken = runStrength(request, () => undefined);

    FakeWorker.last.onerror();
    expect(await broken.answer).toEqual({ kind: "error", reason: "failed" });

    const cancelled = runStrength(request, () => undefined);

    cancelled.cancel();
    expect(await cancelled.answer).toBeNull();
    expect(FakeWorker.last.ended).toBe(true);
  });
});
