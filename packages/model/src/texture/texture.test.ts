import { describe, expect, it } from "vitest";
import { TEXTURE_PATTERNS } from "@meercad/schema";
import { applyTextures, DISPLAY_TEXTURE, EXPORT_TEXTURE, type FaceSurface, type TexturableMesh, type TextureLayer, type TexturedMesh } from "./displace.js";
import { decodeHeightImage, fitWrap, patternHeight, patternPeriods, PATTERNS } from "./patterns.js";

type V3 = [number, number, number];

/** Builds a mesh face by face (separate corners per face, as the kernel delivers them). */
function builder() {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [], faceRanges: number[] = [];
  return {
    face(tris: V3[][], normal: (p: V3) => V3) {
      const first = indices.length;
      const at = new Map<string, number>();
      for (const tri of tris)
        for (const p of tri) {
          const key = p.join(",");
          let i = at.get(key);
          if (i === undefined) {
            i = positions.length / 3;
            at.set(key, i);
            positions.push(...p);
            normals.push(...normal(p));
          }
          indices.push(i);
        }
      faceRanges.push(first, indices.length - first, faceRanges.length / 3);
    },
    mesh(): TexturableMesh {
      return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices), faceRanges: Int32Array.from(faceRanges), edgeRanges: new Int32Array(), edgeFaces: [] };
    },
  };
}

/** Axis-aligned box from (0,0,0) to (sx,sy,sz): faces −X, +X, −Y, +Y, −Z, +Z, two triangles each, outward. */
function box(sx: number, sy: number, sz: number): TexturableMesh {
  const b = builder();
  const quad = (a: V3, c: V3, d: V3, e: V3, n: V3) => b.face([[a, c, d], [a, d, e]], () => n);
  quad([0, 0, 0], [0, 0, sz], [0, sy, sz], [0, sy, 0], [-1, 0, 0]);
  quad([sx, 0, 0], [sx, sy, 0], [sx, sy, sz], [sx, 0, sz], [1, 0, 0]);
  quad([0, 0, 0], [sx, 0, 0], [sx, 0, sz], [0, 0, sz], [0, -1, 0]);
  quad([0, sy, 0], [0, sy, sz], [sx, sy, sz], [sx, sy, 0], [0, 1, 0]);
  quad([0, 0, 0], [0, sy, 0], [sx, sy, 0], [sx, 0, 0], [0, 0, -1]);
  quad([0, 0, sz], [sx, 0, sz], [sx, sy, sz], [0, sy, sz], [0, 0, 1]);
  return b.mesh();
}

/** Closed cylinder about Z: face 0 the wall, 1 the bottom, 2 the top. */
function cylinder(r: number, h: number, n = 48): { mesh: TexturableMesh; surfaces: FaceSurface[] } {
  const b = builder();
  const ring = (z: number) => Array.from({ length: n }, (_, i): V3 => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z]);
  const lo = ring(0), hi = ring(h);
  const wall: V3[][] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    wall.push([lo[i]!, lo[j]!, hi[j]!], [lo[i]!, hi[j]!, hi[i]!]);
  }
  b.face(wall, (p) => [p[0] / r, p[1] / r, 0]);
  b.face(lo.map((p, i) => [[0, 0, 0], lo[(i + 1) % n]!, p]), () => [0, 0, -1]);
  b.face(hi.map((p, i) => [[0, 0, h], p, hi[(i + 1) % n]!]), () => [0, 0, 1]);
  return { mesh: b.mesh(), surfaces: [{ kind: "cylinder", origin: [0, 0, 0], axis: [0, 0, 1], radius: r }, { kind: "plane" }, { kind: "plane" }] };
}

/** Every edge (by position) used by exactly two triangles, once in each direction. */
function closedManifold(m: TexturedMesh): { open: number; bad: number; triangles: number } {
  const id = new Map<string, number>();
  const weld = (i: number) => {
    const key = `${m.positions[i * 3]!.toFixed(5)},${m.positions[i * 3 + 1]!.toFixed(5)},${m.positions[i * 3 + 2]!.toFixed(5)}`;
    let w = id.get(key);
    if (w === undefined) id.set(key, (w = id.size));
    return w;
  };
  const directed = new Map<string, number>();
  for (let t = 0; t < m.indices.length; t += 3) {
    const c = [weld(m.indices[t]!), weld(m.indices[t + 1]!), weld(m.indices[t + 2]!)];
    for (let k = 0; k < 3; k++) {
      const key = `${c[k]}>${c[(k + 1) % 3]}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0, bad = 0;
  for (const [key, n] of directed) {
    const [a, b] = key.split(">");
    const back = directed.get(`${b}>${a}`) ?? 0;
    if (n !== 1) bad++;
    if (back !== 1) open++;
  }
  return { open, bad, triangles: m.indices.length / 3 };
}

/** Signed volume of a closed mesh. */
function volume(m: TexturedMesh): number {
  let v = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
    const p = (i: number, k: number) => m.positions[i + k]!;
    v += p(a, 0) * (p(b, 1) * p(c, 2) - p(b, 2) * p(c, 1)) - p(a, 1) * (p(b, 0) * p(c, 2) - p(b, 2) * p(c, 0)) + p(a, 2) * (p(b, 0) * p(c, 1) - p(b, 1) * p(c, 0));
  }
  return v / 6;
}

const layer = (faces: number[], extra: Partial<TextureLayer> = {}): TextureLayer => ({ faces, pattern: "ribs", depth: 0.5, pitch: 3, angle: 0, ...extra });
const planes: FaceSurface[] = Array.from({ length: 6 }, () => ({ kind: "plane" }));

describe("texture patterns", () => {
  it("stay between 0 and 1 and repeat after their periods", () => {
    for (const p of TEXTURE_PATTERNS) {
      const img = { width: 4, height: 2, pixels: Uint8Array.from([0, 64, 128, 255, 255, 128, 64, 0]) };
      const h = patternHeight(p, { seed: 3, image: img });
      const [pa, pb] = patternPeriods(p, img);
      for (let i = 0; i < 400; i++) {
        const a = Math.sin(i * 12.9898) * 7.3, b = Math.cos(i * 78.233) * 5.1;
        const v = h(a, b);
        expect(v, `${p} at ${a},${b}`).toBeGreaterThanOrEqual(0);
        expect(v, `${p} at ${a},${b}`).toBeLessThanOrEqual(1);
        expect(h(a + pa, b), `${p} repeats across`).toBeCloseTo(v, 6);
        if (pb > 0) expect(h(a, b + pb), `${p} repeats along`).toBeCloseTo(v, 6);
        else expect(h(a, b + 1.7), `${p} does not change along`).toBeCloseTo(v, 9);
      }
    }
  });

  it("have a sensible shape", () => {
    const ribs = patternHeight("ribs");
    expect(ribs(0, 0)).toBe(0);
    expect(ribs(0.5, 0)).toBe(1);
    expect(patternHeight("ribs", { invert: true })(0.5, 0)).toBe(0);
    expect(patternHeight("ribs_v")(0.25, 0)).toBeCloseTo(0.5, 9);
    expect(patternHeight("cross_knurl")(0.5, 0.5)).toBe(1);
    // A hex cell is high in its middle and low on the border between cells.
    expect(patternHeight("hex")(0, 0)).toBe(1);
    expect(patternHeight("hex")(0.5, 0)).toBe(0);
    expect(patternHeight("dots")(0, 0)).toBe(1);
    expect(patternHeight("dots")(0.5, 0)).toBe(0);
    // A different seed gives a different leather.
    const l1 = patternHeight("leather", { seed: 1 }), l2 = patternHeight("leather", { seed: 2 });
    let diff = 0;
    for (let i = 0; i < 50; i++) diff += Math.abs(l1(i * 0.37, i * 0.21) - l2(i * 0.37, i * 0.21));
    expect(diff).toBeGreaterThan(1);
    // Every pattern has a default pitch and depth.
    for (const p of TEXTURE_PATTERNS) expect(PATTERNS[p].pitch).toBeGreaterThan(0);
  });

  it("reads a picture's heights", () => {
    const img = decodeHeightImage({ width: 2, height: 1, pixels: btoa(String.fromCharCode(0, 255)) });
    expect([...img.pixels]).toEqual([0, 255]);
    const h = patternHeight("image", { image: img });
    // Pixel centres at a = 0.25 and 0.75.
    expect(h(0.25, 0.25)).toBeCloseTo(0, 6);
    expect(h(0.75, 0.25)).toBeCloseTo(1, 6);
  });

  it("fits whole repeats round a circumference", () => {
    const f = fitWrap(100, 3, 0, 1, 0);
    expect(100 / f.pitch).toBeCloseTo(33, 9);
    const g = fitWrap(100, 5, 20, 1, 1);
    const t = (g.angle * Math.PI) / 180;
    const whole = (x: number) => Math.abs(x - Math.round(x));
    expect(whole((100 * Math.cos(t)) / g.pitch)).toBeCloseTo(0, 6);
    expect(whole((100 * Math.sin(t)) / g.pitch)).toBeCloseTo(0, 6);
    expect(g.angle).toBeGreaterThan(15);
    expect(g.angle).toBeLessThan(25);
  });
});

describe("texture displacement", () => {
  it("keeps a box closed and manifold with ribs on two walls, and moves them by the depth", () => {
    const m = applyTextures(box(30, 20, 10), [layer([2, 1])], planes, DISPLAY_TEXTURE)!;
    expect(m).not.toBeNull();
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    expect(m.faceRanges.length).toBe(18);
    // The −Y wall's ribs stand out to −0.5 and nothing goes beyond the depth.
    let minY = Infinity, maxX = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      minY = Math.min(minY, m.positions[i + 1]!);
      maxX = Math.max(maxX, m.positions[i]!);
    }
    expect(minY).toBeCloseTo(-0.5, 2);
    expect(maxX).toBeCloseTo(30.5, 2);
    // Ribs add volume (about the area under round ribs ≈ π/4 · 0.9 of the wall times the depth, less the fade).
    const added = volume(m) - 30 * 20 * 10;
    expect(added).toBeGreaterThan(0.3 * 0.5 * (30 * 10 + 20 * 10));
    expect(added).toBeLessThan(0.75 * 0.5 * (30 * 10 + 20 * 10));
  });

  it("cuts into the face for a negative depth", () => {
    const m = applyTextures(box(30, 20, 10), [layer([5], { pattern: "hex", depth: -0.4, pitch: 5 })], planes, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    let maxZ = -Infinity, minZ = Infinity;
    for (let i = 2; i < m.positions.length; i += 3) {
      if (m.positions[i]! > 9) {
        maxZ = Math.max(maxZ, m.positions[i]!);
        minZ = Math.min(minZ, m.positions[i]!);
      }
    }
    expect(maxZ).toBeCloseTo(10, 6);
    expect(minZ).toBeCloseTo(9.6, 2);
    expect(volume(m)).toBeLessThan(6000);
  });

  it("fades to the smooth face at the border", () => {
    const m = applyTextures(box(30, 20, 10), [layer([2], { fade: 2 })], planes, DISPLAY_TEXTURE)!;
    // Corners on the border of the −Y wall (x = 0 or 30, z = 0 or 10) stay on the wall.
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y, z] = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
      if (y < 0.001 && (x < 1e-4 || x > 30 - 1e-4 || z < 1e-4 || z > 10 - 1e-4)) expect(y).toBeCloseTo(0, 6);
      // Within 0.5 mm of the border, at most a little of the depth (smoothstep of 0.25 = 0.16).
      const border = Math.min(x, 30 - x, z, 10 - z);
      if (y < 0 && border < 0.5) expect(-y).toBeLessThan(0.5 * 0.16 + 1e-6);
    }
  });

  it("wraps round a cylinder without a seam and stays closed", () => {
    const { mesh, surfaces } = cylinder(10, 20);
    const m = applyTextures(mesh, [layer([0], { pattern: "knurl", depth: 0.4, pitch: 2 })], surfaces, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    // Away from the ends, every point lies between the radius and radius + depth.
    let maxR = 0;
    for (let i = 0; i < m.positions.length; i += 3) {
      const r = Math.hypot(m.positions[i]!, m.positions[i + 1]!);
      const z = m.positions[i + 2]!;
      if (z > 0.01 && z < 19.99) {
        expect(r).toBeGreaterThan(10 - 1e-3);
        expect(r).toBeLessThan(10.4 + 1e-3);
      }
      maxR = Math.max(maxR, r);
    }
    expect(maxR).toBeGreaterThan(10.35);
  });

  it("puts ribs on a cylinder as whole ribs round it", () => {
    const { mesh, surfaces } = cylinder(10, 20, 64);
    const m = applyTextures(mesh, [layer([0], { pitch: 3, fade: 0 })], surfaces, { samples: 12, maxTriangles: 1e6 })!;
    // Count the ribs round the middle: peaks of the radius along the circle at z = 10.
    const ring = new Map<number, number>();
    for (let i = 0; i < m.positions.length; i += 3) {
      if (Math.abs(m.positions[i + 2]! - 10) > 0.3) continue;
      const a = Math.round(((Math.atan2(m.positions[i + 1]!, m.positions[i]!) + Math.PI) / (2 * Math.PI)) * 2000);
      ring.set(a, Math.max(ring.get(a) ?? 0, Math.hypot(m.positions[i]!, m.positions[i + 1]!)));
    }
    const sorted = [...ring].sort((x, y) => x[0] - y[0]).map(([, r]) => r);
    let ribs = 0;
    for (let i = 0; i < sorted.length; i++) {
      const prev = sorted[(i + sorted.length - 1) % sorted.length]!;
      if (sorted[i]! > 10.25 && prev <= 10.25) ribs++;
    }
    expect(ribs).toBe(Math.round((2 * Math.PI * 10) / 3));
  });

  it("stays below the triangle budget and leaves other faces alone", () => {
    const base = box(100, 100, 50);
    const m = applyTextures(base, [layer([5], { pitch: 0.5 })], planes, { samples: 8, maxTriangles: 50_000 })!;
    expect(m.indices.length / 3).toBeLessThan(80_000);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    // The bottom keeps its two triangles (it only touches the top at no edge).
    expect(m.faceRanges[4 * 3 + 1]).toBe(6);
  });

  it("refines a round face meshed in thin strips without multiplying the triangles", () => {
    // 200 strips 0.25 mm wide and 50 mm tall, as the kernel meshes a fillet: ladders, not fans.
    const { mesh, surfaces } = cylinder(8, 50, 200);
    const t0 = performance.now();
    const m = applyTextures(mesh, [layer([0], { pitch: 4 })], surfaces, { samples: 8, maxTriangles: 1e7 })!;
    const area = 2 * Math.PI * 8 * 50;
    expect(m.indices.length / 3).toBeLessThan((12 * area) / 0.5 ** 2);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("refines a round face in strips wider than the spacing (export meshing) to the intended density", () => {
    // A 26 × 60 mm grip meshed for export: 126 strips 0.65 mm wide, knurled at a 3 mm pitch.
    const { mesh, surfaces } = cylinder(13, 60, 126);
    const t0 = performance.now();
    const m = applyTextures(mesh, [layer([0], { pattern: "knurl", depth: 0.6, pitch: 3 })], surfaces, EXPORT_TEXTURE)!;
    const spacing = 3 / EXPORT_TEXTURE.samples;
    const triangles = m.indices.length / 3 - 2 * 126;
    // Every edge at most the spacing needs about 6 × area / spacing² triangles; it once made 29×.
    expect(triangles).toBeLessThan((10 * 2 * Math.PI * 13 * 60) / spacing ** 2);
    expect(m.indices.length / 3).toBeLessThan(EXPORT_TEXTURE.maxTriangles);
    expect(m.spacing).toBeCloseTo(spacing, 6);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    expect(performance.now() - t0).toBeLessThan(10000);
  });

  it("holds the triangle budget over the whole part", () => {
    const { mesh, surfaces } = cylinder(13, 60, 126);
    const m = applyTextures(mesh, [layer([0], { pattern: "knurl", pitch: 3 })], surfaces, { samples: 12, maxTriangles: 100_000 })!;
    expect(m.indices.length / 3).toBeLessThanOrEqual(100_000);
    expect(m.indices.length / 3).toBeGreaterThan(40_000);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
  });

  it("works for every pattern", () => {
    const img = { width: 2, height: 2, pixels: Uint8Array.from([0, 255, 255, 0]) };
    for (const p of TEXTURE_PATTERNS) {
      const m = applyTextures(box(20, 20, 20), [layer([0, 2, 5], { pattern: p, pitch: 4, seed: 5, image: img })], planes, DISPLAY_TEXTURE)!;
      expect(closedManifold(m), p).toMatchObject({ open: 0, bad: 0 });
    }
  });

  it("returns nothing when no face is textured", () => {
    expect(applyTextures(box(1, 1, 1), [layer([9])], planes, DISPLAY_TEXTURE)).toBeNull();
  });
});
