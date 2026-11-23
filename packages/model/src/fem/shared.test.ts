/**
 * Several threads for the strength calculation (shared.ts), with the helper threads played by
 * this one: a stiffness applied by the lead and two helpers together gives the same forces as
 * applied alone, and the same solution; a helper that is not ready or sees no new job does
 * nothing; when the shared memory is full the calculation goes on alone with ordinary lists.
 */
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { solveFem } from "./multigrid.js";
import { floats, helperLoop, helperTurn, SharedWork, sharedWork, useSharedWork } from "./shared.js";
import { cellForce, Stiffness } from "./solve.js";
import { boxGrid } from "./testParts.js";

const { grid, faceCells, faceNodes } = boxGrid([20, 16, 16]);
const problem = {
  grid,
  young: 3300,
  poisson: 0.35,
  fixed: faceNodes[0]!,
  force: cellForce(grid, faceCells[1]!, [0, 0, -5]),
};

/** Shared memory with helpers 0 and 2 ready, both played by this thread whenever the lead waits. */
function withHelpers(bytes = 32 * 2 ** 20): { work: SharedWork; turns: () => number } {
  const seen = [0, 0];
  let turns = 0;
  const work: SharedWork = new SharedWork(bytes, () => {
    turns++;
    seen[0] = helperTurn(work.memory, 0, seen[0]!);
    seen[1] = helperTurn(work.memory, 2, seen[1]!);
  });

  // Told to stop before they start, the helpers only say they are ready.
  work.stop();
  helperLoop(work.memory, 0);
  helperLoop(work.memory, 2);

  return { work, turns: () => turns };
}

afterEach(() => useSharedWork(null));

describe("applying a stiffness with helpers", () => {
  it("gives the same forces as alone", () => {
    const alone = new Stiffness(problem);
    const moved = Float64Array.from({ length: alone.free.length }, (_, i) => Math.sin(i));
    const expected = alone.apply(moved, new Float64Array(moved.length));
    const { work, turns } = withHelpers();

    useSharedWork(work);
    expect(sharedWork()).toBe(work);
    expect(work.helpers).toBe(2);

    const together = new Stiffness(problem);
    const input = floats(moved.length);

    input.set(moved);

    const forces = together.apply(input, floats(moved.length));

    // Four parts: rows with even and odd y and z.
    expect(turns()).toBeGreaterThanOrEqual(4);
    forces.forEach((force, i) => expect(force).toBeCloseTo(expected[i]!, 6));
    // Lists outside the shared memory are worked on by the lead alone.
    together
      .apply(moved, new Float64Array(moved.length))
      .forEach((force, i) => expect(force).toBeCloseTo(expected[i]!, 6));
  });

  it("gives the same solution as alone, and takes the memory again for the next one", () => {
    const expected = solveFem(problem);
    const { work } = withHelpers();

    useSharedWork(work);

    const first = solveFem(problem);
    const second = solveFem(problem);

    expect(first.iterations).toBe(expected.iterations);
    expect(first.displacement.buffer).not.toBe(work.memory);
    second.displacement.forEach((moved, i) => expect(moved).toBeCloseTo(expected.displacement[i]!, 9));
  });

  it("goes on alone with ordinary lists when the shared memory is full", () => {
    const { work } = withHelpers(4096);

    useSharedWork(work);
    expect(work.holds(floats(1000))).toBe(false);
    expect(work.holds(work.integers(1000))).toBe(false);
    expect(work.holds(work.integers(10))).toBe(true);
    expect(solveFem(problem).converged).toBe(true);
    work.reset();
    expect(work.holds(floats(100))).toBe(true);
  });
});

describe("a helper that has gone", () => {
  it("is not waited for for ever", () => {
    // Helper 0 said it was ready and never works: every wait runs out.
    const work = new SharedWork(2 ** 20, () => "timed-out");

    work.stop();
    helperLoop(work.memory, 0);
    useSharedWork(work);

    const system = new Stiffness(problem);

    expect(() => system.apply(floats(system.free.length), floats(system.free.length))).toThrow(
      /does not answer/,
    );
  });
});

describe("a helper", () => {
  it("does nothing without a new job, and nothing in a job it is not part of", () => {
    const { work } = withHelpers();

    expect(helperTurn(work.memory, 0, 0)).toBe(0);
    useSharedWork(work);

    const system = new Stiffness(problem);
    const input = floats(system.free.length).fill(1);
    const output = floats(system.free.length);

    system.apply(input, output);

    const after = Float64Array.from(output);

    // Helper 5 never said it was ready: the last job is not its business, but it has seen it.
    expect(helperTurn(work.memory, 5, 0)).toBeGreaterThan(0);
    expect(Array.from(output)).toEqual(Array.from(after));
  });
});

describe("with a real second thread", () => {
  /**
   * A thread that keeps writing `value` to one of the numbers at the start of the memory, from a moment later
   * on.
   */
  const later = (memory: SharedArrayBuffer, place: number, value: number) =>
    new Worker(
      `const { workerData } = require("node:worker_threads");
       const control = new Int32Array(workerData.memory, 0, 64);
       setInterval(() => { Atomics.store(control, workerData.place, workerData.value); Atomics.notify(control, 0); Atomics.notify(control, 1); }, 15);`,
      { eval: true, workerData: { memory, place, value } },
    );

  it("a helper sleeps until it is told to stop", async () => {
    const work = new SharedWork(4096);
    const stopper = later(work.memory, 2, 1);

    helperLoop(work.memory, 1);
    expect(work.helpers).toBe(1);
    await stopper.terminate();
  });

  it("the lead sleeps until every helper has reported", async () => {
    const work = new SharedWork(2 ** 20);

    // Helper 0 is ready (and stopped at once); its reports, one for each part of the job, come from the other
    // thread.
    work.stop();
    helperLoop(work.memory, 0);
    useSharedWork(work);

    const system = new Stiffness(problem);
    const reporter = later(work.memory, 1, 1);
    const started = Date.now();

    work.apply(
      floats(576),
      work.integers(8),
      floats(1),
      work.integers(2),
      1,
      1,
      work.ready,
      floats(system.free.length),
      floats(system.free.length),
    );
    expect(Date.now() - started).toBeGreaterThan(20);
    await reporter.terminate();
  });
});
