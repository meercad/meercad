import { describe, expect, it } from "vitest";
import { weldClosed } from "./bend.js";
import { heightFieldSolid, planScanBin } from "./scanbin.js";
import { GRIDFINITY as G } from "./gridfinity.js";

/** Corners of a closed box x0..x1, y0..y1, z0..z1, wound outwards. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return idx.flatMap((i) => p[i]!);
}

/** Signed volume of a closed triangle solid (positive when wound outwards). */
function volume(c: ArrayLike<number>): number {
  let v = 0;
  for (let i = 0; i < c.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = Array.from({ length: 9 }, (_, k) => c[i + k]!);
    v += (ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!)) / 6;
  }
  return v;
}

describe("scan bins", () => {
  it("closes a height field into a solid wound outwards", () => {
    const nx = 7, ny = 5;
    const f = new Float64Array(nx * ny).fill(10);
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) f[j * nx + i] = 4;
    const s = heightFieldSolid(f, nx, ny, 0, 0, 1, 12);
    expect(() => weldClosed(s, 1e-5)).not.toThrow();
    expect(volume(s)).toBeGreaterThan(0);
  });

  it("sizes the bin round a box, long side along x, sinking it half way with play", () => {
    // 60 × 20 × 10 block lying along y.
    const plan = planScanBin({ corners: box(0, 0, 3, 20, 60, 13), sink: 0.5, clearance: 0.5, grip: false });
    expect(plan.units).toEqual([2, 1]);
    expect(Math.abs(Math.sin(plan.angle))).toBeCloseTo(1, 6);
    expect(plan.rim).toBeCloseTo(8, 6);
    expect(plan.depth).toBeCloseTo(5.5, 6);
    // 4.75 feet + 1.5 floor + 5.5 deep = 11.75 → 2 units.
    expect(plan.height).toBe(2);
    expect(() => weldClosed(plan.tool, 1e-5)).not.toThrow();
    // The nest holds the block's lower half with its play (the tool also reaches 2 mm above the rim).
    const H = plan.height * G.unit;
    let lo = Infinity;
    for (let i = 2; i < plan.tool.length; i += 3) lo = Math.min(lo, plan.tool[i]!);
    expect(lo).toBeCloseTo(H - 5.5, 3);
    expect(volume(plan.tool)).toBeGreaterThan(60 * 20 * 5);
  });

  it("makes room for the finger grip", () => {
    const plan = planScanBin({ corners: box(0, 0, 0, 60, 20, 10), sink: 0.5, clearance: 0.5, grip: true });
    expect(plan.units).toEqual([2, 2]);
    expect(plan.grip!.y1 - plan.grip!.y0).toBeGreaterThan(20 + 2 * 10);
  });

  it("refuses a bin too small for the part", () => {
    expect(() => planScanBin({ corners: box(0, 0, 0, 60, 20, 10), sink: 0.5, clearance: 0.5, grip: false, units: [1, 1] })).toThrow(/at least 2 × 1/);
  });
});
