/**
 * The smooth skin of an optimised part (smooth.ts): a full part comes back as itself, with its faces
 * exactly in place; half a part ends in a smooth cut where the density ends; the skin is closed and
 * faces outwards; a piece that does not hang on a kept cube is dropped.
 */
import { describe, expect, it } from "vitest";
import { smoothSurface } from "./smooth.js";
import { boxGrid, boxMesh } from "./testParts.js";

type Mesh = { positions: Float32Array; indices: Uint32Array };

/** Volume inside a closed mesh facing outwards. */
function volume(mesh: Mesh): number {
  let six = 0;

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      Array.from(mesh.positions.subarray(mesh.indices[t + k]! * 3, mesh.indices[t + k]! * 3 + 3)),
    ) as [number[], number[], number[]];

    six +=
      a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) +
      a[1]! * (b[2]! * c[0]! - b[0]! * c[2]!) +
      a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }

  return six / 6;
}

/** Smallest and largest coordinate along an axis, to a thousandth of a millimetre. */
const range = (mesh: Mesh, axis: number) => {
  const values = mesh.positions.filter((_, i) => i % 3 === axis);

  return [Math.min(...values), Math.max(...values)].map((value) => Math.round(value * 1000) / 1000 + 0);
};

const size: [number, number, number] = [8, 4, 4];
const part = boxMesh(size);
const { grid } = boxGrid(size);

describe("the smooth skin", () => {
  it("of a full part is the part: faces in place, only edges a little rounder", () => {
    const mesh = smoothSurface({
      grid,
      density: new Float32Array(128).fill(1),
      keep: [0],
      ...part,
      share: 1,
    });

    expect(range(mesh, 0)).toEqual([0, 8]);
    expect(range(mesh, 2)).toEqual([0, 4]);
    // The edges are cut by about a quarter of a cube.
    expect(volume(mesh)).toBeGreaterThan(0.88 * 128);
    expect(volume(mesh)).toBeLessThanOrEqual(128 + 1e-6);
  });

  it("is closed and faces outwards", () => {
    const mesh = smoothSurface({
      grid,
      density: new Float32Array(128).fill(1),
      keep: [0],
      ...part,
      share: 1,
    });
    const edges = new Map<string, number>();

    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${mesh.indices[t + k]}>${mesh.indices[t + ((k + 1) % 3)]}`;

        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }

    // Every edge is walked once in each direction.
    for (const [key, count] of edges) expect(edges.get(key.split(">").reverse().join(">"))).toBe(count);
  });

  it("ends where the density ends, with about the wanted share of the volume", () => {
    const density = Float32Array.from({ length: 128 }, (_, cell) => (cell % 8 < 4 ? 1 : 0));
    const mesh = smoothSurface({ grid, density, keep: [0], ...part, share: 0.5 });

    expect(range(mesh, 0)[0]).toBe(0);
    expect(range(mesh, 0)[1]).toBeGreaterThan(3.5);
    expect(range(mesh, 0)[1]).toBeLessThan(4.5);
    expect(volume(mesh) / 128).toBeGreaterThan(0.42);
    expect(volume(mesh) / 128).toBeLessThan(0.55);
  });

  it("drops a piece that does not hang on a kept cube, and reads finer when asked", () => {
    // Material in the first two and the last two layers along x, kept only at the start.
    const density = Float32Array.from({ length: 128 }, (_, cell) => (cell % 8 < 2 || cell % 8 > 5 ? 1 : 0));
    const both = smoothSurface({ grid, density, keep: [0, 7], ...part, share: 0.5 });
    const one = smoothSurface({ grid, density, keep: [0], ...part, share: 0.5, fine: 3 });

    expect(range(both, 0)).toEqual([0, 8]);
    expect(range(one, 0)[1]).toBeLessThan(3);
    expect(volume(one)).toBeLessThan(0.6 * volume(both));
  });

  it("follows a part that does not fill its grid", () => {
    const holed = {
      ...grid,
      solid: Uint8Array.from(grid.solid, (solid, cell) => (cell % 8 === 7 ? 0 : solid)),
    };
    const shorter = boxMesh([7, 4, 4]);
    const mesh = smoothSurface({
      grid: holed,
      density: new Float32Array(128).fill(1),
      keep: [0],
      ...shorter,
      share: 1,
    });

    expect(range(mesh, 0)).toEqual([0, 7]);
  });
});
