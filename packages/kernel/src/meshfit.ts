/**
 * Recognises the surfaces of a triangle mesh: welds the triangles into a closed mesh, groups them
 * into regions that lie on one plane, cylinder, cone or sphere (least squares fits, checked against
 * a distance tolerance) and traces the boundary of every region as segments between neighbouring
 * regions. Pure geometry, no OCCT: `meshconvert.ts` turns the result into a solid, and the
 * reconstruction of a parametric model works from the same primitives.
 */

export type Vec3 = [number, number, number];

export type Primitive =
  | { kind: "plane"; origin: Vec3; normal: Vec3 }
  /** `origin` is a point on the axis; `axis` is a unit vector. */
  | { kind: "cylinder"; origin: Vec3; axis: Vec3; radius: number }
  /** `axis` points from the apex into the cone; `halfAngle` in radians. */
  | { kind: "cone"; apex: Vec3; axis: Vec3; halfAngle: number }
  | { kind: "sphere"; center: Vec3; radius: number };

export interface Region {
  index: number;
  triangles: number[];
  /** null: a single triangle that no surface claimed (kept as a flat facet). */
  primitive: Primitive | null;
  area: number;
  /** Largest distance of a region vertex from the fitted surface. */
  residual: number;
  /** Closed boundary loops, as sequences of segment indices with a direction flag. */
  loops: { segment: number; forward: boolean }[][];
}

/** A run of boundary edges between the same two regions (`b` is -1 past a hole in the mesh). */
export interface Segment {
  a: number;
  b: number;
  /** Welded vertex indices along the segment; a closed segment repeats its first vertex last. */
  vertices: number[];
  closed: boolean;
}

export interface MeshFit {
  positions: Float64Array;
  /** Vertex indices, three per triangle. */
  triangles: Uint32Array;
  triangleRegion: Int32Array;
  regions: Region[];
  segments: Segment[];
  /** Twin half-edge of each directed triangle edge (index t*3+e), -1 at a hole in the mesh. */
  twin: Int32Array;
  volume: number;
  bbox: { min: Vec3; max: Vec3 };
  diag: number;
  tolerance: number;
}

export interface FitOptions {
  /** Largest distance a vertex may have from its fitted surface (mm); default from the part's size. */
  tolerance?: number;
  /** Dihedral angle (degrees) above which neighbouring triangles belong to different curved surfaces. */
  sharpAngle?: number;
  /** Largest angle (degrees) between the normals of triangles that count as one flat face. */
  flatAngle?: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
/** Two unit vectors perpendicular to `n` and to each other. */
export function basis(n: Vec3): [Vec3, Vec3] {
  const h = Math.abs(n[0]) < 0.9 ? ([1, 0, 0] as Vec3) : ([0, 1, 0] as Vec3);
  const u = unit(cross(n, h));
  return [u, cross(n, u)];
}

/** Distance of a point from a primitive's surface (signed for planes: along the normal). */
export function surfaceDistance(p: Vec3, s: Primitive): number {
  switch (s.kind) {
    case "plane":
      return dot(sub(p, s.origin), s.normal);
    case "cylinder": {
      const d = sub(p, s.origin);
      const t = dot(d, s.axis);
      return len(sub(d, scale(s.axis, t))) - s.radius;
    }
    case "cone": {
      const d = sub(p, s.apex);
      const t = dot(d, s.axis);
      const r = len(sub(d, scale(s.axis, t)));
      return r * Math.cos(s.halfAngle) - t * Math.sin(s.halfAngle);
    }
    case "sphere":
      return len(sub(p, s.center)) - s.radius;
  }
}

export function fitMesh(corners: ArrayLike<number>, opts: FitOptions = {}): MeshFit {
  const { positions, triangles } = weld(corners);
  const n = triangles.length / 3;
  const bbox = { min: [Infinity, Infinity, Infinity] as Vec3, max: [-Infinity, -Infinity, -Infinity] as Vec3 };
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      bbox.min[k] = Math.min(bbox.min[k]!, positions[i + k]!);
      bbox.max[k] = Math.max(bbox.max[k]!, positions[i + k]!);
    }
  const diag = len(sub(bbox.max, bbox.min));
  const tolerance = opts.tolerance ?? Math.max(0.01, diag * 2e-4);
  const sharp = Math.cos(((opts.sharpAngle ?? 30) * Math.PI) / 180);
  const flat = Math.cos(((opts.flatAngle ?? 1) * Math.PI) / 180);

  const p = (i: number): Vec3 => [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
  const tri = (t: number): [number, number, number] => [triangles[t * 3]!, triangles[t * 3 + 1]!, triangles[t * 3 + 2]!];
  const normals: Vec3[] = [];
  const areas: number[] = [];
  const centroids: Vec3[] = [];
  let volume = 0;
  for (let t = 0; t < n; t++) {
    const [a, b, c] = tri(t).map(p) as [Vec3, Vec3, Vec3];
    const nn = cross(sub(b, a), sub(c, a));
    const l = len(nn);
    areas.push(l / 2);
    normals.push(l > 0 ? scale(nn, 1 / l) : [0, 0, 0]);
    centroids.push(scale(add(add(a, b), c), 1 / 3));
    volume += dot(a, cross(b, c)) / 6;
  }
  if (volume < 0) {
    // Wound inside out: flip every triangle so boundary loops run the right way round.
    for (let t = 0; t < n; t++) {
      const tmp = triangles[t * 3 + 1]!;
      triangles[t * 3 + 1] = triangles[t * 3 + 2]!;
      triangles[t * 3 + 2] = tmp;
      normals[t] = scale(normals[t]!, -1);
    }
    volume = -volume;
  }
  const degenerate = (t: number) => areas[t]! <= diag * diag * 1e-12;

  // Twin triangle across each directed edge (the mesh is closed and consistently wound).
  const twin = new Int32Array(n * 3).fill(-1);
  const byEdge = new Map<number, number>();
  const vcount = positions.length / 3;
  const key = (a: number, b: number) => a * vcount + b;
  for (let t = 0; t < n; t++) {
    const v = tri(t);
    for (let e = 0; e < 3; e++) byEdge.set(key(v[e]!, v[(e + 1) % 3]!), t * 3 + e);
  }
  for (let t = 0; t < n; t++) {
    const v = tri(t);
    for (let e = 0; e < 3; e++) {
      const other = byEdge.get(key(v[(e + 1) % 3]!, v[e]!));
      if (other !== undefined) twin[t * 3 + e] = other >> 0;
    }
  }
  const neighbours = (t: number) => [0, 1, 2].map((e) => twin[t * 3 + e]!).filter((h) => h >= 0).map((h) => Math.floor(h / 3));

  const triangleRegion = new Int32Array(n).fill(-1);
  const regions: Region[] = [];
  const newRegion = (tris: number[], primitive: Primitive | null, residual: number) => {
    const r: Region = { index: regions.length, triangles: tris, primitive, area: tris.reduce((s, t) => s + areas[t]!, 0), residual, loops: [] };
    for (const t of tris) triangleRegion[t] = r.index;
    regions.push(r);
    return r;
  };
  const verticesOf = (tris: number[]) => {
    const set = new Set<number>();
    for (const t of tris) for (const v of tri(t)) set.add(v);
    return [...set];
  };
  const fitter = { p, normals, areas, centroids, tolerance, diag, flat };

  // 1. Smooth patches: connected through edges whose dihedral angle is below the sharp threshold.
  const patches = components(n, (t) => neighbours(t).filter((u) => dot(normals[t]!, normals[u]!) > sharp), degenerate);
  for (const patch of patches) {
    const whole = fitPatch(patch, verticesOf(patch), fitter);
    if (whole) {
      newRegion(patch, whole.primitive, whole.residual);
      continue;
    }
    // 2. Flat regions inside the patch, grown from the largest triangles.
    const inPatch = new Set(patch);
    const taken = new Set<number>();
    for (const seed of [...patch].sort((a, b) => areas[b]! - areas[a]!)) {
      if (taken.has(seed)) continue;
      const nrm = normals[seed]!;
      const d = dot(nrm, centroids[seed]!);
      const grown = grow(seed, (t) =>
        neighbours(t).filter((u) => inPatch.has(u) && !taken.has(u) && dot(normals[u]!, nrm) > flat && tri(u).every((v) => Math.abs(dot(p(v), nrm) - d) <= tolerance)),
      );
      for (const t of grown) taken.add(t);
      const fit = fitPlane(verticesOf(grown), grown, fitter);
      newRegion(grown, fit.primitive, fit.residual);
    }
  }
  // 3. Curved surfaces: thin flat strips (a tessellated cylinder is a row of nearly flat quads)
  // and claimed-by-nobody triangles, grouped by smooth connectivity and fitted as one surface.
  // A group that fits nothing keeps its flat regions.
  const perimeter = (tris: number[]) => {
    const inside = new Set(tris);
    let sum = 0;
    for (const t of tris) {
      const v = tri(t);
      for (let e = 0; e < 3; e++) {
        const h = twin[t * 3 + e]!;
        if (h < 0 || !inside.has(Math.floor(h / 3))) sum += len(sub(p(v[(e + 1) % 3]!), p(v[e]!)));
      }
    }
    return sum;
  };
  const leftovers = new Set<number>();
  for (const r of regions) {
    if (r.primitive && r.primitive.kind !== "plane") continue;
    const thin = r.triangles.length <= 2 || r.area * 40 < perimeter(r.triangles) ** 2;
    if (!r.primitive || thin) for (const t of r.triangles) leftovers.add(t);
  }
  const curvedPieces = components(n, (t) => neighbours(t).filter((u) => leftovers.has(u) && dot(normals[t]!, normals[u]!) > sharp), (t) => !leftovers.has(t) || degenerate(t));
  const claim = (tris: number[], fit: Fit) => {
    for (const t of tris) {
      const old = regions[triangleRegion[t]!];
      if (old) old.triangles = old.triangles.filter((x) => x !== t);
    }
    newRegion(tris, fit.primitive, fit.residual);
  };
  for (const piece of curvedPieces) {
    const whole = fitPatch(piece, verticesOf(piece), fitter, true);
    if (whole) {
      claim(piece, whole);
      continue;
    }
    // Several surfaces meet smoothly (the rounded edges around a face): grow each from a seed
    // strip while the neighbouring strips still lie on the fitted surface.
    const inPiece = new Set(piece);
    const unitOf = new Map<number, number[]>();
    for (const t of piece) {
      const r = regions[triangleRegion[t]!];
      unitOf.set(t, r && r.triangles.every((x) => inPiece.has(x)) ? r.triangles : [t]);
    }
    const units = [...new Set(unitOf.values())].sort((x, y) => y.reduce((s, t) => s + areas[t]!, 0) - x.reduce((s, t) => s + areas[t]!, 0));
    const claimed = new Set<number>();
    const adjacentUnits = (tris: number[]) => {
      const out = new Set<number[]>();
      for (const t of tris) for (const u of neighbours(t)) if (inPiece.has(u) && !claimed.has(u) && dot(normals[t]!, normals[u]!) > sharp) out.add(unitOf.get(u)!);
      for (const t of tris) out.delete(unitOf.get(t)!);
      return [...out];
    };
    const fitsOn = (unit: number[], prim: Primitive) =>
      verticesOf(unit).every((v) => Math.abs(surfaceDistance(p(v), prim)) <= tolerance) && unit.every((t) => dot(normals[t]!, primitiveNormal(centroids[t]!, prim)) > 0.9);
    for (const seed of units) {
      if (seed.some((t) => claimed.has(t))) continue;
      // Seed: the strip and two rings of neighbours.
      let cand = [...seed];
      for (let ring = 0; ring < 2; ring++) cand = [...new Set([...cand, ...adjacentUnits(cand).flat()])];
      // A small seed fits several surfaces (a corner of a sphere looks like a cylinder up close):
      // each hypothesis grows on its own and the one that covers the most area wins.
      let best: { tris: number[]; fit: Fit; area: number } | null = null;
      for (const start of fitCurved(cand, verticesOf(cand), fitter)) {
        let fit = start;
        let grown = [...new Set(cand.filter((t) => fitsOn([t], fit.primitive)).flatMap((t) => unitOf.get(t)!))].filter((t) => fitsOn(unitOf.get(t)!, fit.primitive));
        let sinceRefit = 0;
        for (;;) {
          const inGrown = new Set(grown);
          const next = adjacentUnits(grown).filter((u) => u.every((t) => !inGrown.has(t)) && fitsOn(u, fit.primitive));
          if (!next.length) break;
          for (const u of next) for (const t of u) if (!inGrown.has(t)) grown.push(t), inGrown.add(t);
          sinceRefit += next.length;
          if (sinceRefit * 2 >= grown.length) {
            const refit = fitCurved(grown, verticesOf(grown), fitter).find((c) => c.primitive.kind === fit.primitive.kind);
            if (refit) fit = refit;
            sinceRefit = 0;
          }
        }
        const final = fitCurved(grown, verticesOf(grown), fitter).find((c) => c.primitive.kind === fit.primitive.kind) ?? fit;
        grown = grown.filter((t) => fitsOn([t], final.primitive));
        if (grown.length < 4) continue;
        const area = grown.reduce((sum, t) => sum + areas[t]!, 0);
        if (!best || area > best.area * 1.05) best = { tris: grown, fit: final, area };
      }
      if (!best) continue;
      for (const t of best.tris) claimed.add(t);
      claim(best.tris, { primitive: best.fit.primitive, residual: Math.max(0, ...verticesOf(best.tris).map((v) => Math.abs(surfaceDistance(p(v), best!.fit.primitive)))) });
    }
  }
  // Grow curved regions into neighbouring flat strips that fit them within tolerance.
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of regions) {
      if (!r.primitive || r.primitive.kind === "plane" || !r.triangles.length) continue;
      const border = new Set<number>();
      for (const t of r.triangles) for (const u of neighbours(t)) if (triangleRegion[u]! >= 0 && triangleRegion[u] !== r.index) border.add(triangleRegion[u]!);
      for (const bi of border) {
        const other = regions[bi]!;
        if (!other.triangles.length || other.primitive?.kind !== "plane") continue;
        const vs = verticesOf(other.triangles);
        if (!vs.every((v) => Math.abs(surfaceDistance(p(v), r.primitive!)) <= tolerance)) continue;
        if (!other.triangles.every((t) => Math.abs(dot(normals[t]!, primitiveNormal(centroids[t]!, r.primitive!))) > 0.9)) continue;
        for (const t of other.triangles) triangleRegion[t] = r.index;
        for (const t of other.triangles) r.triangles.push(t);
        other.triangles = [];
        changed = true;
      }
    }
  }
  // Every triangle that no surface claimed is a flat facet of its own.
  for (let t = 0; t < n; t++) {
    if (degenerate(t)) continue;
    const r = triangleRegion[t]! >= 0 ? regions[triangleRegion[t]!] : undefined;
    if (!r || r.primitive === null) {
      if (r) r.triangles = r.triangles.filter((x) => x !== t);
      newRegion([t], null, 0);
    }
  }
  // Degenerate triangles join a neighbour (they add nothing to the surface).
  for (let t = 0; t < n; t++) {
    if (!degenerate(t) || triangleRegion[t]! >= 0) continue;
    const u = neighbours(t).find((x) => triangleRegion[x]! >= 0);
    if (u === undefined) newRegion([t], null, 0);
    else {
      triangleRegion[t] = triangleRegion[u]!;
      regions[triangleRegion[u]!]!.triangles.push(t);
    }
  }
  // Drop emptied regions and renumber.
  const kept = regions.filter((r) => r.triangles.length);
  kept.forEach((r, i) => {
    r.index = i;
    r.area = r.triangles.reduce((s, t) => s + areas[t]!, 0);
    for (const t of r.triangles) triangleRegion[t] = i;
  });
  regions.length = 0;
  // One by one: a scan can leave far more regions than a spread call takes arguments.
  for (const r of kept) regions.push(r);
  for (const r of regions) {
    if (!r.primitive) continue;
    const vs = verticesOf(r.triangles);
    r.residual = Math.max(0, ...vs.map((v) => Math.abs(surfaceDistance(p(v), r.primitive!))));
  }

  const segments = traceBoundaries(regions, triangleRegion, triangles, twin);
  return { positions, triangles, triangleRegion, regions, segments, twin, volume, bbox, diag, tolerance };
}

/**
 * The same fit with the given regions turned back into flat facets (one region per triangle), and
 * the boundaries traced again: for surfaces OCCT could not build a valid face from.
 */
export function demoteRegions(fit: MeshFit, which: Iterable<number>): MeshFit {
  const drop = new Set(which);
  const regions: Region[] = [];
  const triangleRegion = new Int32Array(fit.triangleRegion.length).fill(-1);
  const p = (i: number): Vec3 => [fit.positions[i * 3]!, fit.positions[i * 3 + 1]!, fit.positions[i * 3 + 2]!];
  const area = (t: number) => {
    const [a, b, c] = [p(fit.triangles[t * 3]!), p(fit.triangles[t * 3 + 1]!), p(fit.triangles[t * 3 + 2]!)];
    return len(cross(sub(b, a), sub(c, a))) / 2;
  };
  const add = (tris: number[], primitive: Primitive | null, residual: number) => {
    const r: Region = { index: regions.length, triangles: tris, primitive, area: tris.reduce((s, t) => s + area(t), 0), residual, loops: [] };
    for (const t of tris) triangleRegion[t] = r.index;
    regions.push(r);
  };
  for (const r of fit.regions) {
    if (!drop.has(r.index) || !r.primitive) add([...r.triangles], r.primitive, r.residual);
    else for (const t of r.triangles) add([t], null, 0);
  }
  const segments = traceBoundaries(regions, triangleRegion, fit.triangles, fit.twin);
  return { ...fit, regions, triangleRegion, segments };
}

/** Outward unit normal of a primitive at a point near its surface. */
export function primitiveNormal(q: Vec3, s: Primitive): Vec3 {
  switch (s.kind) {
    case "plane":
      return s.normal;
    case "cylinder": {
      const d = sub(q, s.origin);
      return unit(sub(d, scale(s.axis, dot(d, s.axis))));
    }
    case "cone": {
      const d = sub(q, s.apex);
      const radial = unit(sub(d, scale(s.axis, dot(d, s.axis))));
      return unit(sub(scale(radial, Math.cos(s.halfAngle)), scale(s.axis, Math.sin(s.halfAngle))));
    }
    case "sphere":
      return unit(sub(q, s.center));
  }
}

// ---------------------------------------------------------------- welding & graph helpers

function weld(corners: ArrayLike<number>): { positions: Float64Array; triangles: Uint32Array } {
  const count = corners.length / 3;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < corners.length; i++) {
    lo = Math.min(lo, corners[i]!);
    hi = Math.max(hi, corners[i]!);
  }
  const q = Math.max(1e-9, (hi - lo) * 1e-7);
  const index = new Map<string, number>();
  const pos: number[] = [];
  const tris: number[] = [];
  for (let i = 0; i < count; i += 3) {
    const ids: number[] = [];
    for (let c = i; c < i + 3; c++) {
      const x = corners[c * 3]!;
      const y = corners[c * 3 + 1]!;
      const z = corners[c * 3 + 2]!;
      const k = `${Math.round(x / q)},${Math.round(y / q)},${Math.round(z / q)}`;
      let v = index.get(k);
      if (v === undefined) {
        v = pos.length / 3;
        index.set(k, v);
        pos.push(x, y, z);
      }
      ids.push(v);
    }
    // A triangle with two corners in the same place is a sliver with no surface: dropped.
    if (ids[0] !== ids[1] && ids[1] !== ids[2] && ids[0] !== ids[2]) tris.push(...ids);
  }
  return { positions: Float64Array.from(pos), triangles: Uint32Array.from(tris) };
}

/** Connected components over `adjacent`, skipping triangles for which `skip` is true. */
function components(n: number, adjacent: (t: number) => number[], skip: (t: number) => boolean): number[][] {
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || skip(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const t = stack.pop()!;
      comp.push(t);
      for (const u of adjacent(t)) {
        if (seen[u] || skip(u)) continue;
        seen[u] = 1;
        stack.push(u);
      }
    }
    out.push(comp);
  }
  return out;
}

function grow(seed: number, next: (t: number) => number[]): number[] {
  const seen = new Set([seed]);
  const out: number[] = [];
  const stack = [seed];
  while (stack.length) {
    const t = stack.pop()!;
    out.push(t);
    for (const u of next(t)) {
      if (seen.has(u)) continue;
      seen.add(u);
      stack.push(u);
    }
  }
  return out;
}

// ---------------------------------------------------------------- fitting

interface Fitter {
  p: (i: number) => Vec3;
  normals: Vec3[];
  areas: number[];
  centroids: Vec3[];
  tolerance: number;
  diag: number;
  flat: number;
}

interface Fit {
  primitive: Primitive;
  residual: number;
}

const residualOf = (vs: number[], s: Primitive, f: Fitter) => Math.max(0, ...vs.map((v) => Math.abs(surfaceDistance(f.p(v), s))));

/** Best primitive for a set of triangles, or null when none fits within tolerance. */
function fitPatch(tris: number[], vs: number[], f: Fitter, curvedOnly = false): Fit | null {
  if (!curvedOnly) {
    const plane = fitPlane(vs, tris, f);
    const nrm = (plane.primitive as Extract<Primitive, { kind: "plane" }>).normal;
    if (plane.residual <= f.tolerance && tris.every((t) => dot(f.normals[t]!, nrm) > f.flat)) return plane;
  }
  return fitCurved(tris, vs, f)[0] ?? null;
}

/** Every curved primitive that fits a set of triangles within tolerance, simplest first. */
function fitCurved(tris: number[], vs: number[], f: Fitter): Fit[] {
  if (vs.length < 6 || tris.length < 4) return [];
  const out: Fit[] = [];
  const cyl = fitCylinder(vs, tris, f);
  if (cyl && cyl.residual <= f.tolerance) out.push(cyl);
  if (vs.length >= 8) {
    const cone = fitCone(vs, tris, f);
    if (cone && cone.residual <= f.tolerance) out.push(cone);
    const sphere = fitSphere(vs, f);
    if (sphere && sphere.residual <= f.tolerance) out.push(sphere);
  }
  return out;
}

function fitPlane(vs: number[], tris: number[], f: Fitter): Fit {
  let nrm: Vec3 = [0, 0, 0];
  let c: Vec3 = [0, 0, 0];
  let total = 0;
  for (const t of tris) {
    nrm = add(nrm, scale(f.normals[t]!, f.areas[t]!));
    c = add(c, scale(f.centroids[t]!, f.areas[t]!));
    total += f.areas[t]!;
  }
  nrm = unit(nrm);
  c = total > 0 ? scale(c, 1 / total) : f.p(vs[0]!);
  const primitive: Primitive = { kind: "plane", origin: c, normal: nrm };
  return { primitive, residual: residualOf(vs, primitive, f) };
}

/** Area-weighted covariance of the triangle normals about their mean; its smallest axis is the axis of a cylinder or cone. */
function normalAxis(tris: number[], f: Fitter): { axis: Vec3; spread: number } | null {
  let mean: Vec3 = [0, 0, 0];
  let total = 0;
  for (const t of tris) {
    mean = add(mean, scale(f.normals[t]!, f.areas[t]!));
    total += f.areas[t]!;
  }
  if (!(total > 0)) return null;
  mean = scale(mean, 1 / total);
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const t of tris) {
    const d = sub(f.normals[t]!, mean);
    const w = f.areas[t]! / total;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j]! += w * d[i]! * d[j]!;
  }
  const { values, vectors } = eigen3(m);
  let k = 0;
  for (let i = 1; i < 3; i++) if (values[i]! < values[k]!) k = i;
  // The normals must sweep a real arc, otherwise the "axis" is noise.
  return { axis: unit(vectors[k]!), spread: Math.max(...values) };
}

function fitCylinder(vs: number[], tris: number[], f: Fitter): Fit | null {
  const ax = normalAxis(tris, f);
  if (!ax || ax.spread < 1e-6) return null;
  const [e1, e2] = basis(ax.axis);
  const pts = vs.map((v) => f.p(v));
  const uv = pts.map((q): [number, number] => [dot(q, e1), dot(q, e2)]);
  const circle = fitCircle(uv);
  if (!circle || !(circle.r > 0) || circle.r > f.diag * 100) return null;
  const origin = add(scale(e1, circle.cx), scale(e2, circle.cy));
  const primitive: Primitive = { kind: "cylinder", origin, axis: ax.axis, radius: circle.r };
  return { primitive, residual: residualOf(vs, primitive, f) };
}

/** Least squares circle (Kåsa) refined by a few Gauss-Newton steps on the geometric distance. */
export function fitCircle(pts: [number, number][]): { cx: number; cy: number; r: number } | null {
  if (pts.length < 3) return null;
  // Centre the data for conditioning.
  let mx = 0;
  let my = 0;
  for (const [x, y] of pts) {
    mx += x;
    my += y;
  }
  mx /= pts.length;
  my /= pts.length;
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  for (const [px, py] of pts) {
    const x = px - mx;
    const y = py - my;
    const row = [x, y, 1];
    const rhs = -(x * x + y * y);
    for (let i = 0; i < 3; i++) {
      b[i]! += row[i]! * rhs;
      for (let j = 0; j < 3; j++) a[i * 3 + j]! += row[i]! * row[j]!;
    }
  }
  const s = solve3(a, b);
  if (!s) return null;
  let cx = -s[0]! / 2;
  let cy = -s[1]! / 2;
  let r2 = cx * cx + cy * cy - s[2]!;
  if (!(r2 > 0)) return null;
  let r = Math.sqrt(r2);
  for (let iter = 0; iter < 5; iter++) {
    // Gauss-Newton on residual |p - c| - r with unknowns (cx, cy, r).
    const jtj = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const jtr = [0, 0, 0];
    for (const [px, py] of pts) {
      const dx = px - mx - cx;
      const dy = py - my - cy;
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r;
      const row = [-dx / d, -dy / d, -1];
      for (let i = 0; i < 3; i++) {
        jtr[i]! -= row[i]! * res;
        for (let j = 0; j < 3; j++) jtj[i * 3 + j]! += row[i]! * row[j]!;
      }
    }
    const step = solve3(jtj, jtr);
    if (!step) break;
    cx += step[0]!;
    cy += step[1]!;
    r += step[2]!;
    if (Math.hypot(step[0]!, step[1]!, step[2]!) < 1e-12) break;
  }
  return { cx: cx + mx, cy: cy + my, r };
}

function fitCone(vs: number[], tris: number[], f: Fitter): Fit | null {
  const ax = normalAxis(tris, f);
  if (!ax || ax.spread < 1e-6) return null;
  // Every tangent plane of a cone passes through its apex: least squares point of all triangle planes.
  const a = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const b = [0, 0, 0];
  let total = 0;
  for (const t of tris) total += f.areas[t]!;
  for (const t of tris) {
    const nrm = f.normals[t]!;
    const w = f.areas[t]! / total;
    const d = dot(nrm, f.centroids[t]!);
    for (let i = 0; i < 3; i++) {
      b[i]! += w * nrm[i]! * d;
      for (let j = 0; j < 3; j++) a[i * 3 + j]! += w * nrm[i]! * nrm[j]!;
    }
  }
  const apexSolution = solve3(a, b);
  if (!apexSolution) return null;
  const apex = apexSolution as Vec3;
  const pts = vs.map((v) => f.p(v));
  let axis = ax.axis;
  let along = 0;
  for (const q of pts) along += dot(sub(q, apex), axis);
  if (along < 0) axis = scale(axis, -1);
  // Half angle: mean angle between the axis and the lines from the apex to the vertices.
  let ang = 0;
  for (const q of pts) {
    const d = sub(q, apex);
    const l = len(d);
    if (l > 0) ang += Math.acos(Math.max(-1, Math.min(1, dot(d, axis) / l)));
  }
  ang /= pts.length;
  if (ang < (1 * Math.PI) / 180 || ang > (89 * Math.PI) / 180) return null;
  const primitive: Primitive = { kind: "cone", apex, axis, halfAngle: ang };
  return { primitive, residual: residualOf(vs, primitive, f) };
}

function fitSphere(vs: number[], f: Fitter): Fit | null {
  // Algebraic fit: x² + y² + z² + D x + E y + F z + G = 0.
  const a = new Array<number>(16).fill(0);
  const b = [0, 0, 0, 0];
  for (const v of vs) {
    const q = f.p(v);
    const row = [q[0], q[1], q[2], 1];
    const rhs = -(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    for (let i = 0; i < 4; i++) {
      b[i]! += row[i]! * rhs;
      for (let j = 0; j < 4; j++) a[i * 4 + j]! += row[i]! * row[j]!;
    }
  }
  const s = solveN(a, b, 4);
  if (!s) return null;
  const center: Vec3 = [-s[0]! / 2, -s[1]! / 2, -s[2]! / 2];
  const r2 = dot(center, center) - s[3]!;
  if (!(r2 > 0)) return null;
  const radius = Math.sqrt(r2);
  if (radius > f.diag * 100) return null;
  const primitive: Primitive = { kind: "sphere", center, radius };
  return { primitive, residual: residualOf(vs, primitive, f) };
}

// ---------------------------------------------------------------- linear algebra

function solve3(a: number[], b: number[]): number[] | null {
  return solveN([...a], [...b], 3);
}

/** Gaussian elimination with partial pivoting on a row-major n×n matrix; null when singular. */
function solveN(a: number[], b: number[], n: number): number[] | null {
  const m = [...a];
  const r = [...b];
  let scaleMax = 0;
  for (const v of m) scaleMax = Math.max(scaleMax, Math.abs(v));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row * n + col]!) > Math.abs(m[piv * n + col]!)) piv = row;
    if (Math.abs(m[piv * n + col]!) <= 1e-12 * (scaleMax || 1)) return null;
    if (piv !== col) {
      for (let k = 0; k < n; k++) [m[col * n + k], m[piv * n + k]] = [m[piv * n + k]!, m[col * n + k]!];
      [r[col], r[piv]] = [r[piv]!, r[col]!];
    }
    for (let row = col + 1; row < n; row++) {
      const fct = m[row * n + col]! / m[col * n + col]!;
      for (let k = col; k < n; k++) m[row * n + k]! -= fct * m[col * n + k]!;
      r[row]! -= fct * r[col]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let s = r[row]!;
    for (let k = row + 1; k < n; k++) s -= m[row * n + k]! * x[k]!;
    x[row] = s / m[row * n + row]!;
  }
  return x;
}

/** Eigen decomposition of a symmetric 3×3 matrix (Jacobi rotations). */
function eigen3(m: number[]): { values: number[]; vectors: Vec3[] } {
  const a = [...m];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0;
    for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) off += a[i * 3 + j]! * a[i * 3 + j]!;
    if (off < 1e-30) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p * 3 + q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q * 3 + q]! - a[p * 3 + p]!) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k * 3 + p]!;
          const akq = a[k * 3 + q]!;
          a[k * 3 + p] = c * akp - s * akq;
          a[k * 3 + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p * 3 + k]!;
          const aqk = a[q * 3 + k]!;
          a[p * 3 + k] = c * apk - s * aqk;
          a[q * 3 + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p]!;
          const vkq = v[k * 3 + q]!;
          v[k * 3 + p] = c * vkp - s * vkq;
          v[k * 3 + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: [a[0]!, a[4]!, a[8]!], vectors: [0, 1, 2].map((k): Vec3 => [v[k]!, v[3 + k]!, v[6 + k]!]) };
}

// ---------------------------------------------------------------- boundaries

/**
 * Walks every region's boundary (directed edges whose twin lies in another region, keeping the
 * region on the left) and cuts the loops where the neighbouring region changes. Both regions that
 * share a run of edges get the same segment, so faces built from them share their edges.
 */
function traceBoundaries(regions: Region[], triangleRegion: Int32Array, triangles: Uint32Array, twin: Int32Array): Segment[] {
  const segments: Segment[] = [];
  const bySequence = new Map<string, number>();
  const regionOf = (h: number) => (h < 0 ? -1 : triangleRegion[Math.floor(h / 3)]!);
  const from = (h: number) => triangles[Math.floor(h / 3) * 3 + (h % 3)]!;
  const to = (h: number) => triangles[Math.floor(h / 3) * 3 + ((h % 3) + 1) % 3]!;
  const nextInTriangle = (h: number) => Math.floor(h / 3) * 3 + ((h % 3) + 1) % 3;

  for (const r of regions) {
    const visited = new Set<number>();
    const boundary: number[] = [];
    for (const t of r.triangles) for (let e = 0; e < 3; e++) if (regionOf(twin[t * 3 + e]!) !== r.index) boundary.push(t * 3 + e);
    for (const start of boundary) {
      if (visited.has(start)) continue;
      // Collect the whole loop of directed boundary half-edges.
      const loop: number[] = [];
      let h = start;
      do {
        visited.add(h);
        loop.push(h);
        // Rotate around the end vertex through this region's triangles until the outgoing edge leaves it.
        let k = nextInTriangle(h);
        let guard = 0;
        while (regionOf(twin[k]!) === r.index && guard++ < 10000) k = nextInTriangle(twin[k]!);
        h = k;
      } while (h !== start && !visited.has(h));
      if (h !== start) continue; // broken loop (non-manifold mesh); the face will be missing an edge
      // Split at vertices where the neighbouring region changes.
      const neighbourOf = (he: number) => regionOf(twin[he]!);
      let first = loop.findIndex((he, i) => neighbourOf(he) !== neighbourOf(loop[(i - 1 + loop.length) % loop.length]!));
      const pieces: number[][] = [];
      if (first < 0) pieces.push(loop);
      else {
        let cur: number[] = [];
        for (let i = 0; i < loop.length; i++) {
          const he = loop[(first + i) % loop.length]!;
          if (cur.length && neighbourOf(he) !== neighbourOf(cur[0]!)) {
            pieces.push(cur);
            cur = [];
          }
          cur.push(he);
        }
        pieces.push(cur);
      }
      const loopRefs: { segment: number; forward: boolean }[] = [];
      for (const piece of pieces) {
        const vs = [from(piece[0]!), ...piece.map(to)];
        const closed = first < 0;
        const other = neighbourOf(piece[0]!);
        const forwardKey = `${vs.join(",")}`;
        const reverseKey = `${[...vs].reverse().join(",")}`;
        let forward = true;
        let si = bySequence.get(forwardKey);
        if (si === undefined) {
          si = bySequence.get(reverseKey);
          if (si !== undefined) forward = false;
        }
        if (si === undefined && closed) {
          // A closed loop may start anywhere on the other side: match by the set of vertices.
          const canon = canonicalCycle(vs.slice(0, -1));
          si = bySequence.get(`cycle:${canon.key}`);
          if (si !== undefined) forward = canon.forward === canonicalCycle(segments[si]!.vertices.slice(0, -1)).forward;
          else bySequence.set(`cycle:${canon.key}`, segments.length);
        }
        if (si === undefined) {
          si = segments.length;
          bySequence.set(forwardKey, si);
          segments.push({ a: r.index, b: other, vertices: vs, closed });
        }
        loopRefs.push({ segment: si, forward });
      }
      r.loops.push(loopRefs);
    }
  }
  return segments;
}

/** Rotation-independent key of a cyclic vertex sequence, with whether it was read forwards. */
function canonicalCycle(vs: number[]): { key: string; forward: boolean } {
  const rotateMin = (arr: number[]) => {
    let k = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i]! < arr[k]!) k = i;
    return [...arr.slice(k), ...arr.slice(0, k)];
  };
  const fwd = rotateMin(vs).join(",");
  const rev = rotateMin([...vs].reverse()).join(",");
  return fwd <= rev ? { key: fwd, forward: true } : { key: rev, forward: false };
}
