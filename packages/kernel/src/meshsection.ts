/**
 * A mesh cut at a plane, and the cut traced with lines, arcs and circles: the outline of a scanned
 * or downloaded part on a sketch plane, ready to become dimensioned sketch geometry. No OCCT; runs
 * on the main thread.
 */
import { fitCircle } from "./meshfit.js";

export type Vec2 = [number, number];

export interface SectionFrame {
  origin: readonly number[];
  u: readonly number[];
  v: readonly number[];
  normal: readonly number[];
}

/** Where the plane cuts the mesh, in the plane's 2D coordinates. */
export interface SectionChain {
  points: Vec2[];
  /** The last point joins the first (it is not repeated). */
  closed: boolean;
}

/** An arc runs from `a` to `b`, counter-clockwise when `ccw`. */
export type SectionPiece =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "arc"; center: Vec2; radius: number; a: Vec2; b: Vec2; ccw: boolean }
  | { kind: "circle"; center: Vec2; radius: number };

/**
 * Cuts the triangles (`positions` xyz, `indices` triples, or a plain triangle soup) at the frame's
 * plane. Vertices are welded first, so neighbouring triangles share their crossing points and the
 * pieces join into chains.
 */
export function sectionMesh(positions: ArrayLike<number>, indices: ArrayLike<number> | null, frame: SectionFrame): SectionChain[] {
  const [o, u, v, n] = [frame.origin, frame.u, frame.v, frame.normal];
  const ids = new Map<string, number>();
  const weld: number[] = [];
  const dist: number[] = [];
  const at: Vec2[] = [];
  for (let i = 0; i < positions.length / 3; i++) {
    const p = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const key = `${Math.round(p[0]! * 1e4)},${Math.round(p[1]! * 1e4)},${Math.round(p[2]! * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = dist.length;
      ids.set(key, id);
      const d = [p[0]! - o[0]!, p[1]! - o[1]!, p[2]! - o[2]!];
      const h = d[0]! * n[0]! + d[1]! * n[1]! + d[2]! * n[2]!;
      // A vertex on the plane counts as just above it, so every crossing is between two vertices.
      dist.push(Math.abs(h) < 1e-9 ? 1e-9 : h);
      at.push([d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!, d[0]! * v[0]! + d[1]! * v[1]! + d[2]! * v[2]!]);
    }
    weld.push(id);
  }
  const count = dist.length;
  const tri = (k: number) => (indices ? indices[k]! : k);
  const triangles = (indices ? indices.length : positions.length / 3) / 3;
  const cross = new Map<number, Vec2>();
  const crossing = (a: number, b: number): number => {
    const key = a < b ? a * count + b : b * count + a;
    if (!cross.has(key)) {
      const t = dist[a]! / (dist[a]! - dist[b]!);
      cross.set(key, [at[a]![0] + (at[b]![0] - at[a]![0]) * t, at[a]![1] + (at[b]![1] - at[a]![1]) * t]);
    }
    return key;
  };
  const segments: [number, number][] = [];
  const touching = new Map<number, number[]>();
  for (let t = 0; t < triangles; t++) {
    const vs = [weld[tri(t * 3)]!, weld[tri(t * 3 + 1)]!, weld[tri(t * 3 + 2)]!];
    if (vs[0] === vs[1] || vs[1] === vs[2] || vs[0] === vs[2]) continue;
    const ends: number[] = [];
    for (let e = 0; e < 3; e++) {
      const [a, b] = [vs[e]!, vs[(e + 1) % 3]!];
      if (dist[a]! > 0 !== dist[b]! > 0) ends.push(crossing(a, b));
    }
    if (ends.length !== 2) continue;
    const s = segments.length;
    segments.push([ends[0]!, ends[1]!]);
    for (const k of ends) touching.set(k, [...(touching.get(k) ?? []), s]);
  }
  // Chains: walk from segment to segment through the crossing points they share.
  const used = new Uint8Array(segments.length);
  const chains: SectionChain[] = [];
  const walk = (from: number, key: number): number[] => {
    const keys: number[] = [];
    let seg = from;
    let cur = key;
    for (;;) {
      const next = touching.get(cur)?.find((s) => !used[s] && s !== seg);
      if (next === undefined) return keys;
      used[next] = 1;
      seg = next;
      const [a, b] = segments[next]!;
      cur = a === cur ? b : a;
      keys.push(cur);
    }
  };
  for (let s = 0; s < segments.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const [a, b] = segments[s]!;
    const forward = walk(s, b);
    const closed = forward[forward.length - 1] === a;
    const keys = closed ? [a, b, ...forward.slice(0, -1)] : [...walk(s, a).reverse(), a, b, ...forward];
    const points = keys.map((k) => cross.get(k)!);
    if (points.length >= 2) chains.push({ points, closed });
  }
  return chains;
}

/**
 * Lines, arcs and whole circles that follow a chain within `tol`: from each break, the longer of
 * the straight run and the round run that still fit wins. Corners between two lines are put where
 * the lines meet, so a scan's slightly rounded edge still gives a sharp corner.
 */
export function fitSection(chain: SectionChain, tol: number): SectionPiece[] {
  let pts = dedupe(chain.points, chain.closed, tol * 0.05);
  if (pts.length < 2) return [];
  if (chain.closed && pts.length >= 6) {
    const c = fitCircle(pts);
    if (c && c.r > tol * 2 && pts.every((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= tol)) return [{ kind: "circle", center: [c.cx, c.cy], radius: c.r }];
  }
  let raw: Run[];
  if (chain.closed) {
    // Start at the sharpest corner, then once more at the first break found from there: that is a
    // real break, so no straight edge or arc is split at the seam.
    const ring = (s: number) => [...pts.slice(s), ...pts.slice(0, s), pts[s]!];
    const s = sharpest(pts, tol * 3);
    const first = segment(ring(s), tol);
    if (first.length > 1) pts = ring((s + first[0]!.j) % pts.length);
    // A closed ring in one run would be a whole circle, which is taken above: a guard only.
    /* v8 ignore start */
    else pts = ring(s);
    /* v8 ignore stop */
    raw = first.length > 1 ? segment(pts, tol) : first;
  } else raw = segment(pts, tol);
  const last = pts.length - 1;
  // Break points, moved onto the arcs and to where neighbouring lines meet.
  const lines = raw.map((r) => (r.arc ? null : lineFit(pts.slice(r.i, r.j + 1))));
  const verts: Vec2[] = raw.map((r) => pts[r.i]!);
  verts.push(pts[last]!);
  const m = raw.length;
  for (let k = 0; k <= m; k++) {
    if (!chain.closed && (k === 0 || k === m)) continue;
    const before = raw[(k - 1 + m) % m]!;
    const after = raw[k % m]!;
    const [la, lb] = [lines[(k - 1 + m) % m], lines[k % m]];
    let q = verts[k]!;
    if (la && lb) {
      const x = meet(la, lb);
      if (x && Math.hypot(x[0] - q[0], x[1] - q[1]) < tol * 10) q = x;
    } else if ((la && after.arc) || (lb && before.arc)) {
      // A line running into an arc: where it touches the circle, when it does (within the
      // tolerance), else the break moved onto the circle. A tangent line fits a little way into
      // the arc, so the break itself sits too far along.
      const [l, c] = la ? [la, after.arc!] : [lb!, before.arc!];
      const t = (c.cx - l.p[0]) * l.d[0] + (c.cy - l.p[1]) * l.d[1];
      const foot: Vec2 = [l.p[0] + l.d[0] * t, l.p[1] + l.d[1] * t];
      q = Math.abs(Math.hypot(foot[0] - c.cx, foot[1] - c.cy) - c.r) < tol * 2 ? foot : toCircle(q, c);
    } else {
      const on: Vec2[] = [];
      for (const r of [before, after]) if (r.arc) on.push(toCircle(q, r.arc));
      q = [on.reduce((s, p) => s + p[0], 0) / on.length, on.reduce((s, p) => s + p[1], 0) / on.length];
    }
    verts[k] = q;
    if (chain.closed && k === 0) verts[m] = q;
    if (chain.closed && k === m) verts[0] = q;
  }
  const pieces: SectionPiece[] = [];
  for (let k = 0; k < m; k++) {
    const r = raw[k]!;
    const [a, b] = [verts[k]!, verts[k + 1]!];
    if (r.arc) pieces.push({ kind: "arc", center: [r.arc.cx, r.arc.cy], radius: r.arc.r, a, b, ccw: r.arc.sweep > 0 });
    else if (Math.hypot(b[0] - a[0], b[1] - a[1]) > tol * 0.1) pieces.push({ kind: "line", a, b });
  }
  return pieces;
}

type Run = { i: number; j: number; arc?: ArcFit };

/** From each break, the longer of the straight run and the round run that still fit. */
function segment(pts: Vec2[], tol: number): Run[] {
  const last = pts.length - 1;
  const raw: Run[] = [];
  for (let i = 0; i < last; ) {
    const jl = reach(i + 1, last, (j) => fitsLine(pts, i, j, tol));
    let arc: ArcFit | null = null;
    const ja = i + 3 <= last && arcFit(pts, i, i + 3, tol) ? reach(i + 3, last, (j) => !!arcFit(pts, i, j, tol)) : -1;
    if (ja > jl + 1) {
      arc = arcFit(pts, i, ja, tol);
      // A circle so flat that a line nearly fits it is a wavy line.
      if (arc && arc.r * (1 - Math.cos(Math.abs(arc.sweep) / 2)) < tol * 2) arc = null;
    }
    if (arc) {
      raw.push({ i, j: ja, arc });
      i = ja;
    } else {
      raw.push({ i, j: jl });
      i = jl;
    }
  }
  return raw;
}

interface ArcFit {
  cx: number;
  cy: number;
  r: number;
  /** Signed sweep from the first point to the last (radians, positive counter-clockwise). */
  sweep: number;
}

function dedupe(points: Vec2[], closed: boolean, eps: number): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > eps) out.push(p);
  }
  while (closed && out.length > 2 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= eps) out.pop();
  return out;
}

/** Index of the point where a closed chain turns most, looking `span` away on either side. */
function sharpest(pts: Vec2[], span: number): number {
  const n = pts.length;
  let best = 0;
  let turn = -1;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    let [a, b] = [p, p];
    for (let k = 1; k < n / 2; k++) {
      a = pts[(i - k + n) % n]!;
      if (Math.hypot(a[0] - p[0], a[1] - p[1]) >= span) break;
    }
    for (let k = 1; k < n / 2; k++) {
      b = pts[(i + k) % n]!;
      if (Math.hypot(b[0] - p[0], b[1] - p[1]) >= span) break;
    }
    const d1 = Math.atan2(p[1] - a[1], p[0] - a[0]);
    const d2 = Math.atan2(b[1] - p[1], b[0] - p[0]);
    const t = Math.abs(((d2 - d1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
    if (t > turn) {
      turn = t;
      best = i;
    }
  }
  return best;
}

/** Farthest j in [first, last] for which `ok(j)` holds (assumed for `first`): doubling, then halving. */
function reach(first: number, last: number, ok: (j: number) => boolean): number {
  let lo = first;
  let step = 1;
  let hi = -1;
  while (lo < last) {
    const j = Math.min(last, lo + step);
    if (!ok(j)) {
      hi = j;
      break;
    }
    lo = j;
    step *= 2;
  }
  if (hi < 0) return lo;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Every point from i to j lies within tol of the chord, in order along it. */
function fitsLine(pts: Vec2[], i: number, j: number, tol: number): boolean {
  const [a, b] = [pts[i]!, pts[j]!];
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l = Math.hypot(dx, dy);
  if (l < 1e-12) return false;
  for (let k = i + 1; k < j; k++) {
    const [px, py] = [pts[k]![0] - a[0], pts[k]![1] - a[1]];
    if (Math.abs(px * dy - py * dx) / l > tol) return false;
    const along = (px * dx + py * dy) / l;
    if (along < -tol || along > l + tol) return false;
  }
  return true;
}

/** A circle through the points from i to j within tol, going round one way, short of a full turn. */
function arcFit(pts: Vec2[], i: number, j: number, tol: number): ArcFit | null {
  const run = pts.slice(i, j + 1);
  const c = fitCircle(run);
  if (!c || !(c.r > tol)) return null;
  let sweep = 0;
  let prev = Math.atan2(run[0]![1] - c.cy, run[0]![0] - c.cx);
  let dir = 0;
  for (const p of run) {
    if (Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) > tol) return null;
    const a = Math.atan2(p[1] - c.cy, p[0] - c.cx);
    const d = ((a - prev + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
    prev = a;
    sweep += d;
    // Steps back by more than the noise mean the points do not go round the circle.
    if (Math.abs(d) * c.r > tol) {
      if (dir && Math.sign(d) !== dir) return null;
      dir = Math.sign(d);
    }
  }
  if (Math.abs(sweep) > 2 * Math.PI - 0.05) return null;
  return { cx: c.cx, cy: c.cy, r: c.r, sweep };
}

/** Straight line through points (total least squares) as a point and a unit direction. */
function lineFit(pts: Vec2[]): { p: Vec2; d: Vec2 } {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let [sxx, sxy, syy] = [0, 0, 0];
  for (const [x, y] of pts) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (y - my);
    syy += (y - my) ** 2;
  }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(ang), Math.sin(ang)] };
}

/** Where two lines cross, or null when they are within 10° of parallel. */
function meet(a: { p: Vec2; d: Vec2 }, b: { p: Vec2; d: Vec2 }): Vec2 | null {
  const den = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(den) < Math.sin((10 * Math.PI) / 180)) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / den;
  return [a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t];
}

function toCircle(q: Vec2, c: ArcFit): Vec2 {
  const a = Math.atan2(q[1] - c.cy, q[0] - c.cx);
  return [c.cx + c.r * Math.cos(a), c.cy + c.r * Math.sin(a)];
}
