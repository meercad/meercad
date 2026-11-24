/**
 * Starting the helper threads (strengthThreads.ts): as many as the cores allow with two left over,
 * eight at most, each given the shared memory and its number; none where memory cannot be shared,
 * where there are too few cores, or where the memory cannot be had.
 */
import { helperLoop, sharedWork, useSharedWork } from "@meercad/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import { helpersReady, startHelpers } from "./strengthThreads";

const started: { memory: SharedArrayBuffer; helper: number }[] = [];

class FakeWorker {
  postMessage(message: { memory: SharedArrayBuffer; helper: number }) {
    started.push(message);
  }
}

function device(cores: number, isolated = true) {
  vi.stubGlobal("Worker", FakeWorker);
  vi.stubGlobal("crossOriginIsolated", isolated);
  vi.stubGlobal("navigator", { hardwareConcurrency: cores });
}

afterEach(() => {
  vi.unstubAllGlobals();
  useSharedWork(null);
  started.length = 0;
});

describe("helper threads", () => {
  it("are started with two cores left over, each with the shared memory and its number", () => {
    device(6);
    expect(startHelpers()).toBe(4);
    expect(started.map((message) => message.helper)).toEqual([0, 1, 2, 3]);
    expect(started.every((message) => message.memory === sharedWork()!.memory)).toBe(true);
  });

  it("are eight at most", () => {
    device(24);
    expect(startHelpers()).toBe(8);
  });

  it("are none where memory cannot be shared or cores are few", () => {
    device(8, false);
    expect(startHelpers()).toBe(0);
    device(2);
    expect(startHelpers()).toBe(0);
    vi.stubGlobal("navigator", {});
    expect(startHelpers()).toBe(0);
    expect(sharedWork()).toBeNull();
    expect(started).toEqual([]);
  });

  it("are none when the shared memory cannot be had", () => {
    device(8);
    vi.stubGlobal(
      "SharedArrayBuffer",
      class {
        constructor() {
          throw new RangeError("out of memory");
        }
      },
    );
    expect(startHelpers()).toBe(0);
    vi.stubGlobal("SharedArrayBuffer", undefined);
    expect(startHelpers()).toBe(0);
  });
});

describe("waiting for the helpers", () => {
  it("ends as soon as all are ready, or when it has taken too long", async () => {
    device(4);
    expect(startHelpers()).toBe(2);

    const work = sharedWork()!;

    // One helper reports (told to stop, it does nothing else); the other never does.
    work.stop();
    setTimeout(() => helperLoop(work.memory, 0), 30);
    expect(await helpersReady(1)).toBe(1);
    expect(await helpersReady(2, 60)).toBe(1);
  });

  it("is over at once without shared work", async () => {
    expect(await helpersReady(0)).toBe(0);
    expect(await helpersReady(3, 10)).toBe(0);
  });
});
