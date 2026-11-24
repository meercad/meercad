/**
 * Topology optimisation: which cubes of a part carry the load, so the rest can go. Every cube gets
 * a density between nearly nothing and 1; cubes that hold little energy lose density, the ones
 * that hold much gain it, until the wanted share of material is left and stiffest for the forces
 * (the SIMP method: a half-dense cube is made much less than half as stiff, so the result ends up
 * nearly all-or-nothing).
 */
import { cellCount, type VoxelGrid } from "./grid.js";
import { multigrid } from "./multigrid.js";
import { sharedWork } from "./shared.js";
import { Stiffness, type FemProblem } from "./solve.js";

export interface TopologyJob {
  /** The part with its forces and holds (`stiffness` is not used). */
  problem: Omit<FemProblem, "stiffness">;
  /** Cubes that stay material whatever they carry: where the part is held and pushed. */
  keep: ArrayLike<number>;
  /** The share of the part's material to keep, 0…1. */
  share: number;
  /** Rounds at most; fewer when the densities stop changing. */
  steps?: number;
  /** Called after every round; return false to stop early. */
  onStep?: (step: number, steps: number) => boolean | void;
}

export interface TopologyResult {
  /** Density per cube, 0 outside the part. */
  density: Float32Array;
  steps: number;
}

/** How much less stiff a cube is than its density: stiffness = density ^ PENALTY. */
const PENALTY = 3;
/** The least density and stiffness share of a cube, so the equations stay solvable. */
const LEAST = 1e-3;
/** The most a density changes in one round. */
const MOVE = 0.2;
/**
 * Cubes whose centres are closer than this (in cubes) share their weights: no checkerboards, and
 * struts a few cubes thick instead of thin skins. A part only a few cubes thin gets less, down to
 * the least, or nothing of it would be left to shape.
 */
const RADIUS = 3;
const LEAST_RADIUS = 1.5;
/** Densities changing less than this in a round are settled. */
const SETTLED = 0.01;
/**
 * A round that makes the part less than this share stiffer has gained nothing; after this many
 * such rounds in a row the optimisation ends.
 */
const GAINED = 0.004;
const CALM_ROUNDS = 2;

export function optimiseTopology(job: TopologyJob): TopologyResult {
  const { grid } = job.problem;
  const kept = new Uint8Array(cellCount(grid));
  const density = new Float32Array(cellCount(grid));

  for (let i = 0; i < job.keep.length; i++) kept[job.keep[i]!] = grid.solid[job.keep[i]!]!;

  const material = Array.from(grid.solid.keys()).filter((cell) => grid.solid[cell]);
  const free = material.filter((cell) => !kept[cell]);
  // What the free cubes may weigh together once the kept ones are taken off the budget.
  const budget = Math.max(LEAST * free.length, job.share * material.length - (material.length - free.length));
  const start = Math.min(1, budget / Math.max(1, free.length));

  for (const cell of material) density[cell] = kept[cell] ? 1 : start;

  const neighbours = neighbourhood(grid);
  const steps = job.steps ?? 40;
  let displacement: Float64Array | undefined;
  let step = 0;

  let compliance = Infinity;
  let calm = 0;

  while (step < steps) {
    // What the round before laid into the shared memory is no longer needed.
    sharedWork()?.reset();

    const stiffness = Float32Array.from(density, (value) => LEAST + value ** PENALTY * (1 - LEAST));
    const system = new Stiffness({ ...job.problem, stiffness });

    // Solved roughly: the densities move far more from round to round than a finer answer would.
    displacement = system
      .solve(job.problem.force, {
        tolerance: 1e-2,
        maxIterations: 300,
        start: displacement,
        precondition: multigrid({ ...job.problem, stiffness }, system) ?? undefined,
      })
      .displacement.slice();

    const energies = system.energies(displacement, job.problem.young);
    const gain = new Float64Array(cellCount(grid));

    // How much stiffer the part gets per bit of density added to each cube.
    system.cells.forEach(
      (cell, k) => (gain[cell] = PENALTY * density[cell]! ** (PENALTY - 1) * (1 - LEAST) * energies[k]!),
    );

    // How much the part gives under its forces: the measure that gets smaller round by round.
    const given = displacement.reduce((sum, moved, i) => sum + moved * job.problem.force[i]!, 0);

    calm = Math.abs(compliance - given) < GAINED * given ? calm + 1 : 0;
    compliance = given;

    const change = redistribute(density, free, smoothed(gain, density, free, neighbours), budget);

    step++;

    if (job.onStep?.(step, steps) === false || change < SETTLED || calm >= CALM_ROUNDS) break;
  }

  return { density, steps: step };
}

/**
 * Over how many cubes the cubes of a grid share their weights: about how thick its struts come out, halved.
 */
export const filterRadius = (grid: VoxelGrid): number =>
  Math.max(LEAST_RADIUS, Math.min(RADIUS, Math.min(grid.nx, grid.ny, grid.nz) / 4));

/** For every cube the material cubes around it (itself too) with their weights, as [cell, weight, …]. */
function neighbourhood(grid: VoxelGrid): (cell: number) => number[] {
  const radius = filterRadius(grid);
  const reach = Math.floor(radius);

  return (cell) => {
    const x = cell % grid.nx;
    const y = Math.floor(cell / grid.nx) % grid.ny;
    const z = Math.floor(cell / (grid.nx * grid.ny));
    const around: number[] = [];

    for (let dz = -reach; dz <= reach; dz++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const weight = radius - Math.hypot(dx, dy, dz);
          const inside =
            x + dx >= 0 &&
            y + dy >= 0 &&
            z + dz >= 0 &&
            x + dx < grid.nx &&
            y + dy < grid.ny &&
            z + dz < grid.nz;
          const other = cell + dx + grid.nx * (dy + grid.ny * dz);

          if (weight > 0 && inside && grid.solid[other]) around.push(other, weight);
        }
      }
    }

    return around;
  };
}

/** The gains of the free cubes, each averaged with its neighbours' (weighted by their densities). */
function smoothed(
  gain: Float64Array,
  density: Float32Array,
  free: number[],
  neighbours: (cell: number) => number[],
): Float64Array {
  const out = new Float64Array(gain.length);

  for (const cell of free) {
    const around = neighbours(cell);
    let sum = 0;
    let weights = 0;

    for (let i = 0; i < around.length; i += 2) {
      sum += around[i + 1]! * density[around[i]!]! * gain[around[i]!]!;
      weights += around[i + 1]!;
    }

    out[cell] = sum / (density[cell]! * weights);
  }

  return out;
}

/**
 * Moves density to the free cubes that gain most, keeping their sum at the budget (the optimality
 * criteria update: the price of material is found by halving). Returns the largest change.
 */
function redistribute(density: Float32Array, free: number[], gain: Float64Array, budget: number): number {
  const most = free.reduce((max, cell) => Math.max(max, gain[cell]!), 0);
  // Without any gain (no force arrives) nothing tells the cubes apart.
  if (most === 0) return 0;

  const at = (cell: number, price: number) =>
    Math.max(
      LEAST,
      density[cell]! - MOVE,
      Math.min(1, density[cell]! + MOVE, density[cell]! * Math.sqrt(gain[cell]! / price)),
    );
  let low = 0;
  let high = most / LEAST ** 2;

  while (high - low > 1e-6 * (high + low)) {
    const price = (low + high) / 2;

    if (free.reduce((sum, cell) => sum + at(cell, price), 0) > budget) low = price;
    else high = price;
  }

  let change = 0;

  for (const cell of free) {
    const next = at(cell, high);

    change = Math.max(change, Math.abs(next - density[cell]!));
    density[cell] = next;
  }

  return change;
}

/**
 * The part that is left: the cubes denser than `level` that hang together with a kept cube (face to
 * face), as a grid of its own. Loose crumbs are dropped.
 */
export function solidify(
  grid: VoxelGrid,
  density: ArrayLike<number>,
  keep: ArrayLike<number>,
  level = 0.5,
): VoxelGrid {
  const solid = new Uint8Array(cellCount(grid));
  const open: number[] = [];
  const steps: [number, number, number][] = [
    [1, 0, 0],
    [-1, 0, 0],
    [0, 1, 0],
    [0, -1, 0],
    [0, 0, 1],
    [0, 0, -1],
  ];

  const reach = (cell: number) => {
    if (solid[cell] || !grid.solid[cell] || !(density[cell]! > level)) return;

    solid[cell] = 1;
    open.push(cell);
  };

  for (let i = 0; i < keep.length; i++) reach(keep[i]!);

  while (open.length) {
    const cell = open.pop()!;
    const at = [cell % grid.nx, Math.floor(cell / grid.nx) % grid.ny, Math.floor(cell / (grid.nx * grid.ny))];

    for (const [dx, dy, dz] of steps) {
      const [x, y, z] = [at[0]! + dx, at[1]! + dy, at[2]! + dz];

      if (x >= 0 && y >= 0 && z >= 0 && x < grid.nx && y < grid.ny && z < grid.nz) {
        reach(x + grid.nx * (y + grid.ny * z));
      }
    }
  }

  return { ...grid, solid };
}
