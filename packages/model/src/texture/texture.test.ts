import { describe, expect, it } from "vitest";
import { applyTextures, DISPLAY_TEXTURE, EXPORT_TEXTURE, type FaceSurface, type TexturableMesh, type TextureLayer, type TexturedMesh } from "./displace.js";
import { decodeHeightImage, imageFit, imageTiled, type HeightImage } from "./picture.js";

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

/** A `w` × `h` picture with brightness from `f(x, y)` (0–1, row 0 at the top). */
function picture(w: number, h: number, f: (x: number, y: number) => number): HeightImage {
  const pixels = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels[y * w + x] = Math.round(255 * f(x, y));
  return { width: w, height: h, pixels };
}
/** Bright and dark columns, two pixels each. */
const stripes = picture(16, 16, (x) => (Math.floor(x / 2) % 2 ? 1 : 0));
const white = picture(8, 8, () => 1);

const layer = (faces: number[], extra: Partial<TextureLayer> = {}): TextureLayer => ({ faces, depth: 0.5, pitch: 3, angle: 0, image: stripes, ...extra });
const planes: FaceSurface[] = Array.from({ length: 6 }, () => ({ kind: "plane" }));

describe("height pictures", () => {
  it("reads a picture's heights", () => {
    const img = decodeHeightImage({ width: 2, height: 1, pixels: btoa(String.fromCharCode(0, 255)) });
    expect([...img.pixels]).toEqual([0, 255]);
    const fit = imageFit(img);
    expect(fit(0.25, 0.5)).toBeCloseTo(0, 6);
    expect(fit(0.75, 0.5)).toBeCloseTo(1, 6);
    expect(imageFit(img, true)(0.75, 0.5)).toBeCloseTo(0, 6);
  });

  it("repeats a tiled picture and joins the sides of a wrapped one", () => {
    const h = imageTiled(stripes);
    for (const [a, b] of [[0.3, 0.2], [0.7, 0.9]] as const) expect(h(a + 1, b)).toBeCloseTo(h(a, b), 9);
    const wrapped = imageFit(stripes, false, true);
    expect(wrapped(1.01, 0.5)).toBeCloseTo(wrapped(0.01, 0.5), 9);
  });
});

describe("height picture displacement", () => {
  it("keeps a box closed and manifold with the picture on a wall, and moves it by the depth", () => {
    const m = applyTextures(box(30, 20, 10), [layer([2], { image: white, fade: 1 })], planes, DISPLAY_TEXTURE)!;
    expect(m).not.toBeNull();
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    expect(m.faceRanges.length).toBe(18);
    // A white picture raises the −Y wall by the full depth, away from the border.
    let minY = Infinity;
    for (let i = 0; i < m.positions.length; i += 3) minY = Math.min(minY, m.positions[i + 1]!);
    expect(minY).toBeCloseTo(-0.5, 2);
    const added = volume(m) - 30 * 20 * 10;
    expect(added).toBeGreaterThan(0.5 * 0.7 * 30 * 10);
    expect(added).toBeLessThan(0.5 * 30 * 10);
  });

  it("cuts into the face for a negative depth", () => {
    const m = applyTextures(box(30, 20, 10), [layer([5], { depth: -0.4 })], planes, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    let maxZ = -Infinity, minZ = Infinity;
    for (let i = 2; i < m.positions.length; i += 3) {
      if (m.positions[i]! > 9) {
        maxZ = Math.max(maxZ, m.positions[i]!);
        minZ = Math.min(minZ, m.positions[i]!);
      }
    }
    expect(maxZ).toBeCloseTo(10, 6);
    expect(minZ).toBeLessThan(9.7);
    expect(minZ).toBeGreaterThan(9.6 - 1e-6);
    expect(volume(m)).toBeLessThan(6000);
  });

  it("fades to the smooth face at the border", () => {
    const m = applyTextures(box(30, 20, 10), [layer([2], { image: white, fade: 2 })], planes, DISPLAY_TEXTURE)!;
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y, z] = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
      if (y < 0.001 && (x < 1e-4 || x > 30 - 1e-4 || z < 1e-4 || z > 10 - 1e-4)) expect(y).toBeCloseTo(0, 6);
      // Within 0.5 mm of the border, at most a little of the depth (smoothstep of 0.25 = 0.16).
      const border = Math.min(x, 30 - x, z, 10 - z);
      if (y < 0 && border < 0.5) expect(-y).toBeLessThan(0.5 * 0.16 + 1e-6);
    }
  });

  it("wraps a picture round a cylinder without a seam and stays closed", () => {
    const { mesh, surfaces } = cylinder(10, 20);
    const m = applyTextures(mesh, [layer([0], { depth: 0.4, fade: 0 })], surfaces, DISPLAY_TEXTURE)!;
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
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

  it("stays below the triangle budget and leaves other faces alone", () => {
    const fine = picture(400, 400, (x, y) => ((x + y) % 7) / 6);
    const m = applyTextures(box(100, 100, 50), [layer([5], { image: fine })], planes, { samples: 8, maxTriangles: 50_000 })!;
    expect(m.indices.length / 3).toBeLessThanOrEqual(50_000);
    expect(m.indices.length / 3).toBeGreaterThan(25_000);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    // The bottom keeps its two triangles (it only touches the top at no edge).
    expect(m.faceRanges[4 * 3 + 1]).toBe(6);
  });

  it("refines a round face meshed in thin strips without multiplying the triangles", () => {
    // 200 strips 0.25 mm wide and 50 mm tall, as the kernel meshes a curved plate: ladders, not fans.
    const { mesh, surfaces } = cylinder(8, 50, 200);
    const t0 = performance.now();
    const m = applyTextures(mesh, [layer([0], { image: picture(150, 150, (x) => (x % 10) / 9) })], surfaces, { samples: 8, maxTriangles: 1e7 })!;
    const area = 2 * Math.PI * 8 * 50;
    expect(m.indices.length / 3).toBeLessThan((12 * area) / m.spacing ** 2);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
    // Guards against the refinement blowing up (once minutes), with room for a loaded machine.
    expect(performance.now() - t0).toBeLessThan(15000);
  });

  it("puts about a corner on each pixel for export", () => {
    const img = picture(120, 60, (x, y) => ((x * 3 + y) % 5) / 4);
    const { mesh, surfaces } = cylinder(13, 60, 126);
    const m = applyTextures(mesh, [layer([0], { image: img })], surfaces, EXPORT_TEXTURE)!;
    const pixel = Math.sqrt((2 * Math.PI * 13 * 60) / (img.width * img.height));
    expect(m.spacing).toBeLessThanOrEqual(pixel * 1.01);
    expect(m.indices.length / 3).toBeLessThan(EXPORT_TEXTURE.maxTriangles);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
  });

  it("makes a retry coarser when the first try overshoots the budget", () => {
    const { mesh, surfaces } = cylinder(30, 100, 40);
    const m = applyTextures(mesh, [layer([0], { image: picture(300, 300, (x) => (x % 4) / 3) })], surfaces, { samples: 8, maxTriangles: 100_000 })!;
    expect(m.indices.length / 3).toBeLessThanOrEqual(100_000);
    expect(closedManifold(m)).toMatchObject({ open: 0, bad: 0 });
  });

  it("returns nothing when no face has the picture", () => {
    expect(applyTextures(box(1, 1, 1), [layer([9])], planes, DISPLAY_TEXTURE)).toBeNull();
  });
});
