/** Simple parts for the tests of the strength calculation. */
import { cellsAt, nodesOf, voxelize, type Vec3, type VoxelGrid } from "./grid.js";

/** A box from the origin as twelve triangles, facing outwards. Faces: 0 −x, 1 +x, 2 −y, 3 +y, 4 −z, 5 +z. */
export function boxMesh(size: Vec3): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array(24);

  for (let c = 0; c < 8; c++) {
    positions.set([(c & 1) * size[0], ((c >> 1) & 1) * size[1], (c >> 2) * size[2]], c * 3);
  }

  const quads = [
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ];

  return { positions, indices: Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!])) };
}

/** A box as cubes of edge 1, with the cubes and nodes at each of its six faces. */
export function boxGrid(size: Vec3): { grid: VoxelGrid; faceCells: Int32Array[]; faceNodes: Int32Array[] } {
  const mesh = boxMesh(size);
  const grid = voxelize(mesh.positions, mesh.indices, size[0] * size[1] * size[2]);
  const faceCells = [0, 1, 2, 3, 4, 5].map((face) =>
    cellsAt(grid, mesh.positions, mesh.indices.subarray(face * 6, face * 6 + 6)),
  );
  const row = grid.nx + 1;
  const layer = row * (grid.ny + 1);
  const coordinate = (node: number, axis: number) =>
    [node % row, Math.floor(node / row) % (grid.ny + 1), Math.floor(node / layer)][axis]!;
  const faceNodes = faceCells.map((cells, face) =>
    nodesOf(grid, cells).filter((node) => coordinate(node, face >> 1) === (face & 1 ? size[face >> 1]! : 0)),
  );

  return { grid, faceCells, faceNodes };
}
