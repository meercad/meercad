/**
 * Making a topology suggestion lighter (strengthFinish.ts): a skin over the budget comes back with
 * fewer triangles and nearly the same volume, one within it untouched.
 */
import { meshVolume } from "@meercad/io";
import { describe, expect, it } from "vitest";
import { lightTopology, TOPOLOGY_TRIANGLES } from "./strengthFinish";

/** A ball of radius 10 as a grid of triangles. */
function ball(rings: number): { positions: Float32Array; indices: Uint32Array } {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= rings; i++) {
    for (let j = 0; j < 2 * rings; j++) {
      const theta = (Math.PI * i) / rings;
      const phi = (Math.PI * j) / rings;

      positions.push(
        10 * Math.sin(theta) * Math.cos(phi),
        10 * Math.sin(theta) * Math.sin(phi),
        10 * Math.cos(theta),
      );
    }
  }

  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < 2 * rings; j++) {
      const a = i * 2 * rings + j;
      const b = i * 2 * rings + ((j + 1) % (2 * rings));

      if (i > 0) indices.push(a, a + 2 * rings, b);
      if (i < rings - 1) indices.push(b, a + 2 * rings, b + 2 * rings);
    }
  }

  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) };
}

const volume = (mesh: { positions: Float32Array; indices: Uint32Array }) => {
  const corners = new Float32Array(mesh.indices.length * 3);

  mesh.indices.forEach((vertex, k) =>
    corners.set(mesh.positions.subarray(vertex * 3, vertex * 3 + 3), k * 3),
  );

  return Math.abs(meshVolume(corners));
};

describe("a lighter suggestion", () => {
  it("has fewer triangles and nearly the same volume when over the budget", () => {
    const fine = ball(40);
    const light = lightTopology(fine, 2500);

    expect(fine.indices.length / 3).toBeGreaterThan(6000);
    expect(light.indices.length / 3).toBeLessThanOrEqual(2500);
    expect(volume(light) / volume(fine)).toBeGreaterThan(0.97);
  });

  it("is left alone within the budget", () => {
    const fine = ball(12);

    expect(lightTopology(fine)).toBe(fine);
    expect(TOPOLOGY_TRIANGLES).toBe(100000);
  });
});
