/**
 * Helper threads for the strength calculation, started by the worker that calculates: with them the
 * heavy part of the work is shared among several cores (see packages/model/src/fem/shared.ts). They
 * need memory that threads can share, which the Mac app has; where there is none (iPhone and iPad),
 * the calculation runs on one core as before.
 */
import { SharedWork, sharedWork, useSharedWork } from "@meercad/model";

/** The shared memory: enough for the lists of the finest grid with room to spare. */
const MEMORY_BYTES = 192 * 2 ** 20;
/** Two cores are left for the app itself and the kernel; more than eight helpers gain little. */
const CORES_LEFT = 2;
const MOST_HELPERS = 8;

/** Starts the helpers this device allows; returns how many. */
export function startHelpers(): number {
  const scope = globalThis as { crossOriginIsolated?: boolean };
  const count = Math.min(MOST_HELPERS, (navigator.hardwareConcurrency || 1) - CORES_LEFT);

  if (!scope.crossOriginIsolated || typeof SharedArrayBuffer === "undefined" || count < 1) return 0;

  let work: SharedWork;

  try {
    work = new SharedWork(MEMORY_BYTES);
  } catch {
    // no room for the shared memory: one core it is
    return 0;
  }

  for (let helper = 0; helper < count; helper++) {
    new Worker(new URL("../strengthHelper.worker.ts", import.meta.url), { type: "module" }).postMessage({
      memory: work.memory,
      helper,
    });
  }

  useSharedWork(work);

  return count;
}

/** How long the calculation waits for its helpers to start, ms: they load while their starter is idle. */
const START_MS = 3000;

/**
 * Waits until the helpers started are ready (or it has taken too long: then the calculation goes
 * with those that are). A helper only starts while the thread that started it is not busy, so the
 * calculation must not begin before.
 */
export async function helpersReady(started: number, wait = START_MS): Promise<number> {
  const until = Date.now() + wait;

  while ((sharedWork()?.helpers ?? 0) < started && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  return sharedWork()?.helpers ?? 0;
}
