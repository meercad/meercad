/**
 * The skin of a grid of cubes (surface.ts): closed and facing outwards, as large as the cubes when
 * nothing is smoothed, a little rounder and never more than a leash away when it is; pinned cubes
 * keep their corners.
 */
import { describe, expect, it } from "vitest";
import { surfaceMesh } from "./surface.js";
import { boxGrid } from "./testParts.js";

/** Volume inside a closed mesh facing outwards. */
function volume(mesh: { positions: Float32Array; indices: Uint32Array }): number {
  let six = 0;

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) =>
      Array.from(mesh.positions.subarray(mesh.indices[t + k]! * 3, mesh.indices[t + k]! * 3 + 3)),
    );

    six +=
      a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) +
      a![1]! * (b![2]! * c![0]! - b![0]! * c![2]!) +
      a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!);
  }

  return six / 6;
}

describe("the skin of an L of cubes", () => {
  const { grid } = boxGrid([3, 2, 3]);

  // Cut a 2 × 2 × 2 corner out.
  for (const cell of [7, 8, 10, 11, 13, 14, 16, 17]) grid.solid[cell] = 0;

  it("is closed, faces outwards and holds the cubes' volume without smoothing", () => {
    const mesh = surfaceMesh(grid, [], 0);
    const edges = new Map<string, number>();

    for (let t = 0; t < mesh.indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const key = `${mesh.indices[t + k]}>${mesh.indices[t + ((k + 1) % 3)]}`;

        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }

    // Every edge is walked once in each direction.
    for (const [key, count] of edges) expect(edges.get(key.split(">").reverse().join(">"))).toBe(count);

    expect(volume(mesh)).toBeCloseTo(10, 5);
  });

  it("gets rounder when smoothed, each corner staying within its leash", () => {
    const sharp = surfaceMesh(grid, [], 0);
    const smooth = surfaceMesh(grid);

    expect(volume(smooth)).toBeLessThan(10);
    expect(volume(smooth)).toBeGreaterThan(8);
    smooth.positions.forEach((value, i) =>
      expect(Math.abs(value - sharp.positions[i]!)).toBeLessThanOrEqual(0.45 + 1e-6),
    );
  });

  it("leaves the corners of pinned cubes where they are", () => {
    const sharp = surfaceMesh(grid, [], 0);
    const pinned = surfaceMesh(grid, [0]);
    const moved = Array.from({ length: sharp.positions.length / 3 }, (_, v) => v).filter((v) =>
      [0, 1, 2].some((axis) => sharp.positions[v * 3 + axis] !== pinned.positions[v * 3 + axis]),
    );
    const corner = (v: number) => Array.from(sharp.positions.subarray(v * 3, v * 3 + 3));

    expect(moved.length).toBeGreaterThan(0);
    for (const v of moved) expect(corner(v).some((value) => value > 1)).toBe(true);
  });
});
