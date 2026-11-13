/**
 * Height pictures over several faces (displace.ts): a cylinder made of two half walls takes the
 * picture as one band round it, with no seam where the halves meet; free-form faces take it from
 * the three axes; two walls meeting at a sharp edge each get their own and the edge stays put.
 */
import { describe, expect, it } from "vitest";
import { applyTextures, DISPLAY_TEXTURE, type FaceSurface, type TexturableMesh, type TextureLayer, type TexturedMesh } from "./displace.js";
import type { HeightImage } from "./picture.js";

type V3 = [number, number, number];

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

/** Every edge used by exactly two triangles, once each way. */
function closedManifold(m: TexturedMesh): { open: number; bad: number } {
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
    for (let k = 0; k < 3; k++) directed.set(`${c[k]}>${c[(k + 1) % 3]}`, (directed.get(`${c[k]}>${c[(k + 1) % 3]}`) ?? 0) + 1);
  }
  let open = 0, bad = 0;
  for (const [key, n] of directed) {
    const [a, b] = key.split(">");
    if (n !== 1) bad++;
    if ((directed.get(`${b}>${a}`) ?? 0) !== 1) open++;
  }
  return { open, bad };
}

function picture(w: number, h: number, f: (x: number, y: number) => number): HeightImage {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = Math.round(255 * f(x, y));
  return { width: w, height: h, pixels };
}
const stripes = picture(16, 16, (x) => (Math.floor(x / 2) % 2 ? 1 : 0));
const white = picture(8, 8, () => 1);
const layer = (faces: number[], extra: Partial<TextureLayer> = {}): TextureLayer => ({ faces, depth: 0.4, pitch: 3, angle: 0, image: stripes, fade: 0, ...extra });

/** A cylinder about Z whose wall is two faces (halves), then bottom and top. */
function splitCylinder(r: number, h: number, n = 48): { mesh: TexturableMesh; surfaces: FaceSurface[] } {
  const b = builder();
  const ring = (z: number) => Array.from({ length: n }, (_, i): V3 => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n), z]);
  const lo = ring(0), hi = ring(h);
  const half = (from: number, to: number) => {
    const wall: V3[][] = [];
    for (let i = from; i < to; i++) {
      const j = (i + 1) % n;
      wall.push([lo[i]!, lo[j]!, hi[j]!], [lo[i]!, hi[j]!, hi[i]!]);
    }
    b.face(wall, (p) => [p[0] / r, p[1] / r, 0]);
  };
  half(0, n / 2);
  half(n / 2, n);
  b.face(lo.map((p, i) => [[0, 0, 0], lo[(i + 1) % n]!, p]), () => [0, 0, -1]);
  b.face(hi.map((p, i) => [[0, 0, h], p, hi[(i + 1) % n]!]), () => [0, 0, 1]);
  const cyl: FaceSurface = { kind: "cylinder", origin: [0, 0, 0], axis: [0, 0, 1], radius: r };
  return { mesh: b.mesh(), surfaces: [cyl, cyl, { kind: "plane" }, { kind: "plane" }] };
}

/** Axis-aligned box from the origin, faces −X, +X, −Y, +Y, −Z, +Z. */
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

describe("pictures over several faces", () => {
  it("wraps one band round a cylinder of two half walls, closed and within the depth", () => {
    const { mesh, surfaces } = splitCylinder(10, 20);
    const m = applyTextures(mesh, [layer([0, 1])], surfaces, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toEqual({ open: 0, bad: 0 });
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

  it("lays a picture on free-form faces from the three axes", () => {
    const other: FaceSurface[] = Array.from({ length: 6 }, () => ({ kind: "other" }));
    const m = applyTextures(box(30, 20, 10), [layer([2, 5], { image: white, fade: 0 })], other, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toEqual({ open: 0, bad: 0 });
    // A white picture raises the faces by up to the depth, never more.
    let minY = Infinity, maxZ = -Infinity;
    for (let i = 0; i < m.positions.length; i += 3) {
      minY = Math.min(minY, m.positions[i + 1]!);
      maxZ = Math.max(maxZ, m.positions[i + 2]!);
    }
    expect(minY).toBeGreaterThanOrEqual(-0.4 - 1e-6);
    expect(minY).toBeLessThan(-0.3);
    expect(maxZ).toBeLessThanOrEqual(10.4 + 1e-6);
    expect(maxZ).toBeGreaterThan(10.3);
  });

  it("keeps the sharp edge between two pictured walls where it is", () => {
    const planes: FaceSurface[] = Array.from({ length: 6 }, () => ({ kind: "plane" }));
    const m = applyTextures(box(30, 20, 10), [layer([2]), layer([0], { angle: 90 })], planes, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toEqual({ open: 0, bad: 0 });
    // Corners on the edge x = 0, y = 0 stay on it.
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y] = [m.positions[i]!, m.positions[i + 1]!];
      if (Math.abs(x) < 1e-6 && y > -0.41 && y < 1e-6) expect(Math.abs(y)).toBeLessThan(1e-6);
    }
  });

  it("drops the drawn edges inside one pictured group and keeps those on its border", () => {
    const { mesh, surfaces } = splitCylinder(10, 20);
    // Edge 0 joins the two half walls (inside the group), edge 1 the wall and the top (its border).
    const withEdges: TexturableMesh = { ...mesh, edgeRanges: Int32Array.from([0, 2, 0, 2, 2, 1]), edgeFaces: [[0, 1], [0, 3]] };
    const m = applyTextures(withEdges, [layer([0, 1])], surfaces, DISPLAY_TEXTURE)!;
    expect([...m.edgeRanges]).toEqual([2, 2, 1]);
  });

  it("turns a flat picture so its top points the way asked", () => {
    const planes: FaceSurface[] = Array.from({ length: 6 }, () => ({ kind: "plane" }));
    // Stripes across the picture: on the top face with "up" along +X they run along Y.
    const across = picture(16, 16, (_, y) => (Math.floor(y / 2) % 2 ? 1 : 0));
    const m = applyTextures(box(30, 20, 10), [layer([5], { image: across, up: [1, 0, 0] })], planes, DISPLAY_TEXTURE)!;
    // Heights on the top change along X, not along Y: points at the same X have the same height.
    const byX = new Map<string, Set<string>>();
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y, z] = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
      if (z < 9.99 || x < 1 || x > 29 || y < 1 || y > 19) continue;
      const k = x.toFixed(3);
      byX.set(k, (byX.get(k) ?? new Set()).add(z.toFixed(2)));
    }
    expect(byX.size).toBeGreaterThan(5);
    for (const zs of byX.values()) expect(zs.size).toBe(1);
  });

  it("gives back the coarsest try when even that is above the triangle budget", () => {
    const planes: FaceSurface[] = Array.from({ length: 6 }, () => ({ kind: "plane" }));
    const m = applyTextures(box(30, 20, 10), [layer([5])], planes, { samples: 8, maxTriangles: 4 })!;
    expect(m.indices.length / 3).toBeGreaterThan(4);
  });

  it("makes ladders of a flat face meshed partly in thin strips, its corners between theirs", () => {
    // One plate face: x 0–10 in 0.25 mm strips the full 20 mm long, x 10–30 as two triangles.
    const b = builder();
    const tris: V3[][] = [];
    for (let x = 0; x < 10; x += 0.25) tris.push([[x, 0, 0], [x + 0.25, 0, 0], [x + 0.25, 20, 0]], [[x, 0, 0], [x + 0.25, 20, 0], [x, 20, 0]]);
    tris.push([[10, 0, 0], [30, 0, 0], [30, 20, 0]], [[10, 0, 0], [30, 20, 0], [10, 20, 0]]);
    b.face(tris, () => [0, 0, 1]);
    const m = applyTextures(b.mesh(), [layer([0], { image: white })], [{ kind: "plane" }], DISPLAY_TEXTURE)!;
    expect(m.indices.length / 3).toBeGreaterThan(tris.length);
    for (let i = 0; i < m.positions.length; i += 3) {
      expect(m.positions[i + 2]!).toBeGreaterThanOrEqual(-1e-6);
      expect(m.positions[i + 2]!).toBeLessThanOrEqual(0.4 + 1e-6);
      // New corners stay on the plate.
      expect(m.positions[i]!).toBeGreaterThanOrEqual(-1e-6);
      expect(m.positions[i]!).toBeLessThanOrEqual(30 + 1e-6);
    }
    // Every normal is a unit vector.
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 5);
  });
});
