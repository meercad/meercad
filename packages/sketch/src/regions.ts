/**
 * Planar arrangement of sketch curves → closed regions (faces with holes).
 *
 * Curves are split at all mutual intersections, dangling pieces are dropped, and faces are traced
 * on the half-edge graph. Region keys are built from the curve pieces that bound them, so they stay
 * stable when dimensions change without changing topology.
 */

import { arcPoint, sweep, type SolvedCurve, type Vec2, distance2 } from "./geometry.js";

/** Lines, circles and arcs: what regions are built from (splines become short lines first). */
type Basic = Exclude<SolvedCurve, { kind: "spline" }>;

/**
 * Splines as the short lines of their samples, named "<spline>~<n>" (the kernel joins consecutive
 * pieces of one spline back into a smooth curve); other curves pass through.
 */
export function expandSplines(curves: readonly SolvedCurve[]): Basic[] {
  return curves.flatMap((curve): Basic[] =>
    curve.kind !== "spline"
      ? [curve]
      : curve.pts.slice(1).map((b, k) => ({
          id: `${curve.id}~${k}`,
          kind: "line",
          a: curve.pts[k]!,
          b,
          p1: "",
          p2: "",
          construction: curve.construction,
          external: curve.external,
        })),
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
  { kind: "line"; a: Vec2; b: Vec2 } | { kind: "arc"; center: Vec2; radius: number; a0: number; a1: number };

interface Edge {
  name: string;
  curve: string;
  piece: Piece;
  v0: number;
  v1: number;
  alive: boolean;
}

const TAU = 2 * Math.PI;

/** One direction of travel along an edge; the two directions of an edge sit at indices 2n and 2n + 1. */
interface HalfEdge {
  edge: Edge;
  forward: boolean;
  from: number;
  to: number;
  /** Direction in which it leaves `from`. */
  angle: number;
}

/** A closed walk along half-edges: counter-clockwise (positive area) round a face, clockwise round a hole. */
interface Cycle {
  loop: LoopEdge[];
  area: number;
  polygon: Vec2[];
  /** Connected group of curves it belongs to; standalone circles get negative numbers. */
  component: number;
}

/** The unbounded face outside everything. */
const OUTSIDE = -1;

export function findRegions(curves: readonly SolvedCurve[]): Region[] {
  const solid = expandSplines(curves).filter((c) => !c.construction);
  if (!solid.length) return [];

  const scale = Math.max(1, ...solid.flatMap(extentOf));
  const eps = scale * 1e-9;
  const tol = scale * 1e-7;

  const { vertexCount, edges, standaloneCircles } = splitIntoPieces(
    solid,
    crossingParameters(solid, eps),
    tol,
  );

  dropDanglingEdges(edges, vertexCount);

  const live = edges.filter((edge) => edge.alive);
  const halves = halfEdgesOf(live);
  const { cycles: walks, cycleOf } = traceCycles(halves);
  const cycles = describeCycles(walks, halves, live, vertexCount, standaloneCircles);

  const bounded = cycles.map((cycle, i) => i).filter((i) => cycles[i]!.area > tol * tol);
  const outerCycles = cycles.map((cycle, i) => i).filter((i) => cycles[i]!.area < -tol * tol);
  const holeOf = assignHoles(cycles, bounded, outerCycles);

  // The face a cycle borders: itself when it runs round a face, otherwise the face its hole lies in.
  const faceOfCycle = (cycle: number) => (cycles[cycle]!.area > 0 ? cycle : (holeOf.get(cycle) ?? OUTSIDE));
  const neighbours = new FaceNeighbours();

  for (let i = 0; i < halves.length; i += 2) {
    neighbours.link(faceOfCycle(cycleOf[i]!), faceOfCycle(cycleOf[i + 1]!));
  }

  standaloneCircles.forEach((_, k) => {
    const positive = walks.length + 2 * k;

    neighbours.link(faceOfCycle(positive), faceOfCycle(positive + 1));
  });

  const depth = neighbours.depthsFromOutside();

  return bounded.map((b) => {
    const holes = outerCycles.filter((n) => holeOf.get(n) === b).map((n) => cycles[n]!);
    const outer = cycles[b]!;
    const keyOf = (loop: LoopEdge[]) => [...new Set(loop.map((edge) => edge.name))].sort().join("+");
    const key = [keyOf(outer.loop), ...holes.map((cycle) => keyOf(cycle.loop)).sort()].join("|");
    const polygons = [outer.polygon, ...holes.map((cycle) => cycle.polygon)];

    return {
      key,
      outer: outer.loop,
      holes: holes.map((cycle) => cycle.loop),
      area: outer.area + holes.reduce((s, cycle) => s + cycle.area, 0),
      depth: depth.get(b) ?? 1,
      sample: interiorPoint(polygons),
      polygons,
    };
  });
}

/**
 * Per curve: the parameters where it is cut. Lines start with their two ends (0 and 1) and arcs
 * with their start and end angle; every crossing with another curve adds one.
 */
function crossingParameters(solid: readonly Basic[], eps: number): Map<string, number[]> {
  const params = new Map<string, number[]>();

  for (const c of solid) {
    params.set(c.id, c.kind === "line" ? [0, 1] : c.kind === "arc" ? [c.a0, c.a0 + sweep(c.a0, c.a1)] : []);
  }

  for (let i = 0; i < solid.length; i++) {
    for (let j = i + 1; j < solid.length; j++) {
      for (const [pi, pj] of intersect(solid[i]!, solid[j]!, eps)) {
        params.get(solid[i]!.id)!.push(pi);
        params.get(solid[j]!.id)!.push(pj);
      }
    }
  }

  return params;
}

/**
 * Cuts every curve at its crossings into pieces and joins them into a graph: each piece is an edge
 * between two vertices, and ends closer than `tol` are one vertex. Circles nothing crosses stay
 * apart: they have no vertex.
 */
function splitIntoPieces(
  solid: readonly Basic[],
  params: ReadonlyMap<string, number[]>,
  tol: number,
): { vertexCount: number; edges: Edge[]; standaloneCircles: Basic[] } {
  const vertices: Vec2[] = [];

  const vertexAt = (p: Vec2): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (distance2(p, vertices[i]!) < tol) return i;
    }

    vertices.push(p);

    return vertices.length - 1;
  };

  const edges: Edge[] = [];
  const standaloneCircles: Basic[] = [];

  const addPieces = (curve: string, pieces: Piece[]): void => {
    pieces.forEach((piece, k) => {
      const [start, end] = ends(piece);

      edges.push({
        name: pieces.length > 1 ? `${curve}:${k}` : curve,
        curve,
        piece,
        v0: vertexAt(start),
        v1: vertexAt(end),
        alive: true,
      });
    });
  };

  for (const c of solid) {
    const cuts = params.get(c.id)!;

    if (c.kind === "line") {
      addPieces(c.id, linePieces(c, cuts, tol));
    } else if (c.kind === "arc") {
      addPieces(c.id, arcPieces(c, cuts, tol));
    } else {
      const pieces = circlePieces(c, cuts, tol);

      if (pieces) addPieces(c.id, pieces);
      else standaloneCircles.push(c);
    }
  }

  return { vertexCount: vertices.length, edges, standaloneCircles };
}

function linePieces(line: Extract<Basic, { kind: "line" }>, cuts: readonly number[], tol: number): Piece[] {
  const ts = uniq(
    cuts.filter((t) => t >= -1e-12 && t <= 1 + 1e-12).sort((a, b) => a - b),
    1e-9,
  );
  const pieces: Piece[] = [];

  for (let k = 0; k + 1 < ts.length; k++) {
    const a = lerp(line.a, line.b, ts[k]!);
    const b = lerp(line.a, line.b, ts[k + 1]!);
    if (distance2(a, b) > tol) pieces.push({ kind: "line", a, b });
  }

  return pieces;
}

function arcPieces(arc: Extract<Basic, { kind: "arc" }>, cuts: readonly number[], tol: number): Piece[] {
  const start = arc.a0;
  const span = sweep(arc.a0, arc.a1);
  // A crossing within `tol` of an end is that end: solved arcs are off their ends by rounding,
  // and splitting there would leave a sliver piece (and a region without area).
  const at = Math.max(1e-9, tol / arc.radius);
  const rel = uniq(
    cuts
      .map((a) => normAngle(a - start))
      .map((r) => (r > span + at ? r - TAU : r))
      .filter((r) => r >= -at && r <= span + at)
      .map((r) => (Math.abs(r) < at ? 0 : Math.abs(r - span) < at ? span : r)),
    at,
  );

  rel.sort((a, b) => a - b);
  if (rel[0]! > at) rel.unshift(0);
  if (rel.at(-1)! < span - at) rel.push(span);

  const pieces: Piece[] = [];

  for (let k = 0; k + 1 < rel.length; k++) {
    pieces.push({
      kind: "arc",
      center: arc.center,
      radius: arc.radius,
      a0: start + rel[k]!,
      a1: start + rel[k + 1]!,
    });
  }

  return pieces;
}

/** The arcs a circle falls into at its crossings; null when nothing crosses it. */
function circlePieces(
  circle: Extract<Basic, { kind: "circle" }>,
  cuts: readonly number[],
  tol: number,
): Piece[] | null {
  const at = Math.max(1e-9, tol / circle.radius);
  let angles = uniq(
    cuts.map(normAngle).sort((a, b) => a - b),
    at,
  );

  // The first and the last crossing are the same point when they meet across 0.
  if (angles.length > 1 && angles[0]! + TAU - angles.at(-1)! < at) angles = angles.slice(0, -1);
  if (angles.length === 0) return null;
  // A single crossing: cut the circle a second time opposite to it, so each piece has two ends.
  if (angles.length === 1) angles.push(angles[0]! + Math.PI);

  const pieces: Piece[] = [];

  for (let k = 0; k < angles.length; k++) {
    const a0 = angles[k]!;
    const a1 = k + 1 < angles.length ? angles[k + 1]! : angles[0]! + TAU;

    pieces.push({ kind: "arc", center: circle.center, radius: circle.radius, a0, a1 });
  }

  return pieces;
}

/** Marks pieces that lead nowhere as dead: an edge at a vertex no other edge reaches, again and again. */
function dropDanglingEdges(edges: Edge[], vertexCount: number): void {
  for (let changed = true; changed;) {
    changed = false;

    const degree = new Array<number>(vertexCount).fill(0);

    for (const edge of edges) {
      if (edge.alive) {
        degree[edge.v0]!++;
        degree[edge.v1]!++;
      }
    }

    for (const edge of edges) {
      if (edge.alive && (degree[edge.v0] === 1 || degree[edge.v1] === 1)) {
        edge.alive = false;
        changed = true;
      }
    }
  }
}

function halfEdgesOf(live: readonly Edge[]): HalfEdge[] {
  const halves: HalfEdge[] = [];

  for (const edge of live) {
    halves.push({ edge, forward: true, from: edge.v0, to: edge.v1, angle: leaveAngle(edge.piece, true) });
    halves.push({ edge, forward: false, from: edge.v1, to: edge.v0, angle: leaveAngle(edge.piece, false) });
  }

  return halves;
}

/**
 * Walks every face boundary: from a half-edge, turn at its end onto the next half-edge clockwise
 * from the way back, until the walk closes. Each half-edge ends up in exactly one cycle.
 */
function traceCycles(halves: readonly HalfEdge[]): { cycles: number[][]; cycleOf: number[] } {
  const twin = (i: number) => i ^ 1;
  // Per vertex: the half-edges leaving it, sorted by direction.
  const around = new Map<number, number[]>();

  halves.forEach((half, i) => {
    const list = around.get(half.from) ?? [];

    list.push(i);
    around.set(half.from, list);
  });

  for (const list of around.values()) list.sort((a, b) => halves[a]!.angle - halves[b]!.angle);

  const next = (i: number): number => {
    const back = twin(i);
    const list = around.get(halves[back]!.from)!;
    const k = list.indexOf(back);

    return list[(k - 1 + list.length) % list.length]!;
  };

  const cycleOf = new Array<number>(halves.length).fill(-1);
  const cycles: number[][] = [];

  for (let i = 0; i < halves.length; i++) {
    if (cycleOf[i] !== -1) continue;

    const cycle: number[] = [];

    for (let h = i; cycleOf[h] === -1; h = next(h)) {
      cycleOf[h] = cycles.length;
      cycle.push(h);
      if (cycle.length > halves.length) break;
    }

    cycles.push(cycle);
  }

  return { cycles, cycleOf };
}

/**
 * Loop, area, outline and connected component of every cycle. Standalone circles follow at the
 * end: one counter-clockwise and one clockwise cycle each, in a component of their own.
 */
function describeCycles(
  walks: readonly number[][],
  halves: readonly HalfEdge[],
  live: readonly Edge[],
  vertexCount: number,
  standaloneCircles: readonly Basic[],
): Cycle[] {
  // Components: union-find over the vertices.
  const parent = Array.from({ length: vertexCount }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));

  for (const edge of live) parent[find(edge.v0)] = find(edge.v1);

  const cycles: Cycle[] = walks.map((walk) => {
    const loop: LoopEdge[] = walk.map((i) => {
      const half = halves[i]!;

      return { name: half.edge.name, curve: half.edge.curve, seg: toSegment(half.edge.piece, half.forward) };
    });

    return {
      loop,
      area: loopArea(loop),
      polygon: polygonOf(loop),
      component: find(halves[walk[0]!]!.from),
    };
  });

  standaloneCircles.forEach((c, k) => {
    if (c.kind !== "circle") return;

    const circleLoop = (ccw: boolean): LoopEdge[] => [
      { name: c.id, curve: c.id, seg: { kind: "circle", center: c.center, radius: c.radius, ccw } },
    ];
    const component = -1 - k;

    for (const loop of [circleLoop(true), circleLoop(false)]) {
      cycles.push({ loop, area: loopArea(loop), polygon: polygonOf(loop), component });
    }
  });

  return cycles;
}

/**
 * Each component's outer boundary (a clockwise cycle) is a hole of the smallest face of another
 * component that encloses it, or of the unbounded face.
 */
function assignHoles(
  cycles: readonly Cycle[],
  bounded: readonly number[],
  outerCycles: readonly number[],
): Map<number, number> {
  const holeOf = new Map<number, number>();

  for (const n of outerCycles) {
    const probe = cycles[n]!.polygon[0]!;
    let best = OUTSIDE;

    for (const b of bounded) {
      if (cycles[b]!.component === cycles[n]!.component) continue;

      if (
        pointInPolygon(probe, cycles[b]!.polygon) &&
        (best === OUTSIDE || cycles[b]!.area < cycles[best]!.area)
      ) {
        best = b;
      }
    }

    holeOf.set(n, best);
  }

  return holeOf;
}

/** Which faces share a piece of curve, and from that how many curves lie between a face and the outside. */
class FaceNeighbours {
  private readonly adjacent = new Map<number, Set<number>>();

  link(a: number, b: number): void {
    if (a === b) return;

    this.of(a).add(b);
    this.of(b).add(a);
  }

  private of(face: number): Set<number> {
    let set = this.adjacent.get(face);

    if (!set) {
      set = new Set();
      this.adjacent.set(face, set);
    }

    return set;
  }

  /** Breadth-first from the unbounded face: the number of curves crossed to reach each face. */
  depthsFromOutside(): Map<number, number> {
    const depth = new Map<number, number>([[OUTSIDE, 0]]);

    for (let queue = [OUTSIDE]; queue.length;) {
      const face = queue.shift()!;

      for (const neighbour of this.adjacent.get(face) ?? []) {
        if (!depth.has(neighbour)) {
          depth.set(neighbour, depth.get(face)! + 1);
          queue.push(neighbour);
        }
      }
    }

    return depth;
  }
}

/** Regions selected by a profile reference: explicit keys, or the even-odd rule for "all". */
export function selectRegions(
  regions: readonly Region[],
  which: "all" | readonly string[] | undefined,
): { regions: Region[]; missing: string[] } {
  if (which === undefined || which === "all") {
    return { regions: regions.filter((region) => region.depth % 2 === 1), missing: [] };
  }

  const byKey = new Map(regions.map((region) => [region.key, region]));

  return { regions: which.flatMap((k) => byKey.get(k) ?? []), missing: which.filter((k) => !byKey.has(k)) };
}

export function regionAt(regions: readonly Region[], p: Vec2): Region | undefined {
  return regions
    .filter(
      (region) =>
        pointInPolygon(p, region.polygons[0]!) && !region.polygons.slice(1).some((h) => pointInPolygon(p, h)),
    )
    .sort((a, b) => a.area - b.area)[0];
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

function ends(piece: Piece): [Vec2, Vec2] {
  return piece.kind === "line"
    ? [piece.a, piece.b]
    : [arcPoint(piece.center, piece.radius, piece.a0), arcPoint(piece.center, piece.radius, piece.a1)];
}

/**
 * Direction leaving the start (fwd) or end (!fwd) of a piece, probed slightly inside to separate tangent
 * curves.
 */
function leaveAngle(piece: Piece, fwd: boolean): number {
  if (piece.kind === "line") {
    const [a, b] = fwd ? [piece.a, piece.b] : [piece.b, piece.a];

    return Math.atan2(b[1] - a[1], b[0] - a[0]);
  }

  const span = piece.a1 - piece.a0;
  const t = Math.min(span * 1e-3, 1e-3);
  const [from, probe] = fwd ? [piece.a0, piece.a0 + t] : [piece.a1, piece.a1 - t];
  const s = arcPoint(piece.center, piece.radius, from);
  const q = arcPoint(piece.center, piece.radius, probe);

  return Math.atan2(q[1] - s[1], q[0] - s[0]);
}

function toSegment(piece: Piece, fwd: boolean): LoopSegment {
  if (piece.kind === "line") {
    return fwd ? { kind: "line", a: piece.a, b: piece.b } : { kind: "line", a: piece.b, b: piece.a };
  }

  return fwd
    ? { kind: "arc", center: piece.center, radius: piece.radius, from: piece.a0, to: piece.a1, ccw: true }
    : { kind: "arc", center: piece.center, radius: piece.radius, from: piece.a1, to: piece.a0, ccw: false };
}

function segArea(segment: LoopSegment): number {
  if (segment.kind === "line") return (segment.a[0] * segment.b[1] - segment.b[0] * segment.a[1]) / 2;

  const [cx, cy] = segment.center;
  const r = segment.radius;
  let d: number;
  let t0: number;

  if (segment.kind === "circle") {
    t0 = 0;
    d = segment.ccw ? TAU : -TAU;
  } else {
    t0 = segment.from;
    d = segment.ccw ? sweep(segment.from, segment.to) : -sweep(segment.to, segment.from);
  }

  const t1 = t0 + d;

  return (r * r * d + r * cx * (Math.sin(t1) - Math.sin(t0)) - r * cy * (Math.cos(t1) - Math.cos(t0))) / 2;
}

export function loopArea(loop: readonly LoopEdge[]): number {
  return loop.reduce((s, edge) => s + segArea(edge.seg), 0);
}

export function polygonOf(loop: readonly LoopEdge[]): Vec2[] {
  const pts: Vec2[] = [];

  for (const { seg } of loop) {
    if (seg.kind === "line") {
      pts.push(seg.a);
    } else {
      const from = seg.kind === "circle" ? 0 : seg.from;
      const d =
        seg.kind === "circle"
          ? seg.ccw
            ? TAU
            : -TAU
          : seg.ccw
            ? sweep(seg.from, seg.to)
            : -sweep(seg.to, seg.from);
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
  const inside = (p: Vec2) =>
    pointInPolygon(p, polys[0]!) && !polys.slice(1).some((h) => pointInPolygon(p, h));
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
      const len = distance2(a, b);
      if (len === 0) continue;

      const m: Vec2 = [
        (a[0] + b[0]) / 2 - ((b[1] - a[1]) / len) * len * f,
        (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * len * f,
      ];
      if (inside(m)) return m;
    }
  }

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

function circleCircle(
  c1: Exclude<Basic, { kind: "line" }>,
  c2: Exclude<Basic, { kind: "line" }>,
  eps: number,
): [number, number][] {
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
  const pts: Vec2[] =
    h < eps
      ? [[mx, my]]
      : [
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

      for (const [pa] of intersect(x, y, scale * 1e-9)) {
        out.push(x.kind === "line" ? lerp(x.a, x.b, pa) : arcPoint(x.center, x.radius, pa));
      }
    }
  }

  // Neighbouring pieces of a spline meet at their shared sample point: keep it once.
  return out.filter((p, i) => out.findIndex((q) => distance2(p, q) < 1e-9) === i);
}
