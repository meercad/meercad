/**
 * Multigrid (multigrid.ts): the same movements as plain conjugate gradients in far fewer rounds,
 * also for grids with odd numbers of cubes, parts that do not fill their grid and cubes of very
 * different stiffness; a plate one cube thin is solved without a direct coarsest grid; small grids
 * are left to the plain solver; a part that is not held is still told apart.
 */
import { describe, expect, it } from "vitest";
import { nodeCount } from "./grid.js";
import { multigrid, solveFem } from "./multigrid.js";
import { cellForce, Stiffness } from "./solve.js";
import { boxGrid } from "./testParts.js";

function beam(size: [number, number, number]) {
  const { grid, faceCells, faceNodes } = boxGrid(size);

  return {
    grid,
    young: 3300,
    poisson: 0.35,
    fixed: faceNodes[0]!,
    force: cellForce(grid, faceCells[1]!, [0, 0, -5]),
  };
}

const largest = (values: Float64Array) => values.reduce((max, value) => Math.max(max, Math.abs(value)), 0);

describe("multigrid", () => {
  it("finds the same movements as the plain solver in far fewer rounds", () => {
    const problem = beam([25, 9, 7]);
    const plain = new Stiffness(problem).solve(problem.force);
    const fast = solveFem(problem);

    expect(fast.converged).toBe(true);
    expect(fast.iterations).toBeLessThan(plain.iterations / 4);
    fast.displacement.forEach((value, i) => expect(value).toBeCloseTo(plain.displacement[i]!, 5));
  });

  it("copes with holes in the grid and with cubes a thousand times softer", () => {
    const problem = beam([24, 8, 8]);
    // A window through the beam, and a soft layer along it.
    const solid = Uint8Array.from(problem.grid.solid, (_, cell) =>
      cell % 24 > 8 && cell % 24 < 14 && Math.floor(cell / 192) > 2 && Math.floor(cell / 192) < 5 ? 0 : 1,
    );
    const stiffness = Float32Array.from(solid, (_, cell) => (Math.floor(cell / 24) % 8 === 3 ? 1e-3 : 1));
    const holed = { ...problem, grid: { ...problem.grid, solid }, stiffness };
    const plain = new Stiffness(holed).solve(holed.force, { tolerance: 1e-8, maxIterations: 20000 });
    const fast = solveFem(holed, { tolerance: 1e-8 });

    expect(fast.converged).toBe(true);
    expect(fast.iterations).toBeLessThan(plain.iterations);
    expect(largest(fast.displacement) / largest(plain.displacement)).toBeCloseTo(1, 4);
  });

  it("solves a plate one cube thin, whose coarsest grid is too large to solve directly", () => {
    const problem = beam([40, 1, 20]);
    const plain = new Stiffness(problem).solve(problem.force);
    const fast = solveFem(problem);

    expect(fast.converged).toBe(true);
    expect(largest(fast.displacement) / largest(plain.displacement)).toBeCloseTo(1, 4);
  });

  it("leaves a small grid to the plain solver, and takes a start", () => {
    const small = beam([4, 2, 2]);

    expect(multigrid(small)).toBeNull();
    expect(solveFem(small).converged).toBe(true);

    const problem = beam([25, 9, 7]);
    const first = solveFem(problem);

    expect(solveFem(problem, { start: first.displacement }).iterations).toBeLessThan(2);
  });

  it("still tells a part that is not held, and guesses nothing where nothing can move", () => {
    const problem = beam([16, 8, 8]);

    expect(solveFem({ ...problem, fixed: [] }, { maxIterations: 60 }).converged).toBe(false);

    const all = Array.from({ length: nodeCount(problem.grid) }, (_, node) => node);
    const guess = new Float64Array(nodeCount(problem.grid) * 3).fill(7);

    multigrid({ ...problem, fixed: all })!(Float64Array.from(problem.force), guess);
    expect(largest(guess)).toBe(0);
  });
});
