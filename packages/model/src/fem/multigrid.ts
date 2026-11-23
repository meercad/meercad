/**
 * Solving the equations of a large grid quickly: multigrid. Conjugate gradients alone need more and
 * more rounds the finer the grid is, because every round only passes forces on from cube to cube.
 * Here each round also solves the same part on coarser and coarser grids (cubes of twice the edge
 * each time, as stiff as the eight cubes they replace on average), which settles the movement of
 * the part as a whole at once; the fine grid only has to add the detail.
 */
import { cellCount, type VoxelGrid } from "./grid.js";
import { floats, sharedWork } from "./shared.js";
import { dot, Stiffness, type FemProblem, type FemSolution } from "./solve.js";

type Setup = Pick<FemProblem, "grid" | "young" | "poisson" | "stiffness" | "fixed">;

/** A grid is solved directly once it has no more unknowns than this. */
const DIRECT = 700;
/** Rounds of evening out where a coarsest grid is too large to solve directly (a thin plate). */
const SWEEPS = 24;
/** Rounds to find how far one evening-out step may go. */
const PROBES = 8;

interface Level {
  system: Stiffness;
  /** How far an evening-out step goes: below the point where it would overshoot. */
  damping: number;
  force: Float64Array;
  guess: Float64Array;
  left: Float64Array;
  /** The coarsest level solved directly: the lower triangle of its matrix, factorised. */
  factor?: Float64Array;
}

const dims = (grid: VoxelGrid): [number, number, number] => [grid.nx, grid.ny, grid.nz];

/**
 * The same part with cubes of twice the edge: each as stiff as the average of the up to eight it replaces.
 */
function coarser(fine: Setup): Setup {
  const { grid } = fine;
  const [nx, ny, nz] = dims(grid).map((count) => Math.ceil(count / 2)) as [number, number, number];
  const stiffness = new Float32Array(nx * ny * nz);

  for (let cell = 0; cell < cellCount(grid); cell++) {
    if (!grid.solid[cell]) continue;

    const x = cell % grid.nx;
    const y = Math.floor(cell / grid.nx) % grid.ny;
    const z = Math.floor(cell / (grid.nx * grid.ny));

    stiffness[(x >> 1) + nx * ((y >> 1) + ny * (z >> 1))]! +=
      (fine.stiffness ? fine.stiffness[cell]! : 1) / 8;
  }

  const row = grid.nx + 1;
  const layer = row * (grid.ny + 1);
  const fixed: number[] = [];

  // A coarse node is held where the fine node at the same place is.
  for (let i = 0; i < fine.fixed.length; i++) {
    const node = fine.fixed[i]!;
    const at = [node % row, Math.floor(node / row) % (grid.ny + 1), Math.floor(node / layer)];

    if (at.every((value) => value % 2 === 0)) {
      fixed.push(at[0]! / 2 + (nx + 1) * (at[1]! / 2 + (ny + 1) * (at[2]! / 2)));
    }
  }

  return {
    grid: {
      nx,
      ny,
      nz,
      h: grid.h * 2,
      origin: grid.origin,
      solid: Uint8Array.from(stiffness, (share) => (share > 0 ? 1 : 0)),
    },
    young: fine.young,
    poisson: fine.poisson,
    stiffness,
    fixed,
  };
}

/**
 * Passes values between the nodes of a grid and of the next coarser one. A fine node between coarse
 * nodes takes their mean (`toFine` adds that to the fine values); the other way round every fine
 * value is shared out among the same coarse nodes (`toFine` false, into `coarse`).
 */
function transfer(
  fineGrid: VoxelGrid,
  coarseGrid: VoxelGrid,
  fine: Float64Array,
  coarse: Float64Array,
  toFine: boolean,
): void {
  const [nx, ny, nz] = dims(fineGrid);
  const coarseRow = coarseGrid.nx + 1;
  const coarseLayer = coarseRow * (coarseGrid.ny + 1);

  if (!toFine) coarse.fill(0);

  for (let z = 0; z <= nz; z++) {
    for (let y = 0; y <= ny; y++) {
      for (let x = 0; x <= nx; x++) {
        const node = (x + (nx + 1) * (y + (ny + 1) * z)) * 3;

        // An odd place lies between two coarse nodes along that axis.
        for (let dz = 0; dz <= (z & 1); dz++) {
          for (let dy = 0; dy <= (y & 1); dy++) {
            for (let dx = 0; dx <= (x & 1); dx++) {
              const weight = 1 / ((1 + (x & 1)) * (1 + (y & 1)) * (1 + (z & 1)));
              const other = ((x >> 1) + dx + coarseRow * ((y >> 1) + dy) + coarseLayer * ((z >> 1) + dz)) * 3;

              for (let axis = 0; axis < 3; axis++) {
                if (toFine) fine[node + axis]! += weight * coarse[other + axis]!;
                else coarse[other + axis]! += weight * fine[node + axis]!;
              }
            }
          }
        }
      }
    }
  }
}

/** The largest factor by which an evening-out step can blow a movement up, found by trying. */
function overshoot(system: Stiffness): number {
  const size = system.free.length;
  const vector = floats(size);
  const pushed = floats(size);
  let factor = 1;

  for (let i = 0; i < size; i++) vector[i] = system.free[i]! * (1 + (i % 7));

  for (let probe = 0; probe < PROBES; probe++) {
    system.apply(vector, pushed);

    for (let i = 0; i < size; i++) pushed[i] = system.free[i] ? pushed[i]! / system.diagonal[i]! : 0;

    // Nothing free to move: any step is fine.
    factor = Math.sqrt(dot(pushed, pushed) / dot(vector, vector)) || 1;
    for (let i = 0; i < size; i++) vector[i] = pushed[i]! / factor;
  }

  return factor;
}

/** The whole matrix of a small system, factorised (Cholesky), held degrees of freedom as themselves. */
function factorised(system: Stiffness): Float64Array {
  const size = system.free.length;
  const matrix = new Float64Array(size * size);
  const unit = new Float64Array(size);
  const column = new Float64Array(size);

  for (let j = 0; j < size; j++) {
    unit[j] = 1;
    system.apply(unit, column);
    unit[j] = 0;

    for (let i = 0; i < size; i++) matrix[i * size + j] = column[i]! * system.free[j]!;

    if (!system.free[j]) matrix[j * size + j] = 1;
  }

  for (let j = 0; j < size; j++) {
    for (let k = 0; k < j; k++) {
      const factor = matrix[j * size + k]!;

      if (factor !== 0) {
        for (let i = j; i < size; i++) matrix[i * size + j]! -= matrix[i * size + k]! * factor;
      }
    }

    // A part that is not held has directions without stiffness: they are left alone.
    const pivot = Math.sqrt(Math.max(matrix[j * size + j]!, 1e-12 * system.diagonal[j]! + 1e-300));

    for (let i = j; i < size; i++) matrix[i * size + j]! /= pivot;
  }

  return matrix;
}

/** Solves with a factorised matrix: `values` in, the solution out in place. */
function substitute(factor: Float64Array, values: Float64Array): void {
  const size = values.length;

  for (let i = 0; i < size; i++) {
    for (let k = 0; k < i; k++) values[i]! -= factor[i * size + k]! * values[k]!;

    values[i]! /= factor[i * size + i]!;
  }

  for (let i = size - 1; i >= 0; i--) {
    for (let k = i + 1; k < size; k++) values[i]! -= factor[k * size + i]! * values[k]!;

    values[i]! /= factor[i * size + i]!;
  }
}

/**
 * A quick guess of the movements for given forces on a grid, from solving on coarser grids: what
 * conjugate gradients take as their `precondition`. Null for a grid too small to be worth it.
 */
export function multigrid(
  setup: Setup,
  system = new Stiffness(setup),
): ((residual: Float64Array, guess: Float64Array) => void) | null {
  if (system.free.length <= DIRECT) return null;

  const levels: Level[] = [];
  let at = setup;
  let current = system;

  for (;;) {
    const size = current.free.length;
    const level: Level = {
      system: current,
      damping: 0,
      force: floats(size),
      guess: floats(size),
      left: floats(size),
    };

    levels.push(level);

    // Halving a grid that is one cube thin would no longer be the same part.
    if (size <= DIRECT || Math.min(...dims(at.grid)) < 2) {
      if (size <= DIRECT) level.factor = factorised(current);
      else level.damping = 1 / overshoot(current);

      break;
    }

    level.damping = 1 / overshoot(current);
    at = coarser(at);
    current = new Stiffness(at);
  }

  /** One step of evening out: every node moves by what the forces left on it would do to it alone. */
  const even = (level: Level, first: boolean) => {
    const { system: own, guess, left, force } = level;

    if (first) left.set(force);
    else own.apply(guess, left).forEach((value, i) => (left[i] = force[i]! - value));

    for (let i = 0; i < guess.length; i++) {
      guess[i] = (first ? 0 : guess[i]!) + (own.free[i] ? (level.damping * left[i]!) / own.diagonal[i]! : 0);
    }
  };

  const cycle = (depth: number) => {
    const level = levels[depth]!;

    if (level.factor) {
      level.guess.set(level.force);
      substitute(level.factor, level.guess);

      return;
    }

    if (depth === levels.length - 1) {
      for (let sweep = 0; sweep < SWEEPS; sweep++) even(level, sweep === 0);

      return;
    }

    const below = levels[depth + 1]!;

    even(level, true);
    level.system
      .apply(level.guess, level.left)
      .forEach((value, i) => (level.left[i] = level.force[i]! - value));
    transfer(level.system.grid, below.system.grid, level.left, below.force, false);
    below.force.forEach((value, i) => (below.force[i] = value * below.system.free[i]!));
    cycle(depth + 1);
    level.left.fill(0);
    transfer(level.system.grid, below.system.grid, level.left, below.guess, true);
    level.guess.forEach((value, i) => (level.guess[i] = value + level.left[i]! * level.system.free[i]!));
    even(level, false);
  };

  return (residual, guess) => {
    levels[0]!.force.set(residual);
    cycle(0);
    guess.set(levels[0]!.guess);
  };
}

/** How far the part gives under the forces. */
export function solveFem(
  problem: FemProblem,
  options: { tolerance?: number; maxIterations?: number; start?: ArrayLike<number> } = {},
): FemSolution {
  // What an earlier calculation laid into the shared memory is no longer needed.
  sharedWork()?.reset();

  const system = new Stiffness(problem);
  const solution = system.solve(problem.force, {
    ...options,
    precondition: multigrid(problem, system) ?? undefined,
  });

  // A copy of its own: the shared memory is used again by the next calculation.
  return { ...solution, displacement: solution.displacement.slice() };
}
