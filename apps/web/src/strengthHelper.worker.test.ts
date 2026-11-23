/**
 * A helper thread of the strength calculation (strengthHelper.worker.ts): given the shared memory
 * it says it is ready, and goes home when told to stop.
 */
import { SharedWork } from "@meercad/model";
import { expect, it, vi } from "vitest";

it("joins the shared work it is given", async () => {
  vi.stubGlobal("self", {});
  await import("./strengthHelper.worker");

  const work = new SharedWork(4096);

  // Told to stop beforehand, it only reports ready.
  work.stop();
  (self as unknown as { onmessage(event: { data: unknown }): void }).onmessage({
    data: { memory: work.memory, helper: 3 },
  });
  expect(work.helpers).toBe(1);
  vi.unstubAllGlobals();
});
