import { describe, expect, it } from "vitest";
import { exportMeshes, type RebuildReport } from "@meercad/kernel";
import type { LithophaneFeature, TextureImage } from "@meercad/schema";
import { doc, getOcct, newSession } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

/**
 * A 64 × 48 test picture: dark on the left, bright on the right, and a bright square in the top
 * left corner, so a wrong way round or upside down shows.
 */
function picture(): TextureImage {
  const w = 64, h = 48;
  let bin = "";
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) bin += String.fromCharCode(x < 8 && y < 8 ? 255 : Math.round((x / (w - 1)) * 255));
  return { width: w, height: h, pixels: btoa(bin) };
}

/** Every edge (by position) used by exactly two triangles, once in each direction. */
function closedManifold(positions: Float32Array, indices: ArrayLike<number>): { open: number; bad: number } {
  const id = new Map<string, number>();
  const weld = (i: number) => {
    const key = `${positions[i * 3]!.toFixed(4)},${positions[i * 3 + 1]!.toFixed(4)},${positions[i * 3 + 2]!.toFixed(4)}`;
    let w = id.get(key);
    if (w === undefined) id.set(key, (w = id.size));
    return w;
  };
  const directed = new Map<number, number>();
  const ws = Array.from({ length: positions.length / 3 }, (_, i) => weld(i));
  for (let t = 0; t < indices.length; t += 3) {
    const c = [ws[indices[t]!]!, ws[indices[t + 1]!]!, ws[indices[t + 2]!]!];
    for (let k = 0; k < 3; k++) {
      const key = c[k]! * 4194304 + c[(k + 1) % 3]!;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0, bad = 0;
  for (const [key, n] of directed) {
    const a = Math.floor(key / 4194304), b = key % 4194304;
    if (n !== 1) bad++;
    if (directed.get(b * 4194304 + a) !== 1) open++;
  }
  return { open, bad };
}

/** Highest value of `f` over the corners in a box (x, y ranges). */
function topIn(m: { positions: Float32Array }, x0: number, x1: number, y0: number, y1: number, f: (p: number[]) => number): number {
  let best = -Infinity;
  for (let i = 0; i < m.positions.length; i += 3) {
    const p = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
    if (p[0]! >= x0 && p[0]! <= x1 && p[1]! >= y0 && p[1]! <= y1) best = Math.max(best, f(p));
  }
  return best;
}

const litho = (extra: Partial<LithophaneFeature> = {}): LithophaneFeature => ({ id: "li1", op: "lithophane", image: picture(), width: 80, ...extra });

describe("lithophane", () => {
  it("makes a flat lithophane: dark thick, bright thin, the right way round, closed", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([litho()]));
    ok(r.report);
    const body = r.report.bodies[0]!;
    // The solid is the plain plate at the thinnest thickness: 80 × 60 × 0.8.
    expect(body.volume).toBeCloseTo(80 * 60 * 0.8, 1);
    const m = r.meshes[0]!;
    expect(m.textured).toBe(true);
    expect(closedManifold(m.positions, m.indices)).toEqual({ open: 0, bad: 0 });
    const z = (p: number[]) => p[2]!;
    // Left (dark) 0.8 + 2.2, right (bright) 0.8; the bright corner is at the top left (+y).
    expect(topIn(m, -40, -38.5, -29, 10, z)).toBeCloseTo(3, 1);
    expect(topIn(m, 32, 39, -20, 20, z)).toBeLessThan(1.1);
    expect(topIn(m, -39, -33, 24, 29, z)).toBeLessThan(1.1);
    expect(topIn(m, -39, -33, -29, -24, z)).toBeGreaterThan(2.6);
  });

  it("makes a relief: bright high, and swaps with invert", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([litho({ kind: "relief", thickness: 2, depth: 1 })]));
    ok(r.report);
    const z = (p: number[]) => p[2]!;
    expect(topIn(r.meshes[0]!, 32, 39, -20, 20, z)).toBeCloseTo(3, 1);
    expect(topIn(r.meshes[0]!, -39, -36, -20, 10, z)).toBeLessThan(2.2);
    const inv = (await newSession()).rebuild(doc([litho({ kind: "relief", thickness: 2, depth: 1, invert: true })]));
    expect(topIn(inv.meshes[0]!, -39, -36, -20, 10, z)).toBeCloseTo(3, 1);
  });

  it("keeps a frame at the full thickness round the picture", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([litho({ frame: 4 })]));
    ok(r.report);
    const b = r.report.bodies[0]!;
    // 88 × 68 × 3 with an 80 × 60 recess 2.2 deep.
    expect(b.volume).toBeCloseTo(88 * 68 * 3 - 80 * 60 * 2.2, 0);
    const m = r.meshes[0]!;
    expect(closedManifold(m.positions, m.indices)).toEqual({ open: 0, bad: 0 });
    const z = (p: number[]) => p[2]!;
    expect(topIn(m, -44, 44, -34, 34, z)).toBeCloseTo(3, 4);
    expect(topIn(m, 32, 39, -20, 20, z)).toBeLessThan(1.1);
  });

  it("bends round: the picture outside, readable from the front", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([litho({ curve: 120 })]));
    ok(r.report);
    const m = r.meshes[0]!;
    expect(closedManifold(m.positions, m.indices)).toEqual({ open: 0, bad: 0 });
    const R = 80 / ((120 * Math.PI) / 180);
    const radius = (p: number[]) => Math.hypot(p[0]!, p[1]!);
    // Seen from the front (−y), left is −x: dark, so thick; the right end is thin.
    expect(topIn(m, -R, -R * 0.6, -R, 0, radius)).toBeCloseTo(R + 2.2, 1);
    expect(topIn(m, R * 0.82, R, -R, 0, radius)).toBeLessThan(R + 0.3);
    // The bright corner sits at the top left: the left end is thin up there.
    let topLeft = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const p = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
      if (p[0]! < -R * 0.75 && p[2]! > 56) topLeft = Math.max(topLeft, radius(p));
    }
    expect(topLeft).toBeLessThan(R + 0.3);
  });

  it("closes round as a lamp shade with a frame at top and bottom", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([litho({ curve: 360, frame: 3 })]));
    ok(r.report);
    const m = r.meshes[0]!;
    expect(m.textured).toBe(true);
    expect(closedManifold(m.positions, m.indices)).toEqual({ open: 0, bad: 0 });
    expect(r.report.bodies[0]!.bbox.max[2]).toBeCloseTo(66, 3);
  });

  it("exports at about a corner per pixel, closed", async () => {
    const s = await newSession();
    s.rebuild(doc([litho({ image: big(), frame: 3 })]));
    const t0 = performance.now();
    const [m] = exportMeshes(await getOcct(), s.state!);
    const ms = performance.now() - t0;
    expect(m!.textured).toBe(true);
    expect(closedManifold(m!.positions, m!.indices)).toEqual({ open: 0, bad: 0 });
    // 400 × 300 pixels on 80 × 60 mm: 0.2 mm pixels, about ten triangles per pixel square or fewer.
    expect(m!.indices.length / 3).toBeGreaterThan(400 * 300);
    expect(m!.indices.length / 3).toBeLessThan(2_100_000);
    console.log(`lithophane export: ${m!.indices.length / 3} triangles in ${ms.toFixed(0)} ms`);
  });
});

/** 400 × 300 noise-free test picture (rings), as large as the app keeps. */
function big(): TextureImage {
  const w = 400, h = 300;
  let bin = "";
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) bin += String.fromCharCode(Math.round(127.5 + 127.5 * Math.sin(Math.hypot(x - 200, y - 150) / 8)));
  return { width: w, height: h, pixels: btoa(bin) };
}
