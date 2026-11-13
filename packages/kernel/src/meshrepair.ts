/**
 * Cleaning up a scanned mesh: loose bits removed, holes closed, and the triangle count reduced as
 * far as the surface stays within a tolerance (edge collapses ordered by quadric error). No OCCT;
 * main thread.
 */
import { eigen3, weld } from "./meshfit.js";

export interface RepairOptions {
  /** Drop pieces with less than 2 % of the largest piece's area (scan debris). */
  removePieces?: boolean;
  /** Close every hole in the surface. */
  fillHoles?: boolean;
  /** Merge triangles while the surface moves at most this far (mm); 0 or absent: no reduction. */
  reduce?: number;
}

export interface RepairReport {
  before: number;
  after: number;
  piecesRemoved: number;
  holesFilled: number;
}

type V3 = [number, number, number];

/** The cleaned mesh (indexed) and what was done to it. */
export function repairMesh(
  corners: ArrayLike<number>,
  opts: RepairOptions,
): { positions: Float32Array; indices: Uint32Array; report: RepairReport } {
  const welded = weld(corners);
  const pos = Array.from(welded.positions);
  let tris = dedupe(Array.from(welded.triangles));
  const report: RepairReport = { before: corners.length / 9, after: 0, piecesRemoved: 0, holesFilled: 0 };

  if (opts.removePieces) {
    const kept = largePieces(pos, tris);
    report.piecesRemoved = kept.removed;
    tris = kept.tris;
  }

  if (opts.fillHoles) {
    const filled = fillHoles(pos, tris);
    report.holesFilled = filled;
  }

  if (opts.reduce && opts.reduce > 0) tris = simplify(pos, tris, opts.reduce);

  // Only the vertices still used, in order.
  const map = new Map<number, number>();
  const outPos: number[] = [];
  const outIdx = tris.map((v) => {
    let k = map.get(v);

    if (k === undefined) {
      k = outPos.length / 3;
      map.set(v, k);
      outPos.push(pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!);
    }

    return k;
  });
  report.after = outIdx.length / 3;

  return { positions: Float32Array.from(outPos), indices: Uint32Array.from(outIdx), report };
}

/** Drops triangles that repeat another one's corners. */
function dedupe(tris: number[]): number[] {
  const seen = new Set<string>();
  const out: number[] = [];

  for (let t = 0; t < tris.length; t += 3) {
    const key = [tris[t]!, tris[t + 1]!, tris[t + 2]!].sort((a, b) => a - b).join();
    if (seen.has(key)) continue;

    seen.add(key);
    out.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  }

  return out;
}

const at = (pos: number[], v: number): V3 => [pos[v * 3]!, pos[v * 3 + 1]!, pos[v * 3 + 2]!];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const area = (pos: number[], a: number, b: number, c: number) =>
  len(cross(sub(at(pos, b), at(pos, a)), sub(at(pos, c), at(pos, a)))) / 2;

/** Pieces (triangles joined through shared corners) with at least 2 % of the largest one's area. */
function largePieces(pos: number[], tris: number[]): { tris: number[]; removed: number } {
  const parent = Array.from({ length: pos.length / 3 }, (_, i) => i);

  const find = (v: number): number => {
    while (parent[v] !== v) v = parent[v] = parent[parent[v]!]!;

    return v;
  };

  const join = (a: number, b: number) => (parent[find(a)] = find(b));

  for (let t = 0; t < tris.length; t += 3) {
    join(tris[t]!, tris[t + 1]!);
    join(tris[t + 1]!, tris[t + 2]!);
  }

  const areas = new Map<number, number>();

  for (let t = 0; t < tris.length; t += 3) {
    const r = find(tris[t]!);
    areas.set(r, (areas.get(r) ?? 0) + area(pos, tris[t]!, tris[t + 1]!, tris[t + 2]!));
  }

  const largest = Math.max(0, ...areas.values());
  const keep = new Set([...areas].filter(([, a]) => a >= largest * 0.02).map(([r]) => r));
  const out: number[] = [];

  for (let t = 0; t < tris.length; t += 3) {
    if (keep.has(find(tris[t]!))) out.push(tris[t]!, tris[t + 1]!, tris[t + 2]!);
  }

  return { tris: out, removed: areas.size - keep.size };
}

/**
 * Closes every boundary loop: triangulated in the plane that fits it best (ear clipping), or as a
 * fan round its centre where the loop folds over itself in that plane. Adds to `pos` and `tris`.
 */
function fillHoles(pos: number[], tris: number[]): number {
  // Directed edges used once: a hole's rim, running round it the other way to the hole.
  const count = new Map<string, number>();

  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [tris[t + e]!, tris[t + ((e + 1) % 3)]!];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      count.set(key, (count.get(key) ?? 0) + 1);
    }
  }

  const next = new Map<number, number>();

  for (let t = 0; t < tris.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const [a, b] = [tris[t + e]!, tris[t + ((e + 1) % 3)]!];
      // The fill runs b → a, so the loop is followed from b to a.
      if (count.get(a < b ? `${a},${b}` : `${b},${a}`) === 1 && !next.has(b)) next.set(b, a);
    }
  }

  let filled = 0;
  const done = new Set<number>();

  for (const start of next.keys()) {
    if (done.has(start)) continue;

    const loop: number[] = [];
    let v = start;

    while (!done.has(v) && next.has(v)) {
      done.add(v);
      loop.push(v);
      v = next.get(v)!;
    }

    if (v !== start || loop.length < 3) continue;

    tris.push(...triangulate(pos, loop));
    filled++;
  }

  return filled;
}

function triangulate(pos: number[], loop: number[]): number[] {
  const pts = loop.map((v) => at(pos, v));
  const n = pts.length;
  const c: V3 = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k]!, 0) / n) as V3;
  if (n === 3) return [loop[0]!, loop[1]!, loop[2]!];

  // Best-fit plane: the normal is the direction the rim spreads least in.
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];

  for (const p of pts) {
    const d = sub(p, c);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j]! += d[i]! * d[j]!;
  }

  const e = eigen3(cov);
  const order = [0, 1, 2].sort((a, b) => e.values[b]! - e.values[a]!);
  const [u, w] = [e.vectors[order[0]!]!, e.vectors[order[1]!]!];
  let p2 = pts.map((p) => [dot(sub(p, c), u), dot(sub(p, c), w)] as [number, number]);
  // Ear clipping wants the polygon counter-clockwise; remember which way it ran.
  let signed = 0;
  for (let i = 0; i < n; i++) signed += p2[i]![0] * p2[(i + 1) % n]![1] - p2[(i + 1) % n]![0] * p2[i]![1];

  const idx = Array.from({ length: n }, (_, i) => i);

  if (signed < 0) {
    idx.reverse();
    p2 = idx.map((i) => p2[i]!);
  }

  const ears = earClip(p2);

  if (ears) {
    return ears.flatMap(([a, b, d]) =>
      signed < 0 ? [loop[idx[a]!]!, loop[idx[b]!]!, loop[idx[d]!]!] : [loop[a]!, loop[b]!, loop[d]!],
    );
  }

  // Folded rim: a fan round a new vertex in the middle.
  const mid = pos.length / 3;
  pos.push(...c);

  return loop.flatMap((v, i) => [v, loop[(i + 1) % n]!, mid]);
}

/** Triangles of a simple counter-clockwise polygon, or null when it crosses itself. */
function earClip(p: [number, number][]): [number, number, number][] | null {
  const rest = p.map((_, i) => i);
  const out: [number, number, number][] = [];
  const crossZ = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  let guard = rest.length * rest.length;

  while (rest.length > 3 && guard-- > 0) {
    let clipped = false;

    for (let i = 0; i < rest.length; i++) {
      const [ia, ib, ic] = [
        rest[(i + rest.length - 1) % rest.length]!,
        rest[i]!,
        rest[(i + 1) % rest.length]!,
      ];
      const [a, b, c] = [p[ia]!, p[ib]!, p[ic]!];
      if (crossZ(a, b, c) <= 0) continue;

      const inside = rest.some(
        (k) =>
          k !== ia &&
          k !== ib &&
          k !== ic &&
          crossZ(a, b, p[k]!) >= 0 &&
          crossZ(b, c, p[k]!) >= 0 &&
          crossZ(c, a, p[k]!) >= 0,
      );
      if (inside) continue;

      out.push([ia, ib, ic]);
      rest.splice(i, 1);
      clipped = true;
      break;
    }

    if (!clipped) return null;
  }

  if (rest.length !== 3) return null;

  out.push([rest[0]!, rest[1]!, rest[2]!]);

  return out;
}

/**
 * Edge collapses, cheapest first by quadric error (the mean squared distance of the new corner
 * from the planes of the triangles merged into it), while that stays within (tol/2)². Collapses that
 * would fold a triangle over, pinch the surface or move an open rim are skipped.
 */
function simplify(pos: number[], input: number[], tol: number): number[] {
  const nv = pos.length / 3;
  const tris = [...input];
  const nt = tris.length / 3;
  const alive = new Uint8Array(nt).fill(1);
  const faces: Set<number>[] = Array.from({ length: nv }, () => new Set());
  for (let t = 0; t < nt; t++) for (let k = 0; k < 3; k++) faces[tris[t * 3 + k]!]!.add(t);

  const Q = new Float64Array(nv * 10);
  // Planes merged into each corner: the error is their mean, so it does not grow with their number.
  const planes = new Float64Array(nv);

  const addPlane = (v: number, n: V3, d: number, w = 1) => {
    const q = [
      n[0] * n[0],
      n[0] * n[1],
      n[0] * n[2],
      n[0] * d,
      n[1] * n[1],
      n[1] * n[2],
      n[1] * d,
      n[2] * n[2],
      n[2] * d,
      d * d,
    ];
    for (let i = 0; i < 10; i++) Q[v * 10 + i]! += q[i]! * w;
  };

  const edgeUse = new Map<string, number>();
  const ek = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

  for (let t = 0; t < nt; t++) {
    const [a, b, c] = [tris[t * 3]!, tris[t * 3 + 1]!, tris[t * 3 + 2]!];
    const n = cross(sub(at(pos, b), at(pos, a)), sub(at(pos, c), at(pos, a)));
    const l = len(n);
    if (!l) continue;

    const u: V3 = [n[0] / l, n[1] / l, n[2] / l];
    const d = -dot(u, at(pos, a));

    for (const v of [a, b, c]) {
      addPlane(v, u, d);
      planes[v]!++;
    }

    for (const [x, y] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      edgeUse.set(ek(x, y), (edgeUse.get(ek(x, y)) ?? 0) + 1);
    }
  }

  // Open rims stay where they are.
  const rim = new Uint8Array(nv);
  for (const [key, uses] of edgeUse) if (uses === 1) for (const v of key.split(",")) rim[Number(v)] = 1;

  const errorAt = (v: number, w: number, p: V3) => {
    const q = (i: number) => Q[v * 10 + i]! + Q[w * 10 + i]!;
    const [x, y, z] = p;

    return (
      q(0) * x * x +
      2 * q(1) * x * y +
      2 * q(2) * x * z +
      2 * q(3) * x +
      q(4) * y * y +
      2 * q(5) * y * z +
      2 * q(6) * y +
      q(7) * z * z +
      2 * q(8) * z +
      q(9)
    );
  };

  /** Cheapest place among the two ends and the middle (a rim vertex must stay put). */
  const plan = (v: number, w: number): { cost: number; p: V3; keep: number } | null => {
    if (rim[v] && rim[w]) return null;

    const [pv, pw] = [at(pos, v), at(pos, w)];
    const options: { p: V3; keep: number }[] = rim[v]
      ? [{ p: pv, keep: v }]
      : rim[w]
        ? [{ p: pw, keep: w }]
        : [
            { p: pv, keep: v },
            { p: pw, keep: w },
            { p: [(pv[0] + pw[0]) / 2, (pv[1] + pw[1]) / 2, (pv[2] + pw[2]) / 2], keep: v },
          ];
    let best: { cost: number; p: V3; keep: number } | null = null;

    for (const o of options) {
      const cost = Math.max(0, errorAt(v, w, o.p)) / Math.max(1, planes[v]! + planes[w]!);
      if (!best || cost < best.cost) best = { cost, ...o };
    }

    return best;
  };

  // Mean squared distance within (tol/2)²: the farthest planes stay within about tol.
  const limit = (tol / 2) ** 2;
  const version = new Uint32Array(nv);
  const heap: { cost: number; v: number; w: number; sv: number; sw: number }[] = [];

  const push = (v: number, w: number) => {
    const p = plan(v, w);
    if (!p || p.cost > limit) return;

    heap.push({ cost: p.cost, v, w, sv: version[v]!, sw: version[w]! });

    let i = heap.length - 1;

    while (i > 0) {
      const up = (i - 1) >> 1;
      if (heap[up]!.cost <= heap[i]!.cost) break;

      [heap[up], heap[i]] = [heap[i]!, heap[up]!];
      i = up;
    }
  };

  const pop = () => {
    const top = heap[0]!;
    const last = heap.pop()!;

    if (heap.length) {
      heap[0] = last;

      let i = 0;

      for (;;) {
        const [l, r] = [i * 2 + 1, i * 2 + 2];
        let m = i;
        if (l < heap.length && heap[l]!.cost < heap[m]!.cost) m = l;
        if (r < heap.length && heap[r]!.cost < heap[m]!.cost) m = r;
        if (m === i) break;

        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }

    return top;
  };

  const neighbours = (v: number) => {
    const out = new Set<number>();

    for (const t of faces[v]!) {
      for (let k = 0; k < 3; k++) if (tris[t * 3 + k] !== v) out.add(tris[t * 3 + k]!);
    }

    return out;
  };

  for (const key of edgeUse.keys()) {
    const [a, b] = key.split(",").map(Number) as [number, number];
    push(a, b);
  }

  while (heap.length) {
    const e = pop();
    if (version[e.v] !== e.sv || version[e.w] !== e.sw) continue;

    const { v, w } = e;
    const p = plan(v, w);
    if (!p || p.cost > limit) continue;

    const gone = p.keep === v ? w : v;
    const keep = p.keep;
    // Only two triangles may share the edge, and the ends only those two corners in common:
    // anything else would pinch the surface.
    const shared = [...faces[v]!].filter((t) => faces[w]!.has(t));
    const nv1 = neighbours(v);
    const common = [...neighbours(w)].filter((x) => nv1.has(x));
    if (shared.length !== 2 || common.length !== 2) continue;

    // No remaining triangle may turn over.
    let flips = false;

    for (const t of new Set([...faces[v]!, ...faces[w]!])) {
      if (shared.includes(t)) continue;

      const c = [0, 1, 2].map((k) => tris[t * 3 + k]!);
      const before = cross(sub(at(pos, c[1]!), at(pos, c[0]!)), sub(at(pos, c[2]!), at(pos, c[0]!)));
      const moved = c.map((x) => (x === v || x === w ? p.p : at(pos, x)));
      const after = cross(sub(moved[1]!, moved[0]!), sub(moved[2]!, moved[0]!));

      if (dot(before, after) <= 0 || len(after) < len(before) * 1e-3) {
        flips = true;
        break;
      }
    }

    if (flips) continue;

    for (const t of shared) {
      alive[t] = 0;
      for (let k = 0; k < 3; k++) faces[tris[t * 3 + k]!]!.delete(t);
    }

    for (const t of faces[gone]!) {
      for (let k = 0; k < 3; k++) if (tris[t * 3 + k] === gone) tris[t * 3 + k] = keep;
      faces[keep]!.add(t);
    }

    faces[gone]!.clear();
    pos[keep * 3] = p.p[0];
    pos[keep * 3 + 1] = p.p[1];
    pos[keep * 3 + 2] = p.p[2];
    for (let i = 0; i < 10; i++) Q[keep * 10 + i]! += Q[gone * 10 + i]!;
    planes[keep]! += planes[gone]!;
    version[keep]!++;
    version[gone]!++;
    for (const x of neighbours(keep)) push(keep, x);
  }

  const out: number[] = [];
  for (let t = 0; t < nt; t++) if (alive[t]) out.push(tris[t * 3]!, tris[t * 3 + 1]!, tris[t * 3 + 2]!);

  return out;
}
