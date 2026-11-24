/**
 * Topology optimisation (topology.ts): a plate held at one edge and loaded at the other keeps its
 * top and bottom (where bending is carried) and loses the middle; the wanted share of material is
 * kept; kept cubes stay; without force nothing changes; the result is one piece, crumbs dropped.
 */
import { describe, expect, it } from "vitest";
import { solidVolume } from "./grid.js";
import { cellForce } from "./solve.js";
import { boxGrid } from "./testParts.js";
import { optimiseTopology, solidify } from "./topology.js";

describe("a plate held at one edge, loaded at the other", () => {
  const { grid, faceCells, faceNodes } = boxGrid([24, 1, 12]);
  const loaded = faceCells[1]!.filter((cell) => Math.floor(cell / 24) === 5 || Math.floor(cell / 24) === 6);
  const keep = [...faceCells[0]!, ...loaded];
  const problem = {
    grid,
    young: 3300,
    poisson: 0.35,
    fixed: faceNodes[0]!,
    force: cellForce(grid, loaded, [0, 0, -10]),
  };
  const seen: number[] = [];
  const result = optimiseTopology({
    problem,
    keep,
    share: 0.5,
    steps: 25,
    onStep: (step) => void seen.push(step),
  });

  it("keeps the wanted share and the kept cubes, and tells its progress", () => {
    const total = result.density.reduce((sum, value) => sum + value, 0);

    expect(total / 288).toBeCloseTo(0.5, 2);
    for (const cell of keep) expect(result.density[cell]).toBe(1);
    expect(seen).toEqual(Array.from({ length: result.steps }, (_, i) => i + 1));
  });

  it("keeps material at the top and bottom near the hold, where bending is carried, not in the middle of the plate", () => {
    const at = (x: number, z: number) => result.density[x + 24 * z]!;

    expect(at(3, 0)).toBeGreaterThan(0.8);
    expect(at(3, 11)).toBeGreaterThan(0.8);
    expect(at(3, 5)).toBeLessThan(0.3);
  });

  it("is one piece from hold to load once made solid", () => {
    const part = solidify(grid, result.density, keep);

    expect(solidVolume(part) / 288).toBeGreaterThan(0.35);
    expect(solidVolume(part) / 288).toBeLessThan(0.65);
    for (const cell of keep) expect(part.solid[cell]).toBe(1);
  });
});

describe("edge cases", () => {
  const { grid, faceCells, faceNodes } = boxGrid([4, 2, 2]);
  const problem = {
    grid,
    young: 1000,
    poisson: 0.3,
    fixed: faceNodes[0]!,
    force: cellForce(grid, faceCells[1]!, [0, 0, -1]),
  };

  it("stops when told to", () => {
    expect(optimiseTopology({ problem, keep: [], share: 0.5, onStep: () => false }).steps).toBe(1);
  });

  it("leaves the densities even when no force arrives", () => {
    const idle = optimiseTopology({
      problem: { ...problem, force: new Float64Array(problem.force.length) },
      keep: [],
      share: 0.5,
    });

    expect(idle.steps).toBe(1);
    expect(Array.from(idle.density)).toEqual(new Array(16).fill(0.5));
  });

  it("gives the free cubes the least when the kept ones already use up the share", () => {
    const all = optimiseTopology({
      problem,
      keep: [...faceCells[0]!, ...faceCells[1]!],
      share: 0.2,
      steps: 2,
    });

    expect(all.density[1]).toBeCloseTo(1e-3);
    expect(all.density[0]).toBe(1);
  });

  it("drops crumbs that do not hang on a kept cube, and cubes outside the part", () => {
    const density = new Float32Array(16).fill(0);

    [0, 1, 3, 5, 15].forEach((cell) => (density[cell] = 1));

    const holed = { ...grid, solid: Uint8Array.from(grid.solid, (solid, cell) => (cell === 5 ? 0 : solid)) };

    expect(Array.from(solidify(holed, density, [0]).solid)).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });
});
