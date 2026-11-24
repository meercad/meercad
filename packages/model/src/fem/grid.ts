/**
 * A part as cubes: the grid the strength check and the topology optimisation calculate on. The
 * part's triangles are turned into cubes of one size (a cube is material when its centre lies
 * inside the part), and faces of the part are found again as the cubes lying at them, to hold the
 * part or to push on it.
 *
 * Cubes are numbered x + nx·(y + ny·z); their corners (the nodes) x + (nx+1)·(y + (ny+1)·z).
 */

export type Vec3 = [number, number, number];

export interface VoxelGrid {
  nx: number;
  ny: number;
  nz: number;
  /** Edge length of a cube, mm. */
  h: number;
  /** The corner of cube 0 with the smallest coordinates. */
  origin: Vec3;
  /** 1 where a cube is material. */
  solid: Uint8Array;
}

export const cellCount = (grid: VoxelGrid): number => grid.nx * grid.ny * grid.nz;

export const nodeCount = (grid: VoxelGrid): number => (grid.nx + 1) * (grid.ny + 1) * (grid.nz + 1);

/** The eight corners of a cube, corner c at (x + (c & 1), y + (c >> 1 & 1), z + (c >> 2)). */
export function cellNodes(grid: VoxelGrid, cell: number, out: Int32Array): Int32Array {
  const x = cell % grid.nx;
  const y = Math.floor(cell / grid.nx) % grid.ny;
  const z = Math.floor(cell / (grid.nx * grid.ny));
  const row = grid.nx + 1;
  const layer = row * (grid.ny + 1);
  const first = x + row * y + layer * z;

  for (let c = 0; c < 8; c++) out[c] = first + (c & 1) + ((c >> 1) & 1) * row + (c >> 2) * layer;

  return out;
}

/**
 * Sample points sit a hair off the cube centres, so none lies exactly on a triangle's edge (a
 * square face split along its diagonal passes through the centres of a square grid).
 */
const OFF_X = 1.37e-5;
const OFF_Y = 2.71e-5;

/**
 * The part as about `cells` cubes within its bounding box (fewer where the box is not full). Rays
 * along Z count the walls they cross: between an odd and the next even crossing lies material.
 */
export function voxelize(positions: ArrayLike<number>, indices: ArrayLike<number>, cells: number): VoxelGrid {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3]!, positions[i]!);
    max[i % 3] = Math.max(max[i % 3]!, positions[i]!);
  }

  const size = max.map((v, axis) => Math.max(v - min[axis]!, 1e-9));
  const h = Math.cbrt((size[0]! * size[1]! * size[2]!) / cells);
  const [nx, ny, nz] = size.map((length) => Math.max(1, Math.round(length / h))) as Vec3;
  const grid: VoxelGrid = { nx, ny, nz, h, origin: min, solid: new Uint8Array(nx * ny * nz) };
  const crossings: number[][] = Array.from({ length: nx * ny }, () => []);

  for (let t = 0; t < indices.length; t += 3) {
    crossColumns(
      grid,
      corner(positions, indices[t]!),
      corner(positions, indices[t + 1]!),
      corner(positions, indices[t + 2]!),
      crossings,
    );
  }

  crossings.forEach((heights, column) => fillColumn(grid, column, heights));

  return grid;
}

const corner = (positions: ArrayLike<number>, i: number): Vec3 => [
  positions[i * 3]!,
  positions[i * 3 + 1]!,
  positions[i * 3 + 2]!,
];

/** Notes, for every column of cubes whose ray passes through the triangle, the height of the crossing. */
function crossColumns(grid: VoxelGrid, a: Vec3, b: Vec3, c: Vec3, crossings: number[][]): void {
  const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
  // A triangle seen edge-on from above has no crossing.
  if (area === 0) return;

  const column = (value: number, axis: number, count: number) =>
    Math.max(0, Math.min(count - 1, Math.floor((value - grid.origin[axis]!) / grid.h - 0.5)));
  const x0 = column(Math.min(a[0], b[0], c[0]), 0, grid.nx);
  const x1 = Math.min(grid.nx - 1, column(Math.max(a[0], b[0], c[0]), 0, grid.nx) + 1);
  const y0 = column(Math.min(a[1], b[1], c[1]), 1, grid.ny);
  const y1 = Math.min(grid.ny - 1, column(Math.max(a[1], b[1], c[1]), 1, grid.ny) + 1);

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const px = grid.origin[0] + (x + 0.5 + OFF_X) * grid.h;
      const py = grid.origin[1] + (y + 0.5 + OFF_Y) * grid.h;
      const wa = ((b[0] - px) * (c[1] - py) - (c[0] - px) * (b[1] - py)) / area;
      const wb = ((c[0] - px) * (a[1] - py) - (a[0] - px) * (c[1] - py)) / area;
      const wc = 1 - wa - wb;

      if (wa >= 0 && wb >= 0 && wc >= 0) crossings[x + grid.nx * y]!.push(wa * a[2] + wb * b[2] + wc * c[2]);
    }
  }
}

/** Marks the cubes of one column whose centres lie between an odd and the next even crossing. */
function fillColumn(grid: VoxelGrid, column: number, heights: number[]): void {
  heights.sort((low, high) => low - high);

  // An open mesh may leave a crossing without its partner: it is left out.
  for (let pair = 0; pair + 1 < heights.length; pair += 2) {
    const from = Math.max(0, Math.ceil((heights[pair]! - grid.origin[2]) / grid.h - 0.5));
    const to = Math.min(grid.nz - 1, Math.ceil((heights[pair + 1]! - grid.origin[2]) / grid.h - 0.5) - 1);

    for (let z = from; z <= to; z++) grid.solid[column + grid.nx * grid.ny * z] = 1;
  }
}

/**
 * The material cubes lying at some triangles of the part (a face): points all over the triangles
 * each take the nearest material cube, at most one cube away. Sorted, each cube once.
 */
export function cellsAt(
  grid: VoxelGrid,
  positions: ArrayLike<number>,
  triangles: ArrayLike<number>,
): Int32Array {
  const found = new Set<number>();

  for (let t = 0; t < triangles.length; t += 3) {
    const a = corner(positions, triangles[t]!);
    const b = corner(positions, triangles[t + 1]!);
    const c = corner(positions, triangles[t + 2]!);
    const longest = Math.max(distance(a, b), distance(b, c), distance(c, a));
    // Points half a cube apart miss no cube along the face.
    const steps = Math.max(1, Math.ceil((2 * longest) / grid.h));

    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const wa = i / steps;
        const wb = j / steps;
        const wc = 1 - wa - wb;
        const cell = nearestSolid(
          grid,
          [0, 1, 2].map((axis) => wa * a[axis]! + wb * b[axis]! + wc * c[axis]!) as Vec3,
        );

        if (cell >= 0) found.add(cell);
      }
    }
  }

  return Int32Array.from(found).sort();
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The material cube whose centre is nearest to a point, among the point's cube and its neighbours; −1 if
 * none.
 */
export function nearestSolid(grid: VoxelGrid, point: Vec3): number {
  const at = point.map((value, axis) => (value - grid.origin[axis]!) / grid.h);
  const home = at.map(Math.floor);
  let best = -1;
  let bestDistance = Infinity;

  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = home[0]! + dx;
        const y = home[1]! + dy;
        const z = home[2]! + dz;

        if (x < 0 || y < 0 || z < 0 || x >= grid.nx || y >= grid.ny || z >= grid.nz) continue;

        const cell = x + grid.nx * (y + grid.ny * z);
        const away = Math.hypot(x + 0.5 - at[0]!, y + 0.5 - at[1]!, z + 0.5 - at[2]!);

        if (grid.solid[cell] && away < bestDistance) {
          best = cell;
          bestDistance = away;
        }
      }
    }
  }

  return best;
}

/** The nodes of some cubes, each once. */
export function nodesOf(grid: VoxelGrid, cells: ArrayLike<number>): Int32Array {
  const nodes = new Set<number>();
  const eight = new Int32Array(8);

  for (let i = 0; i < cells.length; i++) cellNodes(grid, cells[i]!, eight).forEach((node) => nodes.add(node));

  return Int32Array.from(nodes).sort();
}

/** Volume of the material cubes, mm³. */
export const solidVolume = (grid: VoxelGrid): number =>
  grid.solid.reduce((sum, solid) => sum + solid, 0) * grid.h ** 3;
