/**
 * The strength calculation (solve.ts) against answers known from the textbook: a bar pulled along
 * its length stretches by F·L / (E·A) with the stress F / A everywhere; a beam held at one end bends
 * by F·L³ / (3·E·I) at the other; a part that is not held, or held without any force, is told apart.
 */
import { describe, expect, it } from "vitest";
import { nodeCount } from "./grid.js";
import { brickStiffness, cellForce, solveFem, Stiffness, stresses } from "./solve.js";
import { boxGrid } from "./testParts.js";

describe("one cube", () => {
  it("has a symmetric stiffness that resists no movement of the cube as a whole", () => {
    const brick = brickStiffness(0.3);

    for (let row = 0; row < 24; row++) {
      for (let column = 0; column < 24; column++) {
        expect(brick[row * 24 + column]).toBeCloseTo(brick[column * 24 + row]!, 12);
      }

      // All nodes moving the same way along x: no force anywhere.
      expect(
        [0, 3, 6, 9, 12, 15, 18, 21].reduce((sum, column) => sum + brick[row * 24 + column]!, 0),
      ).toBeCloseTo(0, 12);
    }
  });
});

describe("a bar pulled along its length", () => {
  const { grid, faceCells, faceNodes } = boxGrid([2, 2, 10]);
  // Poisson's ratio 0: holding the end does not hinder the bar from getting thinner.
  const problem = {
    grid,
    young: 1000,
    poisson: 0,
    fixed: faceNodes[4]!,
    force: cellForce(grid, faceCells[5]!, [0, 0, 40]),
  };
  const solution = solveFem(problem);

  it("carries the stress F / A everywhere and stretches by F·L / (E·A)", () => {
    const stress = stresses(problem, solution.displacement);

    expect(solution.converged).toBe(true);

    for (let cell = 0; cell < 36; cell++) {
      expect(stress[cell * 6 + 2]).toBeCloseTo(10, 3);
      expect(Math.abs(stress[cell * 6]!) + Math.abs(stress[cell * 6 + 3]!)).toBeLessThan(1e-3);
    }

    // The pull acts in the middle of the last cubes, so 9.5 mm of bar stretch fully.
    const top = solution.displacement[(nodeCount(grid) - 1) * 3 + 2]!;

    expect(top).toBeGreaterThan((40 * 9) / (1000 * 4));
    expect(top).toBeLessThan((40 * 10) / (1000 * 4));
  });

  it("gets there faster from a start that is already close, and adds forces to forces", () => {
    const again = new Stiffness(problem).solve(problem.force, { start: solution.displacement });

    expect(again.iterations).toBeLessThan(3);
    expect(again.converged).toBe(true);

    const twice = cellForce(grid, faceCells[5]!, [0, 0, 40], Float64Array.from(problem.force));

    expect(twice.reduce((sum, value) => sum + value, 0)).toBeCloseTo(80, 9);
  });

  it("ignores cubes without stiffness, and stops when the steps run out", () => {
    const stiffness = new Float32Array(40).fill(1);

    stiffness[39] = 0;

    const system = new Stiffness({ ...problem, stiffness });

    expect(system.cells.length).toBe(39);
    expect(system.free[(nodeCount(grid) - 1) * 3]).toBe(0);
    expect(system.solve(problem.force, { maxIterations: 2 })).toMatchObject({
      iterations: 2,
      converged: false,
    });
  });
});

describe("a beam held at one end", () => {
  it("bends by F·L³ / (3·E·I) at the other", () => {
    const { grid, faceCells, faceNodes } = boxGrid([32, 4, 4]);
    const problem = {
      grid,
      young: 3300,
      poisson: 0.35,
      fixed: faceNodes[0]!,
      force: cellForce(grid, faceCells[1]!, [0, 0, -5]),
    };
    const solution = solveFem(problem);
    const theory = (5 * 31.5 ** 3) / ((3 * 3300 * (4 * 4 ** 3)) / 12);
    const tip = -solution.displacement[(nodeCount(grid) - 1) * 3 + 2]!;

    expect(solution.converged).toBe(true);
    // Coarse cubes are a little too stiff in bending.
    expect(tip / theory).toBeGreaterThan(0.8);
    expect(tip / theory).toBeLessThan(1.05);
  });
});

describe("parts that cannot be calculated", () => {
  const { grid, faceCells, faceNodes } = boxGrid([2, 2, 2]);

  it("without force nothing moves", () => {
    const solution = solveFem({
      grid,
      young: 1,
      poisson: 0.3,
      fixed: faceNodes[4]!,
      force: new Float64Array(81),
    });

    expect(solution).toMatchObject({ iterations: 0, converged: true });
    expect(Math.max(...solution.displacement)).toBe(0);
  });

  it("a part that is not held does not come to rest", () => {
    const solution = solveFem(
      { grid, young: 1, poisson: 0.3, fixed: [], force: cellForce(grid, faceCells[5]!, [0, 0, 1]) },
      { maxIterations: 50 },
    );

    expect(solution.converged).toBe(false);
  });
});
