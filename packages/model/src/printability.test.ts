import { describe, expect, it } from "vitest";
import { MeshCollider, rayDistance } from "./collide.js";
import { printCheck, rankOrientations, supportDetails, SURFACE_OVERHANG, SURFACE_PLATE, turnPoint, turnsToLay } from "./printability.js";

/** A box from `lo` to `hi` as an outward-facing triangle mesh, appended to `m`. */
function box(m: { p: number[]; i: number[] }, lo: number[], hi: number[], inward = false) {
  const base = m.p.length / 3;
  for (let k = 0; k < 8; k++) m.p.push(k & 1 ? hi[0]! : lo[0]!, k & 2 ? hi[1]! : lo[1]!, k & 4 ? hi[2]! : lo[2]!);
  // Each face as two triangles, counter-clockwise seen from outside.
  const quads = [
    [0, 2, 3, 1], // -Z
    [4, 5, 7, 6], // +Z
    [0, 1, 5, 4], // -Y
    [2, 6, 7, 3], // +Y
    [0, 4, 6, 2], // -X
    [1, 3, 7, 5], // +X
  ];
  for (const [a, b, c, d] of quads) {
    const tris = [[a, b, c], [a, c, d]];
    for (const t of tris) m.i.push(...(inward ? [t[0]!, t[2]!, t[1]!] : t).map((v) => base + v!));
  }
  return m;
}

const mesh = () => ({ p: [] as number[], i: [] as number[] });

describe("printCheck", () => {
  it("finds nothing to support on a cube, its bottom on the plate", () => {
    const m = box(mesh(), [0, 0, 0], [10, 10, 10]);
    const c = printCheck(m.p, m.i);
    expect(c.overhangArea).toBe(0);
    expect(c.supportVolume).toBe(0);
    expect(c.plateArea).toBeCloseTo(100);
    expect(c.area).toBeCloseTo(600);
    expect(c.height).toBeCloseTo(10);
    expect([...c.kind].filter((k) => k === SURFACE_PLATE)).toHaveLength(2);
  });

  it("marks the underside of a cap as overhang, with its support volume", () => {
    // A mushroom: stem 4×4×10, cap 20×20×2 on top.
    const m = box(box(mesh(), [8, 8, 0], [12, 12, 10]), [0, 0, 10], [20, 20, 12]);
    const c = printCheck(m.p, m.i);
    expect(c.overhangArea).toBeCloseTo(400);
    expect(c.supportVolume).toBeCloseTo(4000);
    expect(c.plateArea).toBeCloseTo(16);
    expect([...c.kind].filter((k) => k === SURFACE_OVERHANG)).toHaveLength(2);
  });

  it("treats an inside-out mesh the same", () => {
    const m = box(box(mesh(), [8, 8, 0], [12, 12, 10], true), [0, 0, 10], [20, 20, 12], true);
    expect(printCheck(m.p, m.i).overhangArea).toBeCloseTo(400);
  });

  it("lets slopes up to the limit print without support", () => {
    // A wedge leaning out at 40° and at 50° from vertical (its sloped underside).
    const wedge = (deg: number) => {
      const w = 10 * Math.tan((deg * Math.PI) / 180);
      // Triangle prism: (0,0) (w,10) (0,10) in x-z, extruded 5 along y; the underside runs from
      // (0,0) to (w,10) and faces down and out.
      const p = [0, 0, 0, w, 0, 10, 0, 0, 10, 0, 5, 0, w, 5, 10, 0, 5, 10];
      const i = [0, 2, 1, 3, 4, 5, 0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4, 2, 0, 3, 2, 3, 5];
      return printCheck(p, i);
    };
    expect(wedge(40).overhangArea).toBe(0);
    expect(wedge(50).overhangArea).toBeGreaterThan(0);
  });
});

describe("rankOrientations", () => {
  it("prints a mushroom upside down", () => {
    const m = box(box(mesh(), [8, 8, 0], [12, 12, 10]), [0, 0, 10], [20, 20, 12]);
    const [best] = rankOrientations(m.p, m.i);
    expect(best!.down[2]).toBeCloseTo(1);
    expect(best!.check.plateArea).toBeCloseTo(400);
  });

  it("lays a tilted plate flat", () => {
    // A 40×20×2 plate turned 30° about X: its big face is the best bottom.
    const m = box(mesh(), [0, 0, 0], [40, 20, 2]);
    const a = (30 * Math.PI) / 180;
    for (let k = 0; k < m.p.length; k += 3) {
      const y = m.p[k + 1]!, z = m.p[k + 2]!;
      m.p[k + 1] = y * Math.cos(a) - z * Math.sin(a);
      m.p[k + 2] = y * Math.sin(a) + z * Math.cos(a);
    }
    const [best] = rankOrientations(m.p, m.i);
    expect(best!.check.supportVolume).toBeCloseTo(0);
    expect(best!.check.plateArea).toBeCloseTo(800);
  });
});

describe("turnsToLay", () => {
  it("brings any direction down onto -Z", () => {
    const dirs: [number, number, number][] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [0, -1, 0], [0.3, -0.5, 0.8], [-0.7, 0.1, -0.2], [0, 0.6, -0.8]];
    for (const d of dirs) {
      const l = Math.hypot(...d);
      const { aboutZ, aboutX } = turnsToLay(d);
      const p = turnPoint([d[0] / l, d[1] / l, d[2] / l], aboutZ, aboutX);
      expect(p[0]).toBeCloseTo(0, 6);
      expect(p[1]).toBeCloseTo(0, 6);
      expect(p[2]).toBeCloseTo(-1, 6);
    }
    expect(turnsToLay([0, 0, -1])).toEqual({ aboutZ: 0, aboutX: 0 });
  });
});

describe("supportDetails", () => {
  const details = (m: { p: number[]; i: number[] }, down: [number, number, number] = [0, 0, -1]) => {
    const c = new MeshCollider(m.p, m.i);
    return supportDetails(m.p, m.i, printCheck(m.p, m.i, down), down, (o, d) => rayDistance(c, o, d, 1e-6));
  };
  it("the ceiling of a closed cavity is inside and stands on the part", () => {
    const m = box(box(mesh(), [0, 0, 0], [20, 20, 20]), [5, 5, 5], [15, 15, 15], true);
    const r = details(m);
    expect(r.outsideMm2).toBe(0);
    expect(r.insideMm2).toBeCloseTo(100, 6);
    expect(r.onPartMm2).toBeCloseTo(100, 6);
    expect(r.flattestDeg).toBeCloseTo(0, 6);
    expect(r.regions).toHaveLength(1);
    expect(r.regions[0]!.outside).toBe(false);
    expect(r.regions[0]!.spanMm).toBeCloseTo(Math.hypot(10, 10), 6);
  });
  it("a plate held up in the air is outside, its support on the plate", () => {
    const m = box(box(mesh(), [0, 0, 0], [2, 2, 2]), [10, 0, 10], [40, 10, 12]);
    const r = details(m);
    expect(r.outsideMm2).toBeCloseTo(300, 6);
    expect(r.insideMm2).toBe(0);
    expect(r.onPartMm2).toBe(0);
    expect(r.regions[0]!.areaMm2).toBeCloseTo(300, 6);
    expect(r.regions[0]!.outside).toBe(true);
  });
  it("turned the other way the cube's top lies on the plate and nothing hangs over", () => {
    const m = box(mesh(), [0, 0, 0], [10, 10, 10]);
    const r = details(m, [0, 0, 1]);
    expect(r.regions).toEqual([]);
    expect(r.flattestDeg).toBeNull();
  });
});
