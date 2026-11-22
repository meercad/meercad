/**
 * The strength check and the topology suggestion of a part, from its triangles to the answer: the
 * part becomes cubes, the faces it is held and pushed at become the cubes lying there, and the
 * result comes back as numbers, as colours for the part's surface and as the triangles of the
 * lighter part.
 */
import { cellsAt, nearestSolid, nodesOf, solidVolume, voxelize, type Vec3, type VoxelGrid } from "./grid.js";
import { solveFem } from "./multigrid.js";
import { cellForce, stresses } from "./solve.js";
import { strengthCheck, type Strength } from "./strength.js";
import { smoothSurface } from "./smooth.js";
import { optimiseTopology, solidify } from "./topology.js";

export interface StrengthJob {
  /** The part's triangles. */
  positions: ArrayLike<number>;
  indices: ArrayLike<number>;
  /** The triangles (three corners each) of the faces the part is held at. */
  holds: ArrayLike<number>;
  /** The faces pushed on, each with its whole force in N. */
  loads: { triangles: ArrayLike<number>; force: Vec3 }[];
  material: Strength;
  /** The direction the printed layers are stacked in, of length 1. */
  up: Vec3;
  /** About how many cubes to calculate with. */
  cells: number;
}

export interface StrengthReport {
  grid: VoxelGrid;
  /** Per cube: the share of the material's strength used. */
  used: Float32Array;
  /** Strength over the largest stress away from the holds and loads. */
  safety: number;
  /** Where the part is closest to giving way, if anywhere. */
  worstAt: Vec3 | null;
  /** The farthest any spot of the part moves, mm. */
  deflection: number;
  /** False when the part is not held well enough to stand still: the numbers mean nothing then. */
  converged: boolean;
}

/** Why a job cannot be calculated: no cube lies at the faces to hold or to push. */
export class StrengthError extends Error {
  constructor(readonly reason: "hold" | "load") {
    super(reason);
  }
}

interface Setup {
  grid: VoxelGrid;
  held: Int32Array;
  loads: { cells: Int32Array; force: Vec3 }[];
}

/** The part of a job as cubes, with the cubes at the faces it is held and pushed at. */
function setup(job: StrengthJob, part: Pick<StrengthJob, "positions" | "indices"> = job): Setup {
  const grid = voxelize(part.positions, part.indices, job.cells);
  const held = cellsAt(grid, job.positions, job.holds);
  const loads = job.loads.map((load) => ({
    cells: cellsAt(grid, job.positions, load.triangles),
    force: load.force,
  }));

  if (!held.length) throw new StrengthError("hold");
  if (!loads.length || loads.some((load) => !load.cells.length)) throw new StrengthError("load");

  return { grid, held, loads };
}

function check(start: Setup, material: Strength, up: Vec3): StrengthReport {
  // Material that does not hang on a held cube carries nothing and could not stand still.
  const grid = solidify(start.grid, start.grid.solid, start.held);
  const held = start.held;
  const loads = start.loads.map((load) => ({
    ...load,
    cells: load.cells.filter((cell) => grid.solid[cell]),
  }));

  // A pushed face without a way to the hold: the part is in pieces.
  if (loads.some((load) => !load.cells.length)) {
    return {
      grid,
      used: new Float32Array(grid.solid.length),
      safety: 0,
      worstAt: null,
      deflection: 0,
      converged: false,
    };
  }

  const force = new Float64Array((grid.nx + 1) * (grid.ny + 1) * (grid.nz + 1) * 3);

  for (const load of loads) cellForce(grid, load.cells, load.force, force);

  const problem = {
    grid,
    young: material.young,
    poisson: material.poisson,
    fixed: nodesOf(grid, held),
    force,
  };
  const solution = solveFem(problem);
  const skip = [...held, ...loads.flatMap((load) => [...load.cells])];
  const result = strengthCheck(stresses(problem, solution.displacement), grid.solid, material, up, skip);
  const at = result.worstCell;
  let deflection = 0;

  for (let node = 0; node < solution.displacement.length; node += 3) {
    deflection = Math.max(deflection, Math.hypot(...solution.displacement.subarray(node, node + 3)));
  }

  return {
    grid,
    used: result.used,
    safety: result.safety,
    worstAt:
      at < 0 || result.worst === 0
        ? null
        : ([at % grid.nx, Math.floor(at / grid.nx) % grid.ny, Math.floor(at / (grid.nx * grid.ny))].map(
            (index, axis) => grid.origin[axis]! + (index + 0.5) * grid.h,
          ) as Vec3),
    deflection,
    converged: solution.converged,
  };
}

/** How well a part holds its loads. */
export const checkStrength = (job: StrengthJob): StrengthReport => check(setup(job), job.material, job.up);

export interface TriangleSkin {
  positions: Float32Array;
  indices: Uint32Array;
}

/** The cubes that stay material whatever they carry: where the part is held and pushed. */
const keptCells = ({ held, loads }: Setup): number[] => [
  ...held,
  ...loads.flatMap((load) => [...load.cells]),
];

/** The forces and holds of a set-up as the equations to solve. */
function problemOf({ grid, held, loads }: Setup, material: Strength) {
  const force = new Float64Array((grid.nx + 1) * (grid.ny + 1) * (grid.nz + 1) * 3);

  for (const load of loads) cellForce(grid, load.cells, load.force, force);

  return { grid, young: material.young, poisson: material.poisson, fixed: nodesOf(grid, held), force };
}

export interface TopologySuggestion {
  /** The lighter part as triangles. */
  mesh: TriangleSkin;
  /** Its volume as a share of the part's. */
  share: number;
  /** The part as it was, and the lighter part, checked with the same holds and loads. */
  before: StrengthReport;
  after: StrengthReport;
}

/**
 * A lighter part for the same holds and loads: about `share` of the material, kept along the load
 * paths, the faces held and pushed at left whole. The suggestion is checked like the part itself.
 */
export function suggestTopology(
  job: StrengthJob & {
    share: number;
    steps?: number;
    /** About how many cubes to check the suggestion with: more than `cells`, as its struts are thin. */
    checkCells?: number;
    /** Works the suggestion's triangles over before it is checked and handed out (made lighter, say). */
    finish?: (mesh: TriangleSkin) => TriangleSkin;
    onStep?: (step: number, steps: number) => boolean | void;
  },
): TopologySuggestion {
  const start = setup(job);
  const { grid, held, loads } = start;
  const before = check(start, job.material, job.up);
  const keep = keptCells(start);
  const { density } = optimiseTopology({
    problem: problemOf(start, job.material),
    keep,
    share: job.share,
    steps: job.steps,
    onStep: job.onStep,
  });
  const lighter = solidify(grid, density, keep);
  const share = solidVolume(lighter) / solidVolume(grid);
  const skin = smoothSurface({ grid, density, keep, positions: job.positions, indices: job.indices, share });
  const mesh = job.finish?.(skin) ?? skin;

  // The check of the suggestion starts from its own triangles again, like the check of any part.
  return {
    mesh,
    share,
    before,
    after: check(setup({ ...job, cells: job.checkCells ?? job.cells }, mesh), job.material, job.up),
  };
}

// Green where little of the strength is used, yellow at half, red from all of it.
const GREEN = [0.3, 0.72, 0.45];
const YELLOW = [0.95, 0.78, 0.25];
const RED = [0.86, 0.22, 0.2];
const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The scale's colours as CSS, for the legend. */
export const STRENGTH_SCALE = [GREEN, YELLOW, RED].map(
  (rgb) => `rgb(${rgb.map((c) => Math.round(c * 255)).join(",")})`,
);

/**
 * A colour for each point on the part's surface (x, y, z per point; linear red, green, blue back):
 * how much of the strength the cube there uses. Points away from every cube stay green.
 */
export function strengthColors(
  report: Pick<StrengthReport, "grid" | "used">,
  points: ArrayLike<number>,
): Float32Array {
  const colors = new Float32Array(points.length);

  for (let p = 0; p < points.length; p += 3) {
    const cell = nearestSolid(report.grid, [points[p]!, points[p + 1]!, points[p + 2]!]);
    const used = Math.min(1, cell < 0 ? 0 : report.used[cell]!);
    const [from, to, part] = used < 0.5 ? [GREEN, YELLOW, used * 2] : [YELLOW, RED, used * 2 - 1];

    for (let c = 0; c < 3; c++) colors[p + c] = linear(from[c]! + (to[c]! - from[c]!) * part);
  }

  return colors;
}

export type StrengthRequest =
  | { kind: "check"; job: StrengthJob }
  | { kind: "topology"; job: StrengthJob & { share: number; steps?: number; checkCells?: number } };

export type StrengthAnswer =
  | { kind: "check"; report: StrengthReport }
  | { kind: "topology"; suggestion: TopologySuggestion }
  | { kind: "error"; reason: "hold" | "load" | "failed" };

/**
 * Answers a request, whatever happens (for the worker the calculation runs in). `finish` works a
 * suggestion's triangles over before it is checked.
 */
export function answerStrength(
  request: StrengthRequest,
  onProgress: (share: number) => void,
  finish?: (mesh: TriangleSkin) => TriangleSkin,
): StrengthAnswer {
  try {
    if (request.kind === "check") return { kind: "check", report: checkStrength(request.job) };

    const onStep = (step: number, steps: number) => onProgress(step / steps);

    return { kind: "topology", suggestion: suggestTopology({ ...request.job, onStep, finish }) };
  } catch (error) {
    return { kind: "error", reason: error instanceof StrengthError ? error.reason : "failed" };
  }
}
