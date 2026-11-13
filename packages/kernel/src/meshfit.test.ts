import { describe, expect, it } from "vitest";
import { fitMesh, type Primitive } from "./meshfit.js";

/** Closed triangle mesh of a solid of revolution with the given radius profile r(z), as corner triples. */
function lathe(profile: [number, number][], segments = 48): number[] {
  const out: number[] = [];

  const ring = (i: number, k: number): [number, number, number] => {
    const [z, r] = profile[i]!;
    const a = (2 * Math.PI * k) / segments;

    return [r * Math.cos(a), r * Math.sin(a), z];
  };

  const tri = (...pts: [number, number, number][]) => out.push(...pts.flat());

  for (let i = 0; i + 1 < profile.length; i++) {
    for (let k = 0; k < segments; k++) {
      const a = ring(i, k),
        b = ring(i, k + 1),
        c = ring(i + 1, k + 1),
        d = ring(i + 1, k);
      if (profile[i]![1] > 0) tri(a, b, c);
      if (profile[i + 1]![1] > 0) tri(a, c, d);
    }
  }

  return out;
}

const kinds = (fit: ReturnType<typeof fitMesh>) =>
  fit.regions.map((r) => r.primitive?.kind ?? "facet").sort();
const of = <K extends Primitive["kind"]>(fit: ReturnType<typeof fitMesh>, kind: K) =>
  fit.regions.map((r) => r.primitive).filter((p): p is Extract<Primitive, { kind: K }> => p?.kind === kind);

describe("fitMesh", () => {
  it("recognises the caps and the wall of a cylinder", () => {
    // Bottom cap (r 0 → 5 at z 0), wall, top cap (r 5 → 0 at z 10).
    const fit = fitMesh(
      lathe([
        [0, 0],
        [0, 5],
        [10, 5],
        [10, 0],
      ]),
    );
    expect(kinds(fit)).toEqual(["cylinder", "plane", "plane"]);

    const cyl = of(fit, "cylinder")[0]!;
    expect(cyl.radius).toBeCloseTo(5, 6);
    expect(Math.abs(cyl.axis[2])).toBeCloseTo(1, 6);
    expect(Math.hypot(cyl.origin[0], cyl.origin[1])).toBeLessThan(1e-6);
    expect(fit.volume).toBeCloseTo(
      Math.PI * 25 * 10 * (48 / (2 * Math.PI)) * Math.sin((2 * Math.PI) / 48),
      6,
    );

    // The wall is bounded by two closed circles, the caps by one each.
    const wall = fit.regions.find((r) => r.primitive?.kind === "cylinder")!;
    expect(wall.loops).toHaveLength(2);
    expect(wall.loops.every((l) => l.length === 1 && fit.segments[l[0]!.segment]!.closed)).toBe(true);
    expect(fit.segments).toHaveLength(2);
  });

  it("recognises a cone and the chamfer-like transition of a pin", () => {
    // Shaft r 5 from z 0..10, then a 45° chamfer to r 3 at z 12, then the flat tip.
    const fit = fitMesh(
      lathe([
        [0, 0],
        [0, 5],
        [10, 5],
        [12, 3],
        [12, 0],
      ]),
    );
    expect(kinds(fit)).toEqual(["cone", "cylinder", "plane", "plane"]);

    const cone = of(fit, "cone")[0]!;
    expect((cone.halfAngle * 180) / Math.PI).toBeCloseTo(45, 3);
    expect(cone.apex[2]).toBeCloseTo(15, 4);
  });

  it("recognises a sphere", () => {
    const profile: [number, number][] = [];

    for (let i = 0; i <= 24; i++) {
      const a = Math.PI * (i / 24);
      profile.push([8 - 8 * Math.cos(a), 8 * Math.sin(a)]);
    }

    const fit = fitMesh(lathe(profile, 48));
    expect(kinds(fit)).toEqual(["sphere"]);

    const s = of(fit, "sphere")[0]!;
    expect(s.radius).toBeCloseTo(8, 6);
    expect(s.center[2]).toBeCloseTo(8, 6);
    expect(fit.regions[0]!.loops).toHaveLength(0);
  });

  it("keeps a flat box as six planes with twelve straight edges", () => {
    const c = (x: number, y: number, z: number): [number, number, number] => [x, y, z];
    const quad = (
      a: [number, number, number],
      b: [number, number, number],
      d: [number, number, number],
      e: [number, number, number],
    ) => [...a, ...b, ...d, ...a, ...d, ...e];
    const p = [
      c(0, 0, 0),
      c(20, 0, 0),
      c(20, 10, 0),
      c(0, 10, 0),
      c(0, 0, 5),
      c(20, 0, 5),
      c(20, 10, 5),
      c(0, 10, 5),
    ] as const;
    const corners = [
      ...quad(p[0], p[3], p[2], p[1]),
      ...quad(p[4], p[5], p[6], p[7]),
      ...quad(p[0], p[1], p[5], p[4]),
      ...quad(p[1], p[2], p[6], p[5]),
      ...quad(p[2], p[3], p[7], p[6]),
      ...quad(p[3], p[0], p[4], p[7]),
    ];
    const fit = fitMesh(corners);
    expect(kinds(fit)).toEqual(["plane", "plane", "plane", "plane", "plane", "plane"]);
    expect(fit.volume).toBeCloseTo(1000, 9);
    expect(fit.segments).toHaveLength(12);
    expect(fit.segments.every((s) => s.vertices.length === 2)).toBe(true);
  });
});

describe("turning surfaces back into facets", () => {
  it("demotes the wall of a cylinder to one facet per triangle, keeping the area and the caps", async () => {
    const { demoteRegions } = await import("./meshfit.js");
    const fit = fitMesh(
      lathe([
        [0, 0],
        [0, 5],
        [10, 5],
        [10, 0],
      ]),
    );
    const wall = fit.regions.find((r) => r.primitive?.kind === "cylinder")!;
    const out = demoteRegions(fit, [wall.index]);
    expect(out.regions.filter((r) => r.primitive?.kind === "plane")).toHaveLength(2);
    expect(out.regions.filter((r) => r.primitive === null)).toHaveLength(wall.triangles.length);

    const area = (f: typeof fit) => f.regions.reduce((s, r) => s + r.area, 0);
    expect(area(out)).toBeCloseTo(area(fit), 9);
    // Every triangle still belongs to exactly one region.
    expect([...out.triangleRegion].every((r) => r >= 0)).toBe(true);
    // Nothing named: the fit stays as it was.
    expect(demoteRegions(fit, []).regions.map((r) => r.primitive?.kind)).toEqual(
      fit.regions.map((r) => r.primitive?.kind),
    );
  });

  it("keeps a triangle of no area, adding nothing to the surface", () => {
    const box = lathe(
      [
        [0, 0],
        [0, 5],
        [10, 5],
        [10, 0],
      ],
      8,
    );
    const plain = fitMesh(box);
    // A sliver on the top cap through its centre: (5, 0), (0, 0) and (−5, 0), all corners already there.
    const fit = fitMesh([...box, 5, 0, 10, 0, 0, 10, -5, 0, 10]);
    expect(fit.regions.reduce((s, r) => s + r.triangles.length, 0)).toBe(box.length / 9 + 1);
    // It belongs to a region like every other triangle, and adds nothing to the area or the volume.
    expect([...fit.triangleRegion].every((r) => r >= 0)).toBe(true);

    const area = (f: typeof fit) => f.regions.reduce((s, r) => s + r.area, 0);
    expect(area(fit)).toBeCloseTo(area(plain), 9);
    expect(fit.volume).toBeCloseTo(plain.volume, 9);
  });
});
