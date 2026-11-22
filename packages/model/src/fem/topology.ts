/**
 * Topology optimisation: which cubes of a part carry the load, so the rest can go. Every cube gets
 * a density between nearly nothing and 1; cubes that hold little energy lose density, the ones
 * that hold much gain it, until the wanted share of material is left and stiffest for the forces
 * (the SIMP method: a half-dense cube is made much less than half as stiff, so the result ends up
 * nearly all-or-nothing).
 */
import { cellCount, type VoxelGrid } from "./grid.js";
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
 * Cubes whose centres are closer than this (in cubes) share their weights: no checkerboards, no hair-thin
 * struts.
 */
const RADIUS = 1.5;
/** Densities changing less than this in a round are settled. */
const SETTLED = 0.01;

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

  while (step < steps) {
    const stiffness = Float32Array.from(density, (value) => LEAST + value ** PENALTY * (1 - LEAST));
    const system = new Stiffness({ ...job.problem, stiffness });

    displacement = system.solve(job.problem.force, {
      tolerance: 1e-3,
      maxIterations: 300,
      start: displacement,
    }).displacement;

    const energies = system.energies(displacement, job.problem.young);
    const gain = new Float64Array(cellCount(grid));

    // How much stiffer the part gets per bit of density added to each cube.
    system.cells.forEach(
      (cell, k) => (gain[cell] = PENALTY * density[cell]! ** (PENALTY - 1) * (1 - LEAST) * energies[k]!),
    );

    const change = redistribute(density, free, smoothed(gain, density, free, neighbours), budget);

    step++;

    if (job.onStep?.(step, steps) === false || change < SETTLED) break;
  }

  return { density, steps: step };
}

/** For every cube the material cubes around it (itself too) with their weights, as [cell, weight, …]. */
function neighbourhood(grid: VoxelGrid): (cell: number) => number[] {
  const reach = Math.floor(RADIUS);

  return (cell) => {
    const x = cell % grid.nx;
    const y = Math.floor(cell / grid.nx) % grid.ny;
    const z = Math.floor(cell / (grid.nx * grid.ny));
    const around: number[] = [];

    for (let dz = -reach; dz <= reach; dz++) {
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const weight = RADIUS - Math.hypot(dx, dy, dz);
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
