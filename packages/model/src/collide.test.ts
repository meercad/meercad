import { describe, expect, it } from "vitest";
import { MeshCollider, meshesCollide, trianglesCross } from "./collide.js";
import { rotationAbout, translation } from "./motion.js";

/** An axis-aligned box as 12 triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): MeshCollider {
  const p = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return new MeshCollider(p, f);
}

/** A finely tessellated sphere (UV), for speed. */
function sphere(r: number, n: number): MeshCollider {
  const p: number[] = [];
  const f: number[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= 2 * n; j++) {
      const th = (Math.PI * i) / n;
      const ph = (Math.PI * j) / n;
      p.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  const w = 2 * n + 1;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < 2 * n; j++) {
      const a = i * w + j;
      f.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
    }
  return new MeshCollider(p, f);
}

describe("mesh collisions", () => {
  it("finds boxes that run into each other, not those apart or resting on each other", () => {
    const a = box(0, 0, 0, 10, 10, 10);
    expect(meshesCollide(a, box(5, 5, 5, 15, 15, 15))).toBe(true);
    expect(meshesCollide(a, box(11, 0, 0, 20, 10, 10))).toBe(false);
    // Flush on a face: resting, not colliding.
    expect(meshesCollide(a, box(10, 0, 0, 20, 10, 10))).toBe(false);
    // Two plates of the same thickness pushed into each other: their faces meet only at edges.
    expect(meshesCollide(box(0, 0, 0, 10, 10, 2), box(5, 2, 0, 15, 8, 2))).toBe(true);
  });

  it("places the meshes by their poses", () => {
    const a = box(0, 0, 0, 10, 10, 10);
    const b = box(20, 0, 0, 30, 10, 10);
    expect(meshesCollide(a, b)).toBe(false);
    expect(meshesCollide(a, b, undefined, translation([-15, 0, 0]))).toBe(true);
    expect(meshesCollide(a, b, translation([15, 0, 0]))).toBe(true);
    // Turned 90° about z through the origin, b lands at y 20…30: apart again.
    expect(meshesCollide(a, b, undefined, rotationAbout([0, 0, 0], [0, 0, 1], 90))).toBe(false);
    // A bar turned about its end sweeps into the block beside it.
    const bar = box(0, -1, 0, 30, 1, 5);
    const block = box(10, 8, 0, 20, 18, 5);
    expect(meshesCollide(bar, block)).toBe(false);
    expect(meshesCollide(bar, block, rotationAbout([0, 0, 0], [0, 0, 1], 40))).toBe(true);
  });

  it("tells crossing triangles from touching ones", () => {
    expect(trianglesCross([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0.5, 0.5, -1], [0.5, 0.5, 1], [1.5, 0.5, 0]])).toBe(true);
    expect(trianglesCross([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[3, 3, -1], [3, 3, 1], [4, 3, 0]])).toBe(false);
    // Sharing an edge only.
    expect(trianglesCross([[0, 0, 0], [2, 0, 0], [0, 2, 0]], [[0, 0, 0], [2, 0, 0], [1, 0, 2]])).toBe(false);
  });

  it("tests large meshes quickly", () => {
    const a = sphere(10, 80);
    const b = sphere(10, 80);
    expect(a.triangles).toBeGreaterThan(25000);
    const t0 = performance.now();
    expect(meshesCollide(a, b, undefined, translation([25, 0, 0]))).toBe(false);
    expect(meshesCollide(a, b, undefined, translation([19, 0, 0]))).toBe(true);
    expect(meshesCollide(a, b, undefined, translation([20.5, 0, 0]))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
