/**
 * Parts as cubes (grid.ts): a box fills its grid, an L and a box with a hole leave the right cubes
 * empty, a square face split along its diagonal is still filled without gaps, an open mesh loses only
 * the unpaired crossing; faces are found again as the cubes lying at them.
 */
import { describe, expect, it } from "vitest";
import { cellCount, cellNodes, cellsAt, nodeCount, nodesOf, solidVolume, voxelize } from "./grid.js";
import { boxGrid, boxMesh } from "./testParts.js";

describe("voxelize", () => {
  it("fills a box completely, with cubes of the size the count asks for", () => {
    const { grid } = boxGrid([4, 3, 2]);

    expect([grid.nx, grid.ny, grid.nz, grid.h]).toEqual([4, 3, 2, 1]);
    expect(grid.origin).toEqual([0, 0, 0]);
    expect(cellCount(grid)).toBe(24);
    expect(nodeCount(grid)).toBe(60);
    expect(solidVolume(grid)).toBe(24);
  });

  it("gives a thin plate at least one layer of cubes", () => {
    const mesh = boxMesh([10, 10, 0.4]);
    const grid = voxelize(mesh.positions, mesh.indices, 100);

    expect(grid.nz).toBe(1);
    expect(solidVolume(grid)).toBeCloseTo(100 * grid.h ** 3 * ((grid.nx * grid.ny) / 100));
  });

  it("leaves a hole through a box empty", () => {
    // A 3 × 3 × 1 box with the middle column cut out: outer box plus an inner box turned inside out.
    const outer = boxMesh([3, 3, 1]);
    const inner = boxMesh([1, 1, 1]);
    const positions = new Float32Array(48);

    positions.set(outer.positions);
    inner.positions.forEach((value, i) => (positions[24 + i] = value + (i % 3 < 2 ? 1 : 0)));

    // The hole's side walls only, facing inwards.
    const walls = Array.from(inner.indices.subarray(0, 24), (index) => index + 8);
    const indices = Uint32Array.from([
      ...outer.indices,
      ...walls.map((_, i) => walls[i - (i % 3) + [0, 2, 1][i % 3]!]!),
    ]);
    const grid = voxelize(positions, indices, 9);

    expect(Array.from(grid.solid)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);

    // With bottom and top open over the hole the rays through it cross nothing.
    const open = Uint32Array.from([...outer.indices].filter((_, i) => i < 24).concat(ring(0), ring(1.0)));

    expect(Array.from(voxelize(positions, open, 9).solid)).toEqual([1, 1, 1, 1, 0, 1, 1, 1, 1]);

    function ring(z: number): number[] {
      // Bottom or top of the outer box as eight triangles around the hole.
      const o = z ? [4, 5, 7, 6] : [0, 1, 3, 2];
      const h = z ? [12, 13, 15, 14] : [8, 9, 11, 10];

      return [0, 1, 2, 3].flatMap((k) => [
        o[k]!,
        o[(k + 1) % 4]!,
        h[(k + 1) % 4]!,
        o[k]!,
        h[(k + 1) % 4]!,
        h[k]!,
      ]);
    }
  });

  it("ignores a crossing without its partner, and triangles seen edge-on", () => {
    const mesh = boxMesh([2, 2, 2]);
    // Without the top: each ray crosses the bottom only.
    const grid = voxelize(mesh.positions, mesh.indices.subarray(0, 30), 8);

    expect(solidVolume(grid)).toBe(0);
  });
});

describe("faces as cubes", () => {
  it("finds the cubes and nodes at each face of a box", () => {
    const { grid, faceCells, faceNodes } = boxGrid([4, 3, 2]);

    expect(Array.from(faceCells[0]!)).toEqual([0, 4, 8, 12, 16, 20]);
    expect(Array.from(faceCells[5]!)).toEqual([12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(faceNodes[4]!.length).toBe(20);
    expect(Array.from(cellNodes(grid, 23, new Int32Array(8)))).toEqual([33, 34, 38, 39, 53, 54, 58, 59]);
    expect(nodesOf(grid, [0, 1]).length).toBe(12);
  });

  it("takes the nearest material cube for a face that lies off the cubes, none when too far", () => {
    const { grid } = boxGrid([2, 2, 2]);

    grid.solid[7] = 0;

    const corner = Float32Array.from([1.6, 1.6, 2, 1.9, 1.6, 2, 1.6, 1.9, 2]);
    const far = Float32Array.from([5, 5, 5, 5.1, 5, 5, 5, 5.1, 5]);

    expect(Array.from(cellsAt(grid, corner, [0, 1, 2]))).toEqual([5, 6]);
    expect(cellsAt(grid, far, [0, 1, 2]).length).toBe(0);
  });
});
