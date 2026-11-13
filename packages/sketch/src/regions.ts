/**
 * Planar arrangement of sketch curves → closed regions (faces with holes).
 *
 * Curves are split at all mutual intersections, dangling pieces are dropped, and faces are traced
 * on the half-edge graph. Region keys are built from the curve pieces that bound them, so they stay
 * stable when dimensions change without changing topology.
 */

import { arcPoint, sweep, type SolvedCurve, type Vec2 } from "./geometry.js";

/** Lines, circles and arcs: what regions are built from (splines become short lines first). */
type Basic = Exclude<SolvedCurve, { kind: "spline" }>;

/**
 * Splines as the short lines of their samples, named "<spline>~<n>" (the kernel joins consecutive
 * pieces of one spline back into a smooth curve); other curves pass through.
 */
export function expandSplines(curves: readonly SolvedCurve[]): Basic[] {
  return curves.flatMap((c): Basic[] =>
    c.kind !== "spline"
      ? [c]
      : c.pts.slice(1).map((b, k) => ({ id: `${c.id}~${k}`, kind: "line", a: c.pts[k]!, b, p1: "", p2: "", construction: c.construction, external: c.external })),
  );
}

export type LoopSegment =
  | { kind: "line"; a: Vec2; b: Vec2 }
  /** Arc from angle `from` to `to`; `ccw` gives the travel direction. */
  | { kind: "arc"; center: Vec2; radius: number; from: number; to: number; ccw: boolean }
  | { kind: "circle"; center: Vec2; radius: number; ccw: boolean };

export interface LoopEdge {
  /** Piece name: the curve id, or `${curve}:${k}` when the curve was split. */
  name: string;
  curve: string;
  seg: LoopSegment;
}

export interface Region {
  /** Stable key, e.g. "l1+l2+l3+l4|c1" (outer loop pieces, then holes). */
  key: string;
  /** Counter-clockwise outer loop. */
  outer: LoopEdge[];
  /** Clockwise hole loops. */
  holes: LoopEdge[][];
  area: number;
  /** Crossings from the unbounded face; odd = filled under the even-odd rule. */
  depth: number;
  /** A point strictly inside the region. */
  sample: Vec2;
  /** Polyline approximations (outer, then holes) for picking and display. */
  polygons: Vec2[][];
}

type Piece =
  | { kind: "line"; a: Vec2; b: Vec2 }
  | { kind: "arc"; center: Vec2; radius: number; a0: number; a1: number };

interface Edge {
  name: string;
  curve: string;
  piece: Piece;
  v0: number;
  v1: number;
  alive: boolean;
}

const TAU = 2 * Math.PI;

export function findRegions(curves: readonly SolvedCurve[]): Region[] {
  const solid = expandSplines(curves).filter((c) => !c.construction);
  if (!solid.length) return [];
  const scale = Math.max(1, ...solid.flatMap(extentOf));
  const eps = scale * 1e-9;
  const tol = scale * 1e-7;

  // 1. split parameters per curve
  const params = new Map<string, number[]>();
  for (const c of solid) params.set(c.id, c.kind === "line" ? [0, 1] : c.kind === "arc" ? [c.a0, c.a0 + sweep(c.a0, c.a1)] : []);
  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      for (const [pi, pj] of intersect(solid[i]!, solid[j]!, eps)) {
        params.get(solid[i]!.id)!.push(pi);
        params.get(solid[j]!.id)!.push(pj);
      }
    }
  }

  // 2. pieces
  const verts: Vec2[] = [];
  const vertexAt = (p: Vec2): number => {
    for (let i = 0; i < verts.length; i++) if (Math.hypot(verts[i]![0] - p[0], verts[i]![1] - p[1]) < tol) return i;
    verts.push(p);
    return verts.length - 1;
  };
  const edges: Edge[] = [];
  const standalone: Basic[] = [];
  for (const c of solid) {
    const ps = params.get(c.id)!;
    if (c.kind === "line") {
      const ts = uniq(ps.filter((t) => t >= -1e-12 && t <= 1 + 1e-12).sort((a, b) => a - b), 1e-9);
      const pieces: Piece[] = [];
      for (let k = 0; k + 1 < ts.length; k++) {
        const a = lerp(c.a, c.b, ts[k]!);
        const b = lerp(c.a, c.b, ts[k + 1]!);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > tol) pieces.push({ kind: "line", a, b });
      }
      pushPieces(c.id, pieces);
    } else if (c.kind === "arc") {
      const start = c.a0;
      const span = sweep(c.a0, c.a1);
      // A crossing within `tol` of an end is that end: solved arcs are off their ends by rounding,
      // and splitting there would leave a sliver piece (and a region without area).
      const at = Math.max(1e-9, tol / c.radius);
      const rel = uniq(
        ps
          .map((a) => normAngle(a - start))
          .map((r) => (r > span + at ? r - TAU : r))
          .filter((r) => r >= -at && r <= span + at)
          .map((r) => (Math.abs(r) < at ? 0 : Math.abs(r - span) < at ? span : r)),
        at,
      );
      rel.sort((a, b) => a - b);
      // The arc's own ends are always among its split parameters (step 1): kept as a guard only.
      /* v8 ignore next 2 */
      if (rel[0]! > at) rel.unshift(0);
      if (rel.at(-1)! < span - at) rel.push(span);
      const pieces: Piece[] = [];
      for (let k = 0; k + 1 < rel.length; k++) pieces.push({ kind: "arc", center: c.center, radius: c.radius, a0: start + rel[k]!, a1: start + rel[k + 1]! });
      pushPieces(c.id, pieces);
    } else {
      const at = Math.max(1e-9, tol / c.radius);
      let as = uniq(ps.map(normAngle).sort((a, b) => a - b), at);
      if (as.length > 1 && as[0]! + TAU - as.at(-1)! < at) as = as.slice(0, -1);
      if (as.length === 0) {
        standalone.push(c);
        continue;
      }
      if (as.length === 1) as.push(as[0]! + Math.PI);
      const pieces: Piece[] = [];
      for (let k = 0; k < as.length; k++) {
        const a0 = as[k]!;
        const a1 = k + 1 < as.length ? as[k + 1]! : as[0]! + TAU;
        pieces.push({ kind: "arc", center: c.center, radius: c.radius, a0, a1 });
      }
      pushPieces(c.id, pieces);
    }
  }
  function pushPieces(curve: string, pieces: Piece[]): void {
    pieces.forEach((piece, k) => {
      const [s, e] = ends(piece);
      edges.push({ name: pieces.length > 1 ? `${curve}:${k}` : curve, curve, piece, v0: vertexAt(s), v1: vertexAt(e), alive: true });
    });
  }

  // 3. drop dangling pieces (vertices of degree 1)
  for (let changed = true; changed; ) {
    changed = false;
    const deg = new Array<number>(verts.length).fill(0);
    for (const e of edges) if (e.alive) {
      deg[e.v0]!++;
      deg[e.v1]!++;
    }
    for (const e of edges) if (e.alive && (deg[e.v0] === 1 || deg[e.v1] === 1)) {
      e.alive = false;
      changed = true;
    }
  }
  const live = edges.filter((e) => e.alive);

  // 4. half-edges sorted by direction around each vertex
  interface Half { edge: Edge; fwd: boolean; from: number; to: number; angle: number }
  const halves: Half[] = [];
  for (const e of live) {
    halves.push({ edge: e, fwd: true, from: e.v0, to: e.v1, angle: leaveAngle(e.piece, true) });
    halves.push({ edge: e, fwd: false, from: e.v1, to: e.v0, angle: leaveAngle(e.piece, false) });
  }
  const twin = (i: number) => i ^ 1;
  const around = new Map<number, number[]>();
  halves.forEach((h, i) => {
    const list = around.get(h.from) ?? [];
    list.push(i);
    around.set(h.from, list);
  });
  for (const list of around.values()) list.sort((a, b) => halves[a]!.angle - halves[b]!.angle);
  const next = (i: number): number => {
    const t = twin(i);
    const list = around.get(halves[t]!.from)!;
    const k = list.indexOf(t);
    return list[(k - 1 + list.length) % list.length]!;
  };

  // 5. trace cycles
  const cycleOf = new Array<number>(halves.length).fill(-1);
  const cycles: number[][] = [];
  for (let i = 0; i < halves.length; i++) {
    if (cycleOf[i] !== -1) continue;
    const cyc: number[] = [];
    for (let h = i; cycleOf[h] === -1; h = next(h)) {
      cycleOf[h] = cycles.length;
      cyc.push(h);
      // Every half-edge has one successor, so a cycle closes within all of them: a guard only.
      /* v8 ignore next */
      if (cyc.length > halves.length) break;
    }
    cycles.push(cyc);
  }
  const loopOf = (cyc: number[]): LoopEdge[] =>
    cyc.map((i) => {
      const h = halves[i]!;
      return { name: h.edge.name, curve: h.edge.curve, seg: toSegment(h.edge.piece, h.fwd) };
    });

  interface Cycle { loop: LoopEdge[]; area: number; polygon: Vec2[]; component: number }
  // components via union-find on vertices
  const parent = verts.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (const e of live) parent[find(e.v0)] = find(e.v1);
  const all: Cycle[] = cycles.map((cyc) => {
    const loop = loopOf(cyc);
    return { loop, area: loopArea(loop), polygon: polygonOf(loop), component: find(halves[cyc[0]!]!.from) };
  });
  // standalone circles: a positive and a negative cycle each, in their own component
  standalone.forEach((c, k) => {
    // Only circles are left standalone (step 2); this narrows the type.
    /* v8 ignore next */
    if (c.kind !== "circle") return;
    const ccw: LoopEdge[] = [{ name: c.id, curve: c.id, seg: { kind: "circle", center: c.center, radius: c.radius, ccw: true } }];
    const cw: LoopEdge[] = [{ name: c.id, curve: c.id, seg: { kind: "circle", center: c.center, radius: c.radius, ccw: false } }];
    const comp = -1 - k;
    all.push({ loop: ccw, area: loopArea(ccw), polygon: polygonOf(ccw), component: comp });
    all.push({ loop: cw, area: loopArea(cw), polygon: polygonOf(cw), component: comp });
  });

  const bounded = all.map((c, i) => i).filter((i) => all[i]!.area > tol * tol);
  const outerCycles = all.map((c, i) => i).filter((i) => all[i]!.area < -tol * tol);

  // 6. assign each component's outer boundary as a hole of the smallest enclosing bounded face
  const holeOf = new Map<number, number>(); // negative cycle -> bounded cycle (or -1 = unbounded)
  for (const n of outerCycles) {
    const probe = all[n]!.polygon[0]!;
    let best = -1;
    for (const b of bounded) {
      if (all[b]!.component === all[n]!.component) continue;
      if (pointInPolygon(probe, all[b]!.polygon) && (best === -1 || all[b]!.area < all[best]!.area)) best = b;
    }
    holeOf.set(n, best);
  }

  // 7. depth by BFS over shared pieces, starting from the unbounded face (-1)
  const faceOfCycle = (ci: number) => (all[ci]!.area > 0 ? ci : (holeOf.get(ci) ?? -1));
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (a === b) return;
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  };
  for (let i = 0; i < halves.length; i += 2) link(faceOfCycle(cycleOf[i]!), faceOfCycle(cycleOf[i + 1]!));
  standalone.forEach((_, k) => {
    const pos = cycles.length + 2 * k;
    link(faceOfCycle(pos), faceOfCycle(pos + 1));
  });
  const depth = new Map<number, number>([[-1, 0]]);
  for (let queue = [-1]; queue.length; ) {
    const f = queue.shift()!;
    for (const g of adj.get(f) ?? []) if (!depth.has(g)) {
      depth.set(g, depth.get(f)! + 1);
      queue.push(g);
    }
  }

  // 8. regions
  return bounded.map((b) => {
    const holes = outerCycles.filter((n) => holeOf.get(n) === b).map((n) => all[n]!);
    const outer = all[b]!;
    const keyOf = (loop: LoopEdge[]) => [...new Set(loop.map((e) => e.name))].sort().join("+");
    const key = [keyOf(outer.loop), ...holes.map((h) => keyOf(h.loop)).sort()].join("|");
    const polygons = [outer.polygon, ...holes.map((h) => h.polygon)];
    return {
      key,
      outer: outer.loop,
      holes: holes.map((h) => h.loop),
      area: outer.area + holes.reduce((s, h) => s + h.area, 0),
      depth: depth.get(b) ?? 1,
      sample: interiorPoint(polygons),
      polygons,
    };
  });
}

/** Regions selected by a profile reference: explicit keys, or the even-odd rule for "all". */
export function selectRegions(regions: readonly Region[], which: "all" | readonly string[] | undefined): { regions: Region[]; missing: string[] } {
  if (which === undefined || which === "all") return { regions: regions.filter((r) => r.depth % 2 === 1), missing: [] };
  const byKey = new Map(regions.map((r) => [r.key, r]));
  return { regions: which.flatMap((k) => byKey.get(k) ?? []), missing: which.filter((k) => !byKey.has(k)) };
}

export function regionAt(regions: readonly Region[], p: Vec2): Region | undefined {
  return regions
    .filter((r) => pointInPolygon(p, r.polygons[0]!) && !r.polygons.slice(1).some((h) => pointInPolygon(p, h)))
    // The faces of one sketch do not overlap, so at most one is left: the smallest wins if ever two are.
    /* v8 ignore start */
    .sort((a, b) => a.area - b.area)[0];
  /* v8 ignore stop */
}

// ---------------------------------------------------------------- geometry

function extentOf(c: Basic): number[] {
  if (c.kind === "line") return [...c.a, ...c.b].map(Math.abs);
  return [Math.abs(c.center[0]) + c.radius, Math.abs(c.center[1]) + c.radius];
}

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const normAngle = (a: number) => ((a % TAU) + TAU) % TAU;
function uniq(xs: number[], eps: number): number[] {
  const out: number[] = [];
  for (const x of xs) if (!out.some((y) => Math.abs(y - x) < eps)) out.push(x);
  return out;
}

function ends(p: Piece): [Vec2, Vec2] {
  return p.kind === "line" ? [p.a, p.b] : [arcPoint(p.center, p.radius, p.a0), arcPoint(p.center, p.radius, p.a1)];
}

/** Direction leaving the start (fwd) or end (!fwd) of a piece, probed slightly inside to separate tangent curves. */
function leaveAngle(p: Piece, fwd: boolean): number {
  if (p.kind === "line") {
    const [a, b] = fwd ? [p.a, p.b] : [p.b, p.a];
    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }
  const span = p.a1 - p.a0;
  const t = Math.min(span * 1e-3, 1e-3);
  const [from, probe] = fwd ? [p.a0, p.a0 + t] : [p.a1, p.a1 - t];
  const s = arcPoint(p.center, p.radius, from);
  const q = arcPoint(p.center, p.radius, probe);
  return Math.atan2(q[1] - s[1], q[0] - s[0]);
}

function toSegment(p: Piece, fwd: boolean): LoopSegment {
  if (p.kind === "line") return fwd ? { kind: "line", a: p.a, b: p.b } : { kind: "line", a: p.b, b: p.a };
  return fwd
    ? { kind: "arc", center: p.center, radius: p.radius, from: p.a0, to: p.a1, ccw: true }
    : { kind: "arc", center: p.center, radius: p.radius, from: p.a1, to: p.a0, ccw: false };
}

function segArea(s: LoopSegment): number {
  if (s.kind === "line") return (s.a[0] * s.b[1] - s.b[0] * s.a[1]) / 2;
  const [cx, cy] = s.center;
  const r = s.radius;
  let d: number;
  let t0: number;
  if (s.kind === "circle") {
    t0 = 0;
    d = s.ccw ? TAU : -TAU;
  } else {
    t0 = s.from;
    d = s.ccw ? sweep(s.from, s.to) : -sweep(s.to, s.from);
  }
  const t1 = t0 + d;
  return (r * r * d + r * cx * (Math.sin(t1) - Math.sin(t0)) - r * cy * (Math.cos(t1) - Math.cos(t0))) / 2;
}

export function loopArea(loop: readonly LoopEdge[]): number {
  return loop.reduce((s, e) => s + segArea(e.seg), 0);
}

export function polygonOf(loop: readonly LoopEdge[]): Vec2[] {
  const pts: Vec2[] = [];
  for (const { seg } of loop) {
    if (seg.kind === "line") pts.push(seg.a);
    else {
      const from = seg.kind === "circle" ? 0 : seg.from;
      const d = seg.kind === "circle" ? (seg.ccw ? TAU : -TAU) : seg.ccw ? sweep(seg.from, seg.to) : -sweep(seg.to, seg.from);
      const n = Math.max(2, Math.ceil(Math.abs(d) / (Math.PI / 36)));
      for (let k = 0; k < n; k++) pts.push(arcPoint(seg.center, seg.radius, from + (d * k) / n));
    }
  }
  return pts;
}

export function pointInPolygon(p: Vec2, poly: readonly Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!;
    const [xj, yj] = poly[j]!;
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function interiorPoint(polys: Vec2[][]): Vec2 {
  const inside = (p: Vec2) => pointInPolygon(p, polys[0]!) && !polys.slice(1).some((h) => pointInPolygon(p, h));
  const outer = polys[0]!;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of outer) {
    cx += x;
    cy += y;
  }
  const c: Vec2 = [cx / outer.length, cy / outer.length];
  if (inside(c)) return c;
  // Step inward (left of the CCW outer loop) from edge midpoints at shrinking distances.
  for (const f of [0.2, 0.05, 0.01, 0.001]) {
    for (let i = 0; i < outer.length; i++) {
      const a = outer[i]!;
      const b = outer[(i + 1) % outer.length]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len === 0) continue;
      const m: Vec2 = [(a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * len * f, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * len * f];
      if (inside(m)) return m;
    }
  }
  // A polygon with area always has a point left of some edge's midpoint: a guard only.
  /* v8 ignore next */
  return c;
}

/** Intersection parameters (t for lines in [0,1], absolute angle for arcs/circles). */
function intersect(c1: Basic, c2: Basic, eps: number): [number, number][] {
  if (c1.kind === "line" && c2.kind === "line") return lineLine(c1.a, c1.b, c2.a, c2.b, eps);
  if (c1.kind === "line") return lineCircle(c1.a, c1.b, c2 as Exclude<Basic, { kind: "line" }>, eps);
  if (c2.kind === "line") return lineCircle(c2.a, c2.b, c1, eps).map(([t, a]) => [a, t]);
  return circleCircle(c1, c2, eps);
}

function lineLine(a: Vec2, b: Vec2, c: Vec2, d: Vec2, eps: number): [number, number][] {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  const lr = Math.hypot(...r);
  const ls = Math.hypot(...s);
  if (Math.abs(den) < eps * Math.max(lr, ls)) return [];
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  const et = eps / (lr || 1);
  const eu = eps / (ls || 1);
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return [];
  return [[clamp01(t), clamp01(u)]];
}

function onArc(c: Exclude<Basic, { kind: "line" }>, ang: number, eps: number): boolean {
  if (c.kind === "circle") return true;
  const rel = normAngle(ang - c.a0);
  const span = sweep(c.a0, c.a1);
  const tolA = eps / c.radius;
  return rel <= span + tolA || rel >= TAU - tolA;
}

function lineCircle(a: Vec2, b: Vec2, c: Exclude<Basic, { kind: "line" }>, eps: number): [number, number][] {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const f: Vec2 = [a[0] - c.center[0], a[1] - c.center[1]];
  const A = d[0] * d[0] + d[1] * d[1];
  const B = 2 * (f[0] * d[0] + f[1] * d[1]);
  const C = f[0] * f[0] + f[1] * f[1] - c.radius * c.radius;
  let disc = B * B - 4 * A * C;
  const len = Math.sqrt(A);
  if (disc < 0) {
    // tangent within tolerance
    if (disc > -4 * A * (2 * c.radius * eps)) disc = 0;
    else return [];
  }
  const sq = Math.sqrt(disc);
  const ts = disc === 0 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  const et = eps / (len || 1);
  const out: [number, number][] = [];
  for (const t of ts) {
    if (t < -et || t > 1 + et) continue;
    const p = lerp(a, b, t);
    const ang = Math.atan2(p[1] - c.center[1], p[0] - c.center[0]);
    if (onArc(c, ang, eps)) out.push([clamp01(t), ang]);
  }
  return out;
}

function circleCircle(c1: Exclude<Basic, { kind: "line" }>, c2: Exclude<Basic, { kind: "line" }>, eps: number): [number, number][] {
  const dx = c2.center[0] - c1.center[0];
  const dy = c2.center[1] - c1.center[1];
  const d = Math.hypot(dx, dy);
  if (d < eps) return [];
  if (d > c1.radius + c2.radius + eps || d < Math.abs(c1.radius - c2.radius) - eps) return [];
  const a = (d * d + c1.radius * c1.radius - c2.radius * c2.radius) / (2 * d);
  const h2 = c1.radius * c1.radius - a * a;
  const h = h2 > 0 ? Math.sqrt(h2) : 0;
  const mx = c1.center[0] + (a * dx) / d;
  const my = c1.center[1] + (a * dy) / d;
  const pts: Vec2[] = h < eps ? [[mx, my]] : [
    [mx + (h * dy) / d, my - (h * dx) / d],
    [mx - (h * dy) / d, my + (h * dx) / d],
  ];
  const out: [number, number][] = [];
  for (const p of pts) {
    const a1 = Math.atan2(p[1] - c1.center[1], p[0] - c1.center[0]);
    const a2 = Math.atan2(p[1] - c2.center[1], p[0] - c2.center[0]);
    if (onArc(c1, a1, eps) && onArc(c2, a2, eps)) out.push([a1, a2]);
  }
  return out;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Intersection points of two solved curves (used by the sketch trim tool). */
export function intersectionPoints(a: SolvedCurve, b: SolvedCurve): Vec2[] {
  const out: Vec2[] = [];
  // Splines meet others where their short lines do.
  for (const x of expandSplines([a])) {
    for (const y of expandSplines([b])) {
      const scale = Math.max(1, ...extentOf(x), ...extentOf(y));
      for (const [pa] of intersect(x, y, scale * 1e-9)) out.push(x.kind === "line" ? lerp(x.a, x.b, pa) : arcPoint(x.center, x.radius, pa));
    }
  }
  // Neighbouring pieces of a spline meet at their shared sample point: keep it once.
  return out.filter((p, i) => out.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1e-9) === i);
}
