/**
 * The strength worker (strength.worker.ts): a request comes back answered, with the progress of a
 * topology suggestion in between.
 */
import { STRENGTHS, type StrengthRequest } from "@meercad/model";
import { expect, it, vi } from "vitest";

it("answers a request and reports the progress", async () => {
  const posted: { kind: string }[] = [];

  vi.stubGlobal("self", { postMessage: (message: { kind: string }) => posted.push(message) });
  await import("./strength.worker");

  const worker = self as unknown as { onmessage(event: { data: StrengthRequest }): Promise<void> };
  // A 2 × 1 × 1 box held at one end and pulled at the other.
  const positions = [0, 0, 0, 2, 0, 0, 0, 1, 0, 2, 1, 0, 0, 0, 1, 2, 0, 1, 0, 1, 1, 2, 1, 1];
  const quads = [
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
  const job = {
    positions,
    indices,
    holds: indices.slice(0, 6),
    loads: [{ triangles: indices.slice(6, 12), force: [10, 0, 0] as [number, number, number] }],
    material: STRENGTHS.pla!,
    up: [0, 0, 1] as [number, number, number],
    cells: 2,
  };

  await worker.onmessage({ data: { kind: "check", job: { ...job, holds: [] } } });
  expect(posted).toEqual([{ kind: "error", reason: "hold" }]);

  await worker.onmessage({ data: { kind: "topology", job: { ...job, share: 0.5, steps: 1 } } });
  expect(posted.map((message) => message.kind)).toEqual(["error", "progress", "topology"]);
  vi.unstubAllGlobals();
});
