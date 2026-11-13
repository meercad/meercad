import { describe, expect, it } from "vitest";
import { withinBudget } from "../apps/web/src/lib/importBudget";

/** A closed UV sphere of radius 10 with about 4·n² triangles. */
function sphere(n: number) {
  const p: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j < 2 * n; j++) {
      const th = (Math.PI * i) / n, ph = (Math.PI * j) / n;
      p.push(10 * Math.sin(th) * Math.cos(ph), 10 * Math.sin(th) * Math.sin(ph), 10 * Math.cos(th));
    }
  const w = 2 * n;
  for (let i = 0; i < n; i++)
    for (let j = 0; j < w; j++) {
      const a = i * w + j, b = i * w + ((j + 1) % w);
      if (i > 0) idx.push(a, a + w, b);
      if (i < n - 1) idx.push(b, a + w, b + w);
    }
  return { positions: Float32Array.from(p), indices: Uint32Array.from(idx) };
}

describe("import triangle budget", () => {
  it("leaves meshes within the budget as they are", () => {
    const s = sphere(20);
    const r = withinBudget([s], 10_000);
    expect(r.lightened).toEqual([]);
    expect(r.meshes[0]).toBe(s);
  });

  it("makes the fine meshes lighter, each to its share, and keeps their shape", () => {
    const fine = sphere(120); // 57,360 triangles
    const coarse = sphere(20); // 1,560
    const r = withinBudget([fine, coarse], 20_000);
    expect(r.lightened.map((l) => l.index)).toEqual([0]);
    expect(r.lightened[0]!.from).toBe(fine.indices.length / 3);
    expect(r.meshes[0]!.indices.length / 3).toBe(r.lightened[0]!.to);
    // About its share of the budget (a few collapses may be refused near the end).
    expect(r.lightened[0]!.to).toBeLessThan(1.01 * ((57_360 * 20_000) / 58_920));
    expect(r.lightened[0]!.to).toBeGreaterThan(0.95 * ((57_360 * 20_000) / 58_920));
    // Under the 2,000 floor nothing is reduced; the coarse one stays the very same mesh.
    expect(r.meshes[1]).toBe(coarse);
    // Still a sphere of radius 10.
    const p = r.meshes[0]!.positions;
    for (let k = 0; k < p.length; k += 3) expect(Math.hypot(p[k]!, p[k + 1]!, p[k + 2]!)).toBeCloseTo(10, 0);
  });
});
