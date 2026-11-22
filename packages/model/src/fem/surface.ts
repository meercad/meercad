/**
 * The skin of a grid of cubes as triangles: the outer faces of the material cubes, with the stair
 * steps smoothed away. Corners move at most a little less than half a cube, so no wall closes or
 * opens, and the corners of pinned cubes (where the part is held or pushed) stay exactly in place.
 */
import { cellNodes, nodeCount, type VoxelGrid } from "./grid.js";

/** How far a corner may leave its place, in cubes. */
const LEASH = 0.45;
/**
 * How far a corner goes towards the middle of its neighbours in a round, and back out in the next:
 * pulling alone would thin every strut, the push after it keeps their size (Taubin smoothing).
 */
const PULL = 0.5;
const PUSH = -0.53;

export function surfaceMesh(
  grid: VoxelGrid,
  pinned: ArrayLike<number> = [],
  rounds = 10,
): { positions: Float32Array; indices: Uint32Array } {
  const vertexOf = new Int32Array(nodeCount(grid)).fill(-1);
  const nodes: number[] = [];
  const indices: number[] = [];
  const eight = new Int32Array(8);
  const size = [grid.nx, grid.ny, grid.nz];
  const stride = [1, grid.nx, grid.nx * grid.ny];
  const vertex = (node: number) =>
    vertexOf[node]! >= 0 ? vertexOf[node]! : (vertexOf[node] = nodes.push(node) - 1);

  for (let cell = 0; cell < grid.solid.length; cell++) {
    if (!grid.solid[cell]) continue;

    const at = [cell % grid.nx, Math.floor(cell / grid.nx) % grid.ny, Math.floor(cell / stride[2]!)];

    cellNodes(grid, cell, eight);

    for (let axis = 0; axis < 3; axis++) {
      for (const far of [0, 1]) {
        const beside = at[axis]! + (far ? 1 : -1);

        if (beside >= 0 && beside < size[axis]! && grid.solid[cell + (far ? 1 : -1) * stride[axis]!]) {
          continue;
        }

        // The face's four corners, anticlockwise seen from outside.
        const u = 1 << ((axis + 1) % 3);
        const v = 1 << ((axis + 2) % 3);
        const base = far << axis;
        const ring = [base, base + u, base + u + v, base + v].map((c) => vertex(eight[c]!));

        if (!far) ring.reverse();

        indices.push(ring[0]!, ring[1]!, ring[2]!, ring[0]!, ring[2]!, ring[3]!);
      }
    }
  }

  const row = grid.nx + 1;
  const layer = row * (grid.ny + 1);
  const home = new Float32Array(nodes.length * 3);

  nodes.forEach((node, i) => {
    home[i * 3] = node % row;
    home[i * 3 + 1] = Math.floor(node / row) % (grid.ny + 1);
    home[i * 3 + 2] = Math.floor(node / layer);
  });

  const held = new Uint8Array(nodes.length);
  const pinnedNodes = new Int32Array(8);

  for (let i = 0; i < pinned.length; i++) {
    cellNodes(grid, pinned[i]!, pinnedNodes).forEach(
      (node) => vertexOf[node]! >= 0 && (held[vertexOf[node]!] = 1),
    );
  }

  const positions = relax(home, indices, held, rounds);

  for (let i = 0; i < positions.length; i++) positions[i] = grid.origin[i % 3]! + positions[i]! * grid.h;

  return { positions, indices: Uint32Array.from(indices) };
}

/**
 * Moves every free corner towards and away from the middle of the corners it shares a face edge with, on a
 * leash.
 */
function relax(home: Float32Array, indices: number[], held: Uint8Array, rounds: number): Float32Array {
  const linked: Set<number>[] = Array.from({ length: home.length / 3 }, () => new Set());

  // Each face is two triangles a b c, a c d: its edges are a–b, b–c, c–d, d–a (not the diagonal).
  for (let t = 0; t < indices.length; t += 6) {
    const ring = [indices[t]!, indices[t + 1]!, indices[t + 2]!, indices[t + 5]!];

    ring.forEach((corner, i) => {
      linked[corner]!.add(ring[(i + 1) % 4]!);
      linked[ring[(i + 1) % 4]!]!.add(corner);
    });
  }

  let now = home.slice();

  for (let round = 0; round < rounds; round++) {
    const next = now.slice();

    linked.forEach((others, corner) => {
      if (held[corner]) return;

      for (let axis = 0; axis < 3; axis++) {
        let middle = 0;

        others.forEach((other) => (middle += now[other * 3 + axis]!));

        const to =
          now[corner * 3 + axis]! +
          (round % 2 ? PUSH : PULL) * (middle / others.size - now[corner * 3 + axis]!);
        const start = home[corner * 3 + axis]!;

        next[corner * 3 + axis] = Math.max(start - LEASH, Math.min(start + LEASH, to));
      }
    });
    now = next;
  }

  return now;
}
