/**
 * Surface textures on a tessellated part: the triangles of the chosen faces are refined until no
 * edge is longer than a fraction of the pattern's pitch, then every new corner moves along the
 * surface normal by the pattern's height there. The refinement splits each edge by itself (a long
 * edge is halved, whichever triangle sees it), so triangles of neighbouring faces split along with
 * it and the surface stays closed: no cracks, no T-junctions, every edge shared by two triangles.
 *
 * The pattern is laid out per group of chosen faces joined by smooth edges:
 * - flat and round faces about one axis (a wall, a tube, a box's walls with rounded corners) are
 *   unrolled: across runs round the axis, along runs up it; a group that closes on itself gets a
 *   pitch that fits a whole number of times around;
 * - other faces (spheres, free-form) take the pattern from three sides, blended by the normal.
 * At the border to faces without texture and at sharp edges between textured faces the height fades
 * to zero over `fade` mm. Pure TypeScript; runs in the kernel worker.
 */
import type { TexturePattern } from "@meercad/schema";
import { fitWrap, patternHeight, patternPeriods, type HeightImage } from "./patterns.js";

type V3 = [number, number, number];

/** A tessellated part: per-face triangles as the kernel delivers them (see BodyMesh). */
export interface TexturableMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** Triples (firstIndex, indexCount, faceIndex) into `indices`. */
  faceRanges: Int32Array;
  edgeRanges: Int32Array;
  edgeFaces: number[][];
}

/** What a face is, where the texture can follow it exactly. */
export type FaceSurface = { kind: "plane" } | { kind: "cylinder"; origin: V3; axis: V3; radius: number } | { kind: "other" };

export interface TextureLayer {
  /** Face indices the texture lies on. */
  faces: number[];
  pattern: TexturePattern;
  depth: number;
  pitch: number;
  angle: number;
  ratio?: number;
  /** mm; undefined: half the pitch, at most 2 mm. */
  fade?: number;
  seed?: number;
  image?: HeightImage;
  invert?: boolean;
}

export interface TextureOptions {
  /** Refinement: corners per pitch (the longest edge is pitch ÷ this). */
  samples: number;
  /** Upper bound on the number of new triangles; the refinement gets coarser to stay below it. */
  maxTriangles: number;
}

export const DISPLAY_TEXTURE: TextureOptions = { samples: 8, maxTriangles: 300_000 };
/** While a value is being dragged: quick and coarse. */
export const DRAFT_TEXTURE: TextureOptions = { samples: 6, maxTriangles: 60_000 };
export const EXPORT_TEXTURE: TextureOptions = { samples: 16, maxTriangles: 3_000_000 };

export interface TexturedMesh {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  faceRanges: Int32Array;
  edgeRanges: Int32Array;
  /** Longest edge left on the textured faces (mm), for reports and tests. */
  spacing: number;
}

const COS_SMOOTH = Math.cos((30 * Math.PI) / 180);

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** One face's triangles: corners local to the face (a weld id and a normal each). */
interface Range {
  face: number;
  layer: number;
  weld: number[];
  nrm: number[];
  tris: number[];
  local: Map<number, number>;
}

export function defaultFade(pitch: number): number {
  return Math.min(pitch / 2, 2);
}

/** The textured mesh, or null when no layer has a face in the mesh. */
export function applyTextures(mesh: TexturableMesh, layers: TextureLayer[], surfaces: FaceSurface[], opts: TextureOptions): TexturedMesh | null {
  const layerOf = new Map<number, number>();
  layers.forEach((l, i) => {
    if (l.pitch > 0 && Number.isFinite(l.depth)) for (const f of l.faces) layerOf.set(f, i);
  });
  if (!layerOf.size) return null;

  // ---- weld corners at the same place, so faces share their border vertices
  const pos: number[] = [];
  const cell = new Map<string, number>();
  const q = 1e5;
  const weldOf = new Int32Array(mesh.positions.length / 3);
  for (let v = 0; v < weldOf.length; v++) {
    const x = mesh.positions[v * 3]!, y = mesh.positions[v * 3 + 1]!, z = mesh.positions[v * 3 + 2]!;
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let w = cell.get(key);
    if (w === undefined) {
      w = pos.length / 3;
      pos.push(x, y, z);
      cell.set(key, w);
    }
    weldOf[v] = w;
  }
  const P = (w: number): V3 => [pos[w * 3]!, pos[w * 3 + 1]!, pos[w * 3 + 2]!];

  const ranges: Range[] = [];
  for (let i = 0; i < mesh.faceRanges.length; i += 3) {
    const first = mesh.faceRanges[i]!, count = mesh.faceRanges[i + 1]!, face = mesh.faceRanges[i + 2]!;
    const r: Range = { face, layer: layerOf.get(face) ?? -1, weld: [], nrm: [], tris: [], local: new Map() };
    const byVertex = new Map<number, number>();
    for (let k = first; k < first + count; k++) {
      const v = mesh.indices[k]!;
      let l = byVertex.get(v);
      if (l === undefined) {
        l = r.weld.length;
        byVertex.set(v, l);
        r.weld.push(weldOf[v]!);
        r.nrm.push(mesh.normals[v * 3]!, mesh.normals[v * 3 + 1]!, mesh.normals[v * 3 + 2]!);
        if (!r.local.has(weldOf[v]!)) r.local.set(weldOf[v]!, l);
      }
      r.tris.push(l);
    }
    // Drop triangles that welding collapsed (degenerate slivers along a seam).
    const kept: number[] = [];
    for (let t = 0; t < r.tris.length; t += 3) {
      const a = r.weld[r.tris[t]!]!, b = r.weld[r.tris[t + 1]!]!, c = r.weld[r.tris[t + 2]!]!;
      if (a !== b && b !== c && c !== a) kept.push(r.tris[t]!, r.tris[t + 1]!, r.tris[t + 2]!);
    }
    r.tris = kept;
    ranges.push(r);
  }
  const selected = ranges.filter((r) => r.layer >= 0);
  if (!selected.length) return null;

  // ---- how fine: corners per pitch, coarser if the triangle budget would be exceeded
  const area = layers.map(() => 0);
  for (const r of selected)
    for (let t = 0; t < r.tris.length; t += 3) {
      const a = P(r.weld[r.tris[t]!]!), b = P(r.weld[r.tris[t + 1]!]!), c = P(r.weld[r.tris[t + 2]!]!);
      const n = cross(sub(b, a), sub(c, a));
      area[r.layer]! += Math.hypot(n[0], n[1], n[2]) / 2;
    }
  const spacing = layers.map((l) => Math.max(0.02, l.pitch / opts.samples));
  // Bisecting longest edges until none is longer than h leaves about 6·area/h² triangles.
  const estimate = layers.reduce((s, _, i) => s + (6 * area[i]!) / spacing[i]! ** 2, 0);
  if (estimate > opts.maxTriangles) {
    const k = Math.sqrt(estimate / opts.maxTriangles);
    for (let i = 0; i < spacing.length; i++) spacing[i]! *= k;
  }

  // ---- groups of chosen faces joined by smooth edges (per layer), from the original triangles
  const parent = ranges.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const edgeKey = (a: number, b: number) => (a < b ? a * 134217728 + b : b * 134217728 + a);
  {
    const seen = new Map<number, [number, number, number]>();
    ranges.forEach((r, ri) => {
      if (r.layer < 0) return;
      for (let t = 0; t < r.tris.length; t += 3)
        for (let k = 0; k < 3; k++) {
          const la = r.tris[t + k]!, lb = r.tris[t + ((k + 1) % 3)]!;
          const key = edgeKey(r.weld[la]!, r.weld[lb]!);
          const other = seen.get(key);
          if (!other) {
            seen.set(key, [ri, la, lb]);
            continue;
          }
          const [oi, oa, ob] = other;
          if (oi === ri || ranges[oi]!.layer !== r.layer) continue;
          const o = ranges[oi]!;
          const n = (rr: Range, l: number): V3 => [rr.nrm[l * 3]!, rr.nrm[l * 3 + 1]!, rr.nrm[l * 3 + 2]!];
          // Same corners in the other face: oa/ob may be the other way round.
          const [ma, mb] = o.weld[oa] === r.weld[la] ? [oa, ob] : [ob, oa];
          if (dot(n(r, la), n(o, ma)) > COS_SMOOTH && dot(n(r, lb), n(o, mb)) > COS_SMOOTH) parent[find(ri)] = find(oi);
        }
    });
  }
  const groupOf = ranges.map((r, i) => (r.layer < 0 ? -1 : find(i)));

  // ---- refine: split every edge of a chosen face that is longer than its layer's spacing
  const mids = new Map<number, number>();
  for (let pass = 0; pass < 40; pass++) {
    const long = new Map<number, number>();
    ranges.forEach((r, ri) => {
      if (r.layer < 0) return;
      const h2 = spacing[r.layer]! ** 2;
      // Each triangle's longest edge only (longest-edge bisection keeps the triangles well shaped).
      for (let t = 0; t < r.tris.length; t += 3) {
        let best = -1, bestLen = h2;
        for (let k = 0; k < 3; k++) {
          const a = r.weld[r.tris[t + k]!]!, b = r.weld[r.tris[t + ((k + 1) % 3)]!]!;
          const dx = pos[a * 3]! - pos[b * 3]!, dy = pos[a * 3 + 1]! - pos[b * 3 + 1]!, dz = pos[a * 3 + 2]! - pos[b * 3 + 2]!;
          const len = dx * dx + dy * dy + dz * dz;
          if (len > bestLen) {
            bestLen = len;
            best = k;
          }
        }
        if (best < 0) continue;
        const key = edgeKey(r.weld[r.tris[t + best]!]!, r.weld[r.tris[t + ((best + 1) % 3)]!]!);
        if (!long.has(key)) long.set(key, ri);
      }
    });
    if (!long.size) break;
    const midWeld = (a: number, b: number, key: number): number => {
      let m = mids.get(key);
      if (m !== undefined) return m;
      m = pos.length / 3;
      let p: V3 = [(pos[a * 3]! + pos[b * 3]!) / 2, (pos[a * 3 + 1]! + pos[b * 3 + 1]!) / 2, (pos[a * 3 + 2]! + pos[b * 3 + 2]!) / 2];
      const s = surfaces[ranges[long.get(key)!]!.face];
      if (s?.kind === "cylinder") p = ontoCylinder(p, s);
      pos.push(p[0], p[1], p[2]);
      mids.set(key, m);
      return m;
    };
    for (const r of ranges) {
      const s = surfaces[r.face];
      const midLocal = (la: number, lb: number): number => {
        const a = r.weld[la]!, b = r.weld[lb]!;
        const w = midWeld(a, b, edgeKey(a, b));
        let l = r.local.get(w);
        if (l !== undefined) return l;
        l = r.weld.length;
        r.weld.push(w);
        let n: V3;
        if (s?.kind === "cylinder" && r.layer >= 0) {
          const radial = radialOf(P(w), s);
          const out = dot(radial, [r.nrm[la * 3]!, r.nrm[la * 3 + 1]!, r.nrm[la * 3 + 2]!]) >= 0 ? 1 : -1;
          n = [radial[0] * out, radial[1] * out, radial[2] * out];
        } else n = norm([r.nrm[la * 3]! + r.nrm[lb * 3]!, r.nrm[la * 3 + 1]! + r.nrm[lb * 3 + 1]!, r.nrm[la * 3 + 2]! + r.nrm[lb * 3 + 2]!]);
        r.nrm.push(n[0], n[1], n[2]);
        r.local.set(w, l);
        return l;
      };
      const out: number[] = [];
      let changed = false;
      for (let t = 0; t < r.tris.length; t += 3) {
        const c = [r.tris[t]!, r.tris[t + 1]!, r.tris[t + 2]!];
        const split = [0, 1, 2].map((k) => long.has(edgeKey(r.weld[c[k]!]!, r.weld[c[(k + 1) % 3]!]!)));
        const count = split.filter(Boolean).length;
        if (!count) {
          out.push(c[0]!, c[1]!, c[2]!);
          continue;
        }
        changed = true;
        if (count === 3) {
          const m0 = midLocal(c[0]!, c[1]!), m1 = midLocal(c[1]!, c[2]!), m2 = midLocal(c[2]!, c[0]!);
          out.push(c[0]!, m0, m2, m0, c[1]!, m1, m2, m1, c[2]!, m0, m1, m2);
        } else if (count === 1) {
          const k = split.indexOf(true);
          const i0 = c[k]!, i1 = c[(k + 1) % 3]!, i2 = c[(k + 2) % 3]!;
          const m = midLocal(i0, i1);
          out.push(i0, m, i2, m, i1, i2);
        } else {
          // Two edges split: the unsplit one is (i2, i0).
          const k = (split.indexOf(false) + 1) % 3;
          const i0 = c[k]!, i1 = c[(k + 1) % 3]!, i2 = c[(k + 2) % 3]!;
          const m0 = midLocal(i0, i1), m1 = midLocal(i1, i2);
          out.push(m0, i1, m1);
          const d = (x: number, y: number) => {
            const a = P(r.weld[x]!), b = P(r.weld[y]!);
            return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
          };
          if (d(i0, m1) <= d(m0, i2)) out.push(i0, m0, m1, i0, m1, i2);
          else out.push(i0, m0, i2, m0, m1, i2);
        }
      }
      if (changed) r.tris = out;
    }
  }

  // ---- per welded vertex: which chosen faces meet there, border and crease
  const nW = pos.length / 3;
  const firstRange = new Int32Array(nW).fill(-1);
  const pinned = new Uint8Array(nW); // border to an untextured face or a sharp edge
  const dirSum = new Float64Array(nW * 3);
  const firstNormal = new Float64Array(nW * 3);
  const groupsAt = new Map<number, number[]>(); // weld → groups, only where more than one meets
  const used = new Uint8Array(nW);
  ranges.forEach((r, ri) => {
    const mark = new Uint8Array(r.weld.length);
    for (const l of r.tris) mark[l] = 1;
    for (let l = 0; l < r.weld.length; l++) {
      if (!mark[l]) continue;
      const w = r.weld[l]!;
      if (r.layer < 0) {
        used[w] = used[w]! | 1;
        continue;
      }
      used[w] = used[w]! | 2;
      const n: V3 = [r.nrm[l * 3]!, r.nrm[l * 3 + 1]!, r.nrm[l * 3 + 2]!];
      if (firstRange[w] === -1) {
        firstRange[w] = ri;
        firstNormal.set(n, w * 3);
      } else {
        const g0 = groupOf[firstRange[w]!]!;
        if (groupOf[ri] !== g0) {
          const list = groupsAt.get(w) ?? [g0];
          if (!list.includes(groupOf[ri]!)) list.push(groupOf[ri]!);
          groupsAt.set(w, list);
        }
        if (dot(n, [firstNormal[w * 3]!, firstNormal[w * 3 + 1]!, firstNormal[w * 3 + 2]!]) < COS_SMOOTH || groupOf[ri] !== g0) pinned[w] = 1;
      }
      // Each face adds its normal once per vertex.
      if (r.local.get(w) === l || !r.local.has(w)) {
        dirSum[w * 3]! += n[0];
        dirSum[w * 3 + 1]! += n[1];
        dirSum[w * 3 + 2]! += n[2];
      }
    }
  });
  for (let w = 0; w < nW; w++) if (used[w] === 3) pinned[w] = 1;

  // ---- the pattern's coordinates per group
  const groups = new Map<number, GroupMap>();
  for (const g of new Set(groupOf.filter((g) => g >= 0))) {
    const members = ranges.map((r, i) => i).filter((i) => groupOf[i] === g);
    groups.set(g, groupMapping(members.map((i) => ranges[i]!), members, surfaces, layers[ranges[g]!.layer]!, P));
  }

  // ---- heights
  const height = new Float64Array(nW);
  for (let w = 0; w < nW; w++) {
    if (firstRange[w]! < 0) continue;
    const gs = groupsAt.get(w) ?? [groupOf[firstRange[w]!]!];
    let sum = 0;
    for (const g of gs) {
      const map = groups.get(g)!;
      const ri = g === groupOf[firstRange[w]!] ? firstRange[w]! : ranges.findIndex((r, i) => groupOf[i] === g && r.local.has(w));
      sum += map.height(w, ri, [dirSum[w * 3]!, dirSum[w * 3 + 1]!, dirSum[w * 3 + 2]!]);
    }
    height[w] = sum / gs.length;
  }

  // ---- fade from the border: distances along the chosen faces' edges (Dijkstra, cut off at the fade)
  const fadeOf = layers.map((l) => Math.max(0, l.fade ?? defaultFade(l.pitch)));
  const factor = new Float64Array(nW).fill(1);
  const maxFade = Math.max(...fadeOf);
  if (maxFade > 0) {
    const adj = new Map<number, number[]>();
    const link = (a: number, b: number) => {
      let l = adj.get(a);
      if (!l) adj.set(a, (l = []));
      l.push(b);
    };
    for (const r of selected)
      for (let t = 0; t < r.tris.length; t += 3)
        for (let k = 0; k < 3; k++) link(r.weld[r.tris[t + k]!]!, r.weld[r.tris[t + ((k + 1) % 3)]!]!);
    const dist = new Float64Array(nW).fill(Infinity);
    const heap = new MinHeap();
    for (let w = 0; w < nW; w++)
      if (pinned[w] && firstRange[w]! >= 0) {
        dist[w] = 0;
        heap.push(0, w);
      }
    while (heap.size) {
      const [d, w] = heap.pop();
      if (d > dist[w]! || d > maxFade) continue;
      for (const o of adj.get(w) ?? []) {
        const nd = d + Math.hypot(pos[w * 3]! - pos[o * 3]!, pos[w * 3 + 1]! - pos[o * 3 + 1]!, pos[w * 3 + 2]! - pos[o * 3 + 2]!);
        if (nd < dist[o]!) {
          dist[o] = nd;
          heap.push(nd, o);
        }
      }
    }
    for (let w = 0; w < nW; w++) {
      if (firstRange[w]! < 0) continue;
      const f = fadeOf[ranges[firstRange[w]!]!.layer]!;
      factor[w] = f > 0 ? smoothstep(dist[w]! / f) : 1;
    }
  }

  // ---- move the corners
  for (let w = 0; w < nW; w++) {
    if (firstRange[w]! < 0) continue;
    const d = layers[ranges[firstRange[w]!]!.layer]!.depth * height[w]! * factor[w]!;
    if (!d) continue;
    const n = norm([dirSum[w * 3]!, dirSum[w * 3 + 1]!, dirSum[w * 3 + 2]!]);
    pos[w * 3]! += n[0] * d;
    pos[w * 3 + 1]! += n[1] * d;
    pos[w * 3 + 2]! += n[2] * d;
  }

  // ---- normals of the textured faces from the moved triangles
  const shared = new Float64Array(nW * 3);
  const localSums = new Map<Range, Float64Array>();
  for (const r of selected) {
    const acc = new Float64Array(r.weld.length * 3);
    for (let t = 0; t < r.tris.length; t += 3) {
      const [la, lb, lc] = [r.tris[t]!, r.tris[t + 1]!, r.tris[t + 2]!];
      const a = P(r.weld[la]!), b = P(r.weld[lb]!), c = P(r.weld[lc]!);
      const n = cross(sub(b, a), sub(c, a));
      for (const l of [la, lb, lc]) {
        acc[l * 3]! += n[0];
        acc[l * 3 + 1]! += n[1];
        acc[l * 3 + 2]! += n[2];
        const w = r.weld[l]!;
        shared[w * 3]! += n[0];
        shared[w * 3 + 1]! += n[1];
        shared[w * 3 + 2]! += n[2];
      }
    }
    localSums.set(r, acc);
  }

  // ---- write out face by face
  let vCount = 0, iCount = 0;
  for (const r of ranges) {
    vCount += r.weld.length;
    iCount += r.tris.length;
  }
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const indices = new Uint32Array(iCount);
  const faceRanges = new Int32Array(ranges.length * 3);
  let vo = 0, io = 0;
  ranges.forEach((r, ri) => {
    const acc = localSums.get(r);
    for (let l = 0; l < r.weld.length; l++) {
      const w = r.weld[l]!;
      positions.set([pos[w * 3]!, pos[w * 3 + 1]!, pos[w * 3 + 2]!], (vo + l) * 3);
      let n: V3;
      if (acc) {
        const src = pinned[w] ? acc : shared;
        const at = pinned[w] ? l : w;
        n = norm([src[at * 3]!, src[at * 3 + 1]!, src[at * 3 + 2]!]);
      } else n = [r.nrm[l * 3]!, r.nrm[l * 3 + 1]!, r.nrm[l * 3 + 2]!];
      normals.set(n, (vo + l) * 3);
    }
    faceRanges.set([io, r.tris.length, r.face], ri * 3);
    for (const l of r.tris) indices[io++] = vo + l;
    vo += r.weld.length;
  });

  // Edges inside a textured group are covered by the texture: not drawn.
  const groupOfFace = new Map<number, number>();
  ranges.forEach((r, i) => groupOfFace.set(r.face, groupOf[i]!));
  const keptEdges: number[] = [];
  for (let i = 0; i < mesh.edgeRanges.length; i += 3) {
    const faces = mesh.edgeFaces[mesh.edgeRanges[i + 2]!] ?? [];
    const gs = faces.map((f) => groupOfFace.get(f) ?? -1);
    const inside = gs.length > 0 && gs[0]! >= 0 && gs.every((g) => g === gs[0]);
    if (!inside) keptEdges.push(mesh.edgeRanges[i]!, mesh.edgeRanges[i + 1]!, mesh.edgeRanges[i + 2]!);
  }
  return { positions, normals, indices, faceRanges, edgeRanges: Int32Array.from(keptEdges), spacing: Math.max(...selected.map((r) => spacing[r.layer]!)) };
}

function radialOf(p: V3, s: { origin: V3; axis: V3 }): V3 {
  const a = norm(s.axis);
  const d = sub(p, s.origin);
  const t = dot(d, a);
  return norm([d[0] - a[0] * t, d[1] - a[1] * t, d[2] - a[2] * t]);
}

function ontoCylinder(p: V3, s: { origin: V3; axis: V3; radius: number }): V3 {
  const a = norm(s.axis);
  const d = sub(p, s.origin);
  const t = dot(d, a);
  const r: V3 = [d[0] - a[0] * t, d[1] - a[1] * t, d[2] - a[2] * t];
  const len = Math.hypot(r[0], r[1], r[2]);
  if (len < 1e-9) return p;
  const k = s.radius / len;
  return [s.origin[0] + a[0] * t + r[0] * k, s.origin[1] + a[1] * t + r[1] * k, s.origin[2] + a[2] * t + r[2] * k];
}

interface GroupMap {
  /** Pattern height (0–1) at welded vertex `w`, seen from face range `ri`, with the vertex's normal. */
  height(w: number, ri: number, normal: V3): number;
}

/** The direction "up" a flat face: world Z laid onto it, or Y for faces facing up or down. */
function upOn(n: V3): V3 {
  const ref: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const t = dot(ref, n);
  return norm([ref[0] - n[0] * t, ref[1] - n[1] * t, ref[2] - n[2] * t]);
}

function groupMapping(members: Range[], ids: number[], surfaces: FaceSurface[], layer: TextureLayer, P: (w: number) => V3): GroupMap {
  const periods = patternPeriods(layer.pattern, layer.image);
  const h = patternHeight(layer.pattern, { ...(layer.ratio !== undefined ? { ratio: layer.ratio } : {}), ...(layer.seed !== undefined ? { seed: layer.seed } : {}), ...(layer.image ? { image: layer.image } : {}), ...(layer.invert ? { invert: true } : {}) });
  const firstNormal = (r: Range): V3 => [r.nrm[0]!, r.nrm[1]!, r.nrm[2]!];
  const kinds = members.map((r) => surfaces[r.face] ?? { kind: "other" as const });
  const cyl = kinds.find((k) => k.kind === "cylinder") as Extract<FaceSurface, { kind: "cylinder" }> | undefined;
  let axis: V3 | null = null;
  if (!kinds.some((k) => k.kind === "other")) {
    if (cyl) {
      const a = norm(cyl.axis);
      const parallel = kinds.every((k) => k.kind !== "cylinder" || Math.abs(Math.abs(dot(norm(k.axis), a)) - 1) < 1e-4);
      const across = members.every((r, i) => kinds[i]!.kind !== "plane" || Math.abs(dot(firstNormal(r), a)) < 1e-3);
      if (parallel && across) axis = a;
    } else {
      const n0 = firstNormal(members[0]!);
      if (members.every((r) => dot(firstNormal(r), n0) > 1 - 1e-6)) axis = upOn(n0);
    }
  }
  if (!axis) return boxMapping(layer, h, P);
  const a = axis;

  // Unrolled coordinates: `u` round the axis (or across a flat face), `v` along it.
  const localU: ((p: V3) => number)[] = members.map((r, i) => {
    const k = kinds[i]!;
    if (k.kind === "cylinder") {
      const e1 = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
      const e2 = cross(a, e1);
      const theta = (p: V3) => {
        const d = sub(p, k.origin);
        return Math.atan2(dot(d, e2), dot(d, e1));
      };
      // Cut the angle where the face has its widest gap, so it runs on without a jump.
      const ts = [...new Set(r.weld)].map((w) => theta(P(w))).sort((x, y) => x - y);
      let cut = -Math.PI, gap = -1;
      for (let j = 0; j < ts.length; j++) {
        const next = j + 1 < ts.length ? ts[j + 1]! : ts[0]! + 2 * Math.PI;
        if (next - ts[j]! > gap) {
          gap = next - ts[j]!;
          cut = ts[j]! + gap / 2;
        }
      }
      const c0 = cut > Math.PI ? cut - 2 * Math.PI : cut;
      const out = dot(radialOf(P(r.weld[0]!), k), firstNormal(r)) >= 0 ? 1 : -1;
      return (p: V3) => {
        let t = theta(p);
        if (t < c0) t += 2 * Math.PI;
        return out * k.radius * t;
      };
    }
    const t = cross(a, firstNormal(r));
    return (p: V3) => dot(p, t);
  });

  // Offsets so neighbouring faces continue each other (breadth first over shared corners).
  const offset = members.map(() => NaN);
  const uAt = new Map<number, number>();
  const rangeIndex = new Map(ids.map((id, i) => [id, i]));
  const facesAt = new Map<number, number[]>();
  members.forEach((r, i) => {
    for (const w of new Set(r.weld)) {
      const l = facesAt.get(w);
      if (l) l.push(i);
      else facesAt.set(w, [i]);
    }
  });
  for (let start = 0; start < members.length; start++) {
    if (!Number.isNaN(offset[start]!)) continue;
    offset[start] = 0;
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      for (const w of new Set(members[i]!.weld)) {
        const u = localU[i]!(P(w)) + offset[i]!;
        if (!uAt.has(w)) uAt.set(w, u);
        for (const j of facesAt.get(w)!) {
          if (!Number.isNaN(offset[j]!)) continue;
          offset[j] = u - localU[j]!(P(w));
          queue.push(j);
        }
      }
    }
  }

  // Does the group close round the axis? Then once round is the jump between faces (or a whole turn).
  let perimeter = 0;
  for (const [w, list] of facesAt) {
    if (list.length < 2) continue;
    const us = list.map((i) => localU[i]!(P(w)) + offset[i]!);
    perimeter = Math.max(perimeter, Math.max(...us) - Math.min(...us));
  }
  if (perimeter < 1e-3) {
    perimeter = 0;
    const angles = members.flatMap((r) => {
      const out: number[] = [];
      for (let l = 0; l < r.weld.length; l++) {
        const n: V3 = [r.nrm[l * 3]!, r.nrm[l * 3 + 1]!, r.nrm[l * 3 + 2]!];
        const e1 = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
        out.push(Math.atan2(dot(n, cross(a, e1)), dot(n, e1)));
      }
      return out;
    });
    angles.sort((x, y) => x - y);
    let maxGap = angles.length ? angles[0]! + 2 * Math.PI - angles[angles.length - 1]! : 2 * Math.PI;
    for (let j = 1; j < angles.length; j++) maxGap = Math.max(maxGap, angles[j]! - angles[j - 1]!);
    if (maxGap < 0.5 && cyl) perimeter = 2 * Math.PI * cyl.radius;
  }

  let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
  for (const [w, u] of uAt) {
    const v = dot(P(w), a);
    umin = Math.min(umin, u);
    umax = Math.max(umax, u);
    vmin = Math.min(vmin, v);
    vmax = Math.max(vmax, v);
  }
  let pitch = layer.pitch, angle = layer.angle, u0: number, v0 = (vmin + vmax) / 2;
  if (perimeter > 0) {
    ({ pitch, angle } = fitWrap(perimeter, layer.pitch, layer.angle, periods[0], periods[1]));
    u0 = umin;
  } else {
    const width = umax - umin;
    const straight = Math.abs(Math.sin((layer.angle * Math.PI) / 180)) < 1e-6;
    const repeats = width / (layer.pitch * periods[0]);
    if (straight && repeats >= 1.5) {
      // Whole repeats across: the pattern starts and ends the same way at both sides.
      pitch = width / (Math.round(repeats) * periods[0]);
      u0 = umin;
    } else u0 = (umin + umax) / 2;
  }
  const rad = (angle * Math.PI) / 180;
  const ca = Math.cos(rad) / pitch, sa = Math.sin(rad) / pitch;
  return {
    height(w, ri) {
      const i = rangeIndex.get(ri) ?? 0;
      const p = P(w);
      const u = (localU[i]!(p) + offset[i]! - u0);
      const v = dot(p, a) - v0;
      return h(u * ca + v * sa, -u * sa + v * ca);
    },
  };
}

/** Free-form faces: the pattern seen from the three axes, blended by how much the face looks along each. */
function boxMapping(layer: TextureLayer, h: (a: number, b: number) => number, P: (w: number) => V3): GroupMap {
  const rad = (layer.angle * Math.PI) / 180;
  const ca = Math.cos(rad) / layer.pitch, sa = Math.sin(rad) / layer.pitch;
  const at = (u: number, v: number) => h(u * ca + v * sa, -u * sa + v * ca);
  return {
    height(w, _ri, normal) {
      const p = P(w);
      const n = norm(normal);
      const wx = n[0] ** 4, wy = n[1] ** 4, wz = n[2] ** 4;
      const sum = wx + wy + wz || 1;
      return (wx * at(p[1], p[2]) + wy * at(p[0], p[2]) + wz * at(p[0], p[1])) / sum;
    },
  };
}

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(k: number, v: number): void {
    const keys = this.keys, vals = this.vals;
    let i = keys.length;
    keys.push(k);
    vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p]! <= k) break;
      keys[i] = keys[p]!;
      vals[i] = vals[p]!;
      i = p;
    }
    keys[i] = k;
    vals[i] = v;
  }
  pop(): [number, number] {
    const keys = this.keys, vals = this.vals;
    const top: [number, number] = [keys[0]!, vals[0]!];
    const k = keys.pop()!, v = vals.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= keys.length) break;
        const c = l + 1 < keys.length && keys[l + 1]! < keys[l]! ? l + 1 : l;
        if (keys[c]! >= k) break;
        keys[i] = keys[c]!;
        vals[i] = vals[c]!;
        i = c;
      }
      keys[i] = k;
      vals[i] = v;
    }
    return top;
  }
}
