/**
 * The smooth skin of an optimised part (smooth.ts) on a box of 12 × 8 × 8 cubes: where the part is
 * held or pushed its faces stay exactly in place, sharp edges and all; elsewhere the skin is
 * rounded (large faces stay put, edges and corners become soft) and never leaves the part; half a
 * part ends in a round end where the density ends; the skin is closed and faces outwards; a piece
 * that does not hang on a kept cube is dropped.
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

const size: [number, number, number] = [12, 8, 8];
const cells = 12 * 8 * 8;
const part = boxMesh(size);
const { grid } = boxGrid(size);
/** The cubes at the two ends of the box along x: kept whole, as where a part is held and pushed. */
const start = Array.from({ length: 64 }, (_, k) => k * 12);
const end = start.map((cell) => cell + 11);
const full = new Float32Array(cells).fill(1);

describe("the smooth skin of a full part", () => {
  const mesh = smoothSurface({ grid, density: full, keep: start, ...part, share: 1 });

  it("keeps the face it is held at exactly in its plane, out to near its edges", () => {
    const onFace = Array.from({ length: mesh.positions.length / 3 }, (_, corner) => corner).filter(
      (corner) => Math.abs(mesh.positions[corner * 3]!) < 1e-4,
    );
    const ys = onFace.map((corner) => mesh.positions[corner * 3 + 1]!);

    expect(range(mesh, 0)[0]).toBe(0);
    expect(onFace.length).toBeGreaterThan(120);
    expect(Math.min(...ys)).toBeLessThan(0.8);
    expect(Math.max(...ys)).toBeGreaterThan(7.2);
  });

  it("rounds the other end: its face about in place, its corners gone, nothing outside the part", () => {
    expect(range(mesh, 0)[1]).toBeGreaterThan(11.8);
    expect(range(mesh, 0)[1]).toBeLessThanOrEqual(12);
    expect(range(mesh, 1)[0]).toBeGreaterThanOrEqual(0);
    expect(range(mesh, 1)[0]).toBeLessThan(0.1);
    expect(range(mesh, 1)[1]).toBeGreaterThan(7.9);
    expect(range(mesh, 1)[1]).toBeLessThanOrEqual(8);
    // No corner of the skin within a third of a cube of the box's far corner.
    expect(
      Array.from({ length: mesh.positions.length / 3 }, (_, corner) =>
        Math.hypot(
          mesh.positions[corner * 3]! - 12,
          mesh.positions[corner * 3 + 1]! - 8,
          mesh.positions[corner * 3 + 2]! - 8,
        ),
      ).every((distance) => distance > 1 / 3),
    ).toBe(true);
    // The box's twelve edges are rounded over more than a cube.
    expect(volume(mesh) / cells).toBeGreaterThan(0.84);
    expect(volume(mesh) / cells).toBeLessThan(0.995);
  });

  it("is closed and faces outwards", () => {
    const edges = new Map<string, number>();

    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${mesh.indices[t + k]}>${mesh.indices[t + ((k + 1) % 3)]}`;

        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }

    // Every edge is walked once in each direction.
    for (const [key, count] of edges) expect(edges.get(key.split(">").reverse().join(">"))).toBe(count);

    expect(volume(mesh)).toBeGreaterThan(0);
  });
});

describe("the smooth skin of a part with less material", () => {
  it("ends where the density ends, with about the wanted share of the volume", () => {
    const density = Float32Array.from({ length: cells }, (_, cell) => (cell % 12 < 6 ? 1 : 0));
    const mesh = smoothSurface({ grid, density, keep: start, ...part, share: 0.5 });

    expect(range(mesh, 0)[0]).toBe(0);
    expect(range(mesh, 0)[1]).toBeGreaterThan(5.4);
    expect(range(mesh, 0)[1]).toBeLessThan(6.8);
    expect(volume(mesh) / cells).toBeGreaterThan(0.4);
    expect(volume(mesh) / cells).toBeLessThan(0.52);
  });

  it("drops a piece that does not hang on a kept cube, and reads finer when asked", () => {
    // Material in the first three and the last three layers along x.
    const density = Float32Array.from({ length: cells }, (_, cell) =>
      cell % 12 < 3 || cell % 12 > 8 ? 1 : 0,
    );
    const both = smoothSurface({ grid, density, keep: [...start, ...end], ...part, share: 0.5 });
    const one = smoothSurface({ grid, density, keep: start, ...part, share: 0.5, fine: 3 });

    expect(range(both, 0)).toEqual([0, 12]);
    expect(range(one, 0)[1]).toBeLessThan(4);
    expect(volume(one)).toBeLessThan(0.6 * volume(both));
  });

  it("keeps everything when no kept cube has material left to hang on", () => {
    // One kept cube in a corner of an otherwise empty part: rounded away, with nothing to compare to.
    const density = new Float32Array(cells);
    const mesh = smoothSurface({ grid, density, keep: [0], ...part, share: 0.01 });

    expect(mesh.indices.length % 3).toBe(0);
  });

  it("follows a part that does not fill its grid", () => {
    const holed = {
      ...grid,
      solid: Uint8Array.from(grid.solid, (solid, cell) => (cell % 12 === 11 ? 0 : solid)),
    };
    const shorter = boxMesh([11, 8, 8]);
    const mesh = smoothSurface({ grid: holed, density: full, keep: start, ...shorter, share: 1 });

    expect(range(mesh, 0)[0]).toBe(0);
    expect(range(mesh, 0)[1]).toBeGreaterThan(10.8);
    expect(range(mesh, 0)[1]).toBeLessThanOrEqual(11);
  });
});

describe("rounding", () => {
  it("can be left out: the skin then keeps the part's own edges nearly sharp", () => {
    const rounded = smoothSurface({ grid, density: full, keep: start, ...part, share: 1 });
    const sharp = smoothSurface({ grid, density: full, keep: start, ...part, share: 1, rounding: 0 });

    expect(volume(sharp)).toBeGreaterThan(volume(rounded));
    expect(volume(sharp) / cells).toBeGreaterThan(0.95);
  });
});
