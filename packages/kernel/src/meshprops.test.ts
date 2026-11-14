import { describe, expect, it } from "vitest";
import { meshProps } from "./mesh.js";

/** A box from (x0, y0, z0) of size a × b × c as 12 triangles wound outwards. */
function box(
  x0: number,
  y0: number,
  z0: number,
  a: number,
  b: number,
  c: number,
  inward = false,
): Float32Array {
  const v = [
    [0, 0, 0],
    [a, 0, 0],
    [a, b, 0],
    [0, b, 0],
    [0, 0, c],
    [a, 0, c],
    [a, b, c],
    [0, b, c],
  ].map(([x, y, z]) => [x! + x0, y! + y0, z! + z0]);
  const f = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];

  return Float32Array.from(f.flatMap((t) => (inward ? [t[0]!, t[2]!, t[1]!] : t).flatMap((i) => v[i]!)));
}

describe("mesh properties", () => {
  it("a 10 × 20 × 30 box away from the origin: volume, area, centre and moments", () => {
    const p = meshProps(box(5, -7, 3, 10, 20, 30));
    expect(p.volume).toBeCloseTo(6000, 6);
    expect(p.area).toBeCloseTo(2 * (200 + 300 + 600), 6);
    expect(p.centroid!.map((x) => +x.toFixed(9))).toEqual([10, 3, 18]);

    // Ixx = V (b² + c²) / 12 about the centre; no products for a box along the axes.
    const [ixx, iyy, izz, xy, xz, yz] = p.inertia!;
    expect(ixx).toBeCloseTo((6000 * (400 + 900)) / 12, 3);
    expect(iyy).toBeCloseTo((6000 * (100 + 900)) / 12, 3);
    expect(izz).toBeCloseTo((6000 * (100 + 400)) / 12, 3);
    for (const x of [xy, xz, yz]) expect(Math.abs(x!)).toBeLessThan(1e-6);
  });

  it("counts a mesh wound inside out the same", () => {
    const out = meshProps(box(5, -7, 3, 10, 20, 30));
    const inv = meshProps(box(5, -7, 3, 10, 20, 30, true));
    expect(inv.volume).toBeCloseTo(out.volume, 6);
    expect(inv.inertia!.map((x) => +x.toFixed(4))).toEqual(out.inertia!.map((x) => +x.toFixed(4)));
  });
});
