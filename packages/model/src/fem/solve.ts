/**
 * Linear elasticity on a grid of cubes (see grid.ts): how far a part gives under forces, and the
 * stresses in it. Every cube is an eight-node brick of the same shape, so one small stiffness
 * matrix serves them all and the large one is never built; the equations are solved with
 * conjugate gradients.
 *
 * Units: mm, N, MPa.
 */
import { cellCount, cellNodes, nodeCount, type VoxelGrid } from "./grid.js";
import { applyRange, floats, sharedWork, type SharedWork } from "./shared.js";

export interface FemProblem {
  grid: VoxelGrid;
  /** Young's modulus, MPa, and Poisson's ratio of the material. */
  young: number;
  poisson: number;
  /** How stiff each cube is, as a share of the material (0: none). Absent: every material cube fully. */
  stiffness?: ArrayLike<number>;
  /** The nodes that are held. */
  fixed: ArrayLike<number>;
  /** Force on each node, N: x, y, z per node. */
  force: ArrayLike<number>;
}

export interface FemSolution {
  /** How far each node moves, mm: x, y, z per node. */
  displacement: Float64Array;
  iterations: number;
  /** False when the part is not held well enough to stand still, or the steps ran out. */
  converged: boolean;
}

const GAUSS = [0.5 - 0.5 / Math.sqrt(3), 0.5 + 0.5 / Math.sqrt(3)];

/** How node c's shape function changes along the three axes at a place in the unit cube. */
function shapeGradient(c: number, at: readonly number[]): number[] {
  const along = (axis: number) => ((c >> axis) & 1 ? at[axis]! : 1 - at[axis]!);
  const sign = (axis: number) => ((c >> axis) & 1 ? 1 : -1);

  return [sign(0) * along(1) * along(2), along(0) * sign(1) * along(2), along(0) * along(1) * sign(2)];
}

/** Lamé's two constants [λ, μ] of an isotropic material. */
const lame = (young: number, poisson: number): [number, number] => [
  (young * poisson) / ((1 + poisson) * (1 - 2 * poisson)),
  young / (2 * (1 + poisson)),
];

/**
 * The 24 × 24 stiffness matrix of a cube with edge 1 and Young's modulus 1 (rows and columns: x,
 * y, z of node 0, then node 1, …). A cube with edge h and modulus E is h·E times as stiff.
 */
export function brickStiffness(poisson: number): Float64Array {
  const [lambda, mu] = lame(1, poisson);
  const matrix = new Float64Array(24 * 24);

  for (const x of GAUSS) {
    for (const y of GAUSS) {
      for (const z of GAUSS) {
        const gradients = Array.from({ length: 8 }, (_, c) => shapeGradient(c, [x, y, z]));

        for (let a = 0; a < 8; a++) {
          for (let b = 0; b < 8; b++) {
            const ga = gradients[a]!;
            const gb = gradients[b]!;
            const together = ga[0]! * gb[0]! + ga[1]! * gb[1]! + ga[2]! * gb[2]!;

            for (let i = 0; i < 3; i++) {
              for (let j = 0; j < 3; j++) {
                matrix[(a * 3 + i) * 24 + b * 3 + j]! +=
                  (lambda * ga[i]! * gb[j]! + mu * ga[j]! * gb[i]! + (i === j ? mu * together : 0)) / 8;
              }
            }
          }
        }
      }
    }
  }

  return matrix;
}

/** From this many carrying cubes on the work is shared out among helper threads, if there are any. */
const SHARED_FROM = 4000;

/** The stiffness of a whole grid, applied cube by cube. */
export class Stiffness {
  readonly grid: VoxelGrid;
  /** The cubes that carry, with how stiff each is in N/mm per unit of the brick matrix. */
  readonly cells: Int32Array;
  readonly scale: Float64Array;
  /** 1 for every degree of freedom that may move: on a carrying cube and not held. */
  readonly free: Uint8Array;
  private readonly brick: Float64Array;
  private readonly nodes: Int32Array;
  /** With helper threads: where each row of cubes along x starts, and the helpers taking part. */
  private readonly slabs: Int32Array | null;
  private helpers = 0;
  private readonly shared: SharedWork | null;
  /** The stiffness of each degree of freedom against its own movement alone. */
  readonly diagonal: Float64Array;

  constructor(problem: Pick<FemProblem, "grid" | "young" | "poisson" | "stiffness" | "fixed">) {
    const { grid, stiffness } = problem;
    const share = (cell: number) => (grid.solid[cell] ? (stiffness ? stiffness[cell]! : 1) : 0);
    const carrying = Array.from({ length: cellCount(grid) }, (_, cell) => cell).filter(
      (cell) => share(cell) > 0,
    );

    this.grid = grid;

    const work = sharedWork();
    // Worth sharing out among threads only for many cubes; the lists then lie in the shared memory.
    const together = work && carrying.length >= SHARED_FROM ? work : null;

    this.brick = together ? together.floats(576) : new Float64Array(576);
    this.brick.set(brickStiffness(problem.poisson));
    this.cells = Int32Array.from(carrying);
    this.scale = together ? together.floats(carrying.length) : new Float64Array(carrying.length);
    carrying.forEach((cell, k) => (this.scale[k] = share(cell) * problem.young * grid.h));
    this.nodes = together ? together.integers(carrying.length * 8) : new Int32Array(carrying.length * 8);
    this.shared = null;
    this.slabs = null;

    if (together) {
      // Where each row of cubes along x starts in the list of carrying cubes (which runs row by row).
      const rows = together.integers(grid.ny * grid.nz + 1);

      for (let row = 1, k = 0; row <= grid.ny * grid.nz; row++) {
        while (k < carrying.length && carrying[k]! < row * grid.nx) k++;

        rows[row] = k;
      }

      if ([this.brick, this.scale, this.nodes, rows].every((list) => together.holds(list))) {
        this.shared = together;
        this.slabs = rows;
        this.helpers = together.ready;
      }
    }

    this.diagonal = new Float64Array(nodeCount(grid) * 3);
    this.free = new Uint8Array(nodeCount(grid) * 3);

    carrying.forEach((cell, k) => {
      const eight = cellNodes(grid, cell, this.nodes.subarray(k * 8, k * 8 + 8));

      for (let c = 0; c < 8; c++) {
        for (let i = 0; i < 3; i++) {
          this.diagonal[eight[c]! * 3 + i]! += this.scale[k]! * this.brick[(c * 3 + i) * 25]!;
          this.free[eight[c]! * 3 + i] = 1;
        }
      }
    });

    for (let n = 0; n < problem.fixed.length; n++) {
      this.free.fill(0, problem.fixed[n]! * 3, problem.fixed[n]! * 3 + 3);
    }
  }

  /** The movements of the eight nodes of carrying cube k. */
  gather(k: number, displacement: ArrayLike<number>, out: Float64Array): Float64Array {
    for (let c = 0; c < 8; c++) {
      const node = this.nodes[k * 8 + c]! * 3;

      out[c * 3] = displacement[node]!;
      out[c * 3 + 1] = displacement[node + 1]!;
      out[c * 3 + 2] = displacement[node + 2]!;
    }

    return out;
  }

  /** The forces that hold the movements `displacement` (held nodes: none). */
  apply(displacement: Float64Array, out: Float64Array): Float64Array {
    const together = this.shared;

    out.fill(0);

    if (together && this.helpers && together.holds(displacement) && together.holds(out)) {
      const { ny, nz } = this.grid;

      together.apply(
        this.brick,
        this.nodes,
        this.scale,
        this.slabs!,
        ny,
        nz,
        this.helpers,
        displacement,
        out,
      );
    } else {
      applyRange(this.brick, this.nodes, this.scale, 0, this.cells.length, displacement, out);
    }

    for (let i = 0; i < out.length; i++) out[i]! *= this.free[i]!;

    return out;
  }

  /**
   * The energy each carrying cube would hold at full stiffness (N·mm, twice the strain energy): what
   * the topology optimisation weighs the cubes by.
   */
  energies(displacement: ArrayLike<number>, young: number): Float64Array {
    const local = new Float64Array(24);
    const out = new Float64Array(this.cells.length);

    for (let k = 0; k < this.cells.length; k++) {
      this.gather(k, displacement, local);

      let energy = 0;

      for (let row = 0; row < 24; row++) {
        for (let column = 0; column < 24; column++) {
          energy += local[row]! * this.brick[row * 24 + column]! * local[column]!;
        }
      }

      out[k] = energy * young * this.grid.h;
    }

    return out;
  }

  /**
   * Conjugate gradients. Each round the remaining forces are turned into a guess of the movements
   * still missing: by `precondition` if given, else by dividing each by its own stiffness.
   */
  solve(
    force: ArrayLike<number>,
    options: {
      tolerance?: number;
      maxIterations?: number;
      start?: ArrayLike<number>;
      precondition?: (residual: Float64Array, guess: Float64Array) => void;
    } = {},
  ): FemSolution {
    const size = this.free.length;
    const displacement = floats(size);
    const residual = floats(size);
    const direction = floats(size);
    const pushed = floats(size);
    const guess = floats(size);

    const conditioned = () => {
      if (options.precondition) return options.precondition(residual, guess);

      for (let i = 0; i < size; i++) guess[i] = this.free[i] ? residual[i]! / this.diagonal[i]! : 0;
    };

    let load = 0;

    for (let i = 0; i < size; i++) {
      displacement[i] = this.free[i]! * (options.start?.[i] ?? 0);
      residual[i] = this.free[i]! * force[i]!;
      load += residual[i]! ** 2;
    }

    if (load === 0) return { displacement: displacement.fill(0), iterations: 0, converged: true };

    if (options.start) this.apply(displacement, pushed).forEach((value, i) => (residual[i]! -= value));

    conditioned();
    direction.set(guess);

    const limit = (options.tolerance ?? 1e-6) ** 2 * load;
    const maxIterations = options.maxIterations ?? 4000;
    let energy = dot(direction, residual);
    let iterations = 0;

    while (dot(residual, residual) > limit && iterations < maxIterations) {
      const curvature = dot(direction, this.apply(direction, pushed));
      // A part that can still move freely has directions without any resistance.
      if (!(curvature > 0)) break;

      const step = energy / curvature;

      for (let i = 0; i < size; i++) {
        displacement[i]! += step * direction[i]!;
        residual[i]! -= step * pushed[i]!;
      }

      conditioned();

      const next = dot(guess, residual);

      for (let i = 0; i < size; i++) direction[i] = guess[i]! + (next / energy) * direction[i]!;

      energy = next;
      iterations++;
    }

    return { displacement, iterations, converged: dot(residual, residual) <= limit };
  }
}

export function dot(a: Float64Array, b: Float64Array): number {
  let sum = 0;

  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;

  return sum;
}

/**
 * A force spread evenly over some cubes (each cube's share goes to its eight nodes), as the force
 * list of a problem; `into` adds it to forces already there.
 */
export function cellForce(
  grid: VoxelGrid,
  cells: ArrayLike<number>,
  total: readonly [number, number, number],
  into = new Float64Array(nodeCount(grid) * 3),
): Float64Array {
  const eight = new Int32Array(8);

  for (let i = 0; i < cells.length; i++) {
    cellNodes(grid, cells[i]!, eight).forEach((node) => {
      for (let axis = 0; axis < 3; axis++) into[node * 3 + axis]! += total[axis]! / (8 * cells.length);
    });
  }

  return into;
}

/**
 * The stress in the middle of each cube, MPa: xx, yy, zz, xy, yz, zx per cube (zero outside the
 * material), for the material at full stiffness.
 */
export function stresses(
  problem: Pick<FemProblem, "grid" | "young" | "poisson">,
  displacement: ArrayLike<number>,
): Float32Array {
  const { grid } = problem;
  const [lambda, mu] = lame(problem.young, problem.poisson);
  const gradients = Array.from({ length: 8 }, (_, c) =>
    shapeGradient(c, [0.5, 0.5, 0.5]).map((g) => g / grid.h),
  );
  const out = new Float32Array(cellCount(grid) * 6);
  const eight = new Int32Array(8);

  for (let cell = 0; cell < grid.solid.length; cell++) {
    if (!grid.solid[cell]) continue;

    // strain[i][j]: how the movement along i changes along j.
    const strain = [0, 0, 0, 0, 0, 0, 0, 0, 0];

    cellNodes(grid, cell, eight).forEach((node, c) => {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) strain[i * 3 + j]! += displacement[node * 3 + i]! * gradients[c]![j]!;
      }
    });

    const volume = lambda * (strain[0]! + strain[4]! + strain[8]!);

    out[cell * 6] = volume + 2 * mu * strain[0]!;
    out[cell * 6 + 1] = volume + 2 * mu * strain[4]!;
    out[cell * 6 + 2] = volume + 2 * mu * strain[8]!;
    out[cell * 6 + 3] = mu * (strain[1]! + strain[3]!);
    out[cell * 6 + 4] = mu * (strain[5]! + strain[7]!);
    out[cell * 6 + 5] = mu * (strain[2]! + strain[6]!);
  }

  return out;
}
