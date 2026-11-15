/** Plane geometry of the sketch editor: arcs, distances to curves, point lists and model edges. */
import type { SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import {
  add2,
  distance2,
  dot2,
  midpoint2,
  scale2,
  sub2,
  type SolvedCurve,
  type SolvedSketch,
  type Vec2,
} from "@meercad/sketch";
import type { SketchSel } from "../state";

/** Counter-clockwise sweep from a0 to a1, in (0, 2π]. */
export const sweepOf = (a0: number, a1: number) =>
  (((a1 - a0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;

/**
 * The circle through an arc's two ends and a third point on it; start→end runs counter-clockwise through `m`.
 */
export function arcThrough(
  a: Vec2,
  b: Vec2,
  m: Vec2,
): { center: Vec2; radius: number; start: Vec2; end: Vec2; sweep: number; swapped: boolean } | null {
  const d = 2 * (a[0] * (b[1] - m[1]) + b[0] * (m[1] - a[1]) + m[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9 * Math.max(1, distance2(a, b) ** 2)) return null;

  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const center: Vec2 = [
    (sq(a) * (b[1] - m[1]) + sq(b) * (m[1] - a[1]) + sq(m) * (a[1] - b[1])) / d,
    (sq(a) * (m[0] - b[0]) + sq(b) * (a[0] - m[0]) + sq(m) * (b[0] - a[0])) / d,
  ];
  const ang = (p: Vec2) => Math.atan2(p[1] - center[1], p[0] - center[0]);
  const ccw = (from: number, to: number) => (((to - from) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  // m between a and b going counter-clockwise: the arc runs a→b, otherwise b→a.
  const swapped = ccw(ang(a), ang(m)) > ccw(ang(a), ang(b));
  const [start, end] = swapped ? [b, a] : [a, b];

  return {
    center,
    radius: distance2(center, a),
    start,
    end,
    sweep: ccw(ang(start), ang(end)),
    swapped,
  };
}

/** Lengths below this count as zero (mm). */
const ZERO_LENGTH = 1e-9;

/**
 * The middle point of the arc over the chord `start`→`end`, bulging to the side `side` lies on.
 * The arc is given by its radius, its sweep angle (degrees) or both; null when no such arc exists.
 */
export function arcMidFor(
  start: Vec2,
  end: Vec2,
  side: Vec2,
  radius: number | null,
  angleDeg: number | null,
): Vec2 | null {
  const chordLength = distance2(start, end);

  if (chordLength < ZERO_LENGTH) return null;

  const givenSweep = angleDeg !== null ? (angleDeg * Math.PI) / 180 : null;

  if (givenSweep !== null && (givenSweep <= 0 || givenSweep >= 2 * Math.PI)) return null;

  // A sweep angle without a radius fixes the radius.
  const arcRadius =
    radius === null && givenSweep !== null ? chordLength / (2 * Math.sin(givenSweep / 2)) : radius;

  // The chord cannot be longer than the diameter.
  if (arcRadius === null || arcRadius < chordLength / 2 - ZERO_LENGTH) return null;

  // A radius without a sweep angle means the shorter arc over the chord.
  const sweepAngle = givenSweep ?? 2 * Math.asin(Math.min(1, chordLength / (2 * arcRadius)));

  const chordMid = midpoint2(start, end);
  const chord = sub2(end, start);
  const leftOfChord: Vec2 = [-chord[1] / chordLength, chord[0] / chordLength];
  const sideIsRight = dot2(sub2(side, chordMid), leftOfChord) < 0;
  const bulgeDirection: Vec2 = sideIsRight ? [-leftOfChord[0], -leftOfChord[1]] : leftOfChord;

  // How far the arc's middle stands off the chord (more than the radius for an arc over half a circle).
  const bulgeHeight = arcRadius - arcRadius * Math.cos(sweepAngle / 2);

  return add2(chordMid, scale2(bulgeDirection, bulgeHeight));
}

export const round = (n: number) => Math.round(n * 1000) / 1000;
export const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(1) : n.toFixed(2)).replace(/\.?0+$/, "");
export const normalizeAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export function parseSel(s: string): SketchSel {
  const [kind, ...id] = s.split(":");

  return { kind: kind as "point" | "curve", id: id.join(":") };
}

export function applySolution(entities: SketchEntity[], solved: SolvedSketch): SketchEntity[] {
  return entities.map((entity) => {
    if (entity.type === "point") {
      const p = solved.points.get(entity.id);

      return p ? { ...entity, x: round(p[0]), y: round(p[1]) } : entity;
    }

    if (entity.type === "circle") {
      const curve = solved.curves.find((x) => x.id === entity.id);

      return curve?.kind === "circle" ? { ...entity, radius: round(curve.radius) } : entity;
    }

    return entity;
  });
}

export function pointEntries(sketch: SketchFeature | undefined, solved: SolvedSketch): [string, Vec2][] {
  const out: [string, Vec2][] = [["origin", [0, 0]]];

  for (const entity of sketch?.entities ?? []) {
    if (entity.type === "point") {
      const p = solved.points.get(entity.id);
      if (p) out.push([entity.id, p]);
    }
  }

  for (const curve of solved.curves) {
    if (!curve.external) continue;

    for (const k of curve.kind === "line"
      ? ["p1", "p2"]
      : curve.kind === "arc"
        ? ["center", "start", "end"]
        : ["center"]) {
      const p = solved.points.get(`${curve.id}.${k}`);
      if (p) out.push([`${curve.id}.${k}`, p]);
    }
  }

  return out;
}

export function curvePointIds(sketch: SketchFeature, id: string): string[] {
  const entity = sketch.entities.find((x) => x.id === id);
  if (!entity) return [];
  if (entity.type === "line") return [entity.p1, entity.p2];
  if (entity.type === "circle") return [entity.center];
  if (entity.type === "arc") return [entity.center, entity.start, entity.end];

  return [];
}

export function connectedCurves(sketch: SketchFeature, start: string): string[] {
  // Joined end to end only: concentric arcs share their centre point without being one chain.
  const pts = (id: string) => {
    const entity = sketch.entities.find((x) => x.id === id);

    return entity?.type === "line"
      ? [entity.p1, entity.p2]
      : entity?.type === "arc"
        ? [entity.start, entity.end]
        : [];
  };

  const seen = new Set([start]);
  const queue = [start];

  while (queue.length) {
    const c = queue.shift()!;
    const ends = new Set(pts(c));

    for (const entity of sketch.entities) {
      if (seen.has(entity.id) || (entity.type !== "line" && entity.type !== "arc")) continue;

      if (pts(entity.id).some((p) => ends.has(p))) {
        seen.add(entity.id);
        queue.push(entity.id);
      }
    }
  }

  return [...seen];
}

export function curveSamples(curve: SolvedCurve): Vec2[] {
  if (curve.kind === "line") return [curve.a, curve.b];
  if (curve.kind === "spline") return curve.pts;

  const n = 16;
  const [a0, sw] =
    curve.kind === "circle"
      ? [0, 2 * Math.PI]
      : [curve.a0, (curve.a1 - curve.a0 + 4 * Math.PI) % (2 * Math.PI) || 2 * Math.PI];

  return Array.from(
    { length: n + 1 },
    (_, i) =>
      [
        curve.center[0] + curve.radius * Math.cos(a0 + (sw * i) / n),
        curve.center[1] + curve.radius * Math.sin(a0 + (sw * i) / n),
      ] as Vec2,
  );
}

export function curveDistance(curve: SolvedCurve, p: Vec2, infinite = false): number {
  if (curve.kind === "spline") {
    return Math.min(...curve.pts.slice(1).map((b, k) => segDistance(curve.pts[k]!, b, p)));
  }

  if (curve.kind === "line") {
    const d: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
    const l2 = d[0] * d[0] + d[1] * d[1] || 1;
    let t = ((p[0] - curve.a[0]) * d[0] + (p[1] - curve.a[1]) * d[1]) / l2;
    if (!infinite) t = Math.max(0, Math.min(1, t));

    return Math.hypot(curve.a[0] + d[0] * t - p[0], curve.a[1] + d[1] * t - p[1]);
  }

  const r = distance2(curve.center, p);

  if (curve.kind === "arc") {
    const a = Math.atan2(p[1] - curve.center[1], p[0] - curve.center[0]);
    const rel = (a - curve.a0 + 4 * Math.PI) % (2 * Math.PI);
    const span = (curve.a1 - curve.a0 + 4 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;

    if (rel > span) {
      const s: Vec2 = [
        curve.center[0] + curve.radius * Math.cos(curve.a0),
        curve.center[1] + curve.radius * Math.sin(curve.a0),
      ];
      const e: Vec2 = [
        curve.center[0] + curve.radius * Math.cos(curve.a1),
        curve.center[1] + curve.radius * Math.sin(curve.a1),
      ];

      return Math.min(distance2(s, p), distance2(e, p));
    }
  }

  return Math.abs(r - curve.radius);
}

/** Distance from p to the segment a–b. */
function segDistance(a: Vec2, b: Vec2, p: Vec2): number {
  const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
  const t = Math.max(
    0,
    Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1)),
  );

  return Math.hypot(a[0] + d[0] * t - p[0], a[1] + d[1] * t - p[1]);
}

export function projectOnCurve(curve: SolvedCurve, p: Vec2): Vec2 {
  if (curve.kind === "spline") {
    // The nearest point on the nearest piece.
    let best: Vec2 = curve.pts[0]!;
    let bd = Infinity;

    for (let k = 1; k < curve.pts.length; k++) {
      const q = projectOnCurve(
        {
          id: "",
          kind: "line",
          a: curve.pts[k - 1]!,
          b: curve.pts[k]!,
          p1: "",
          p2: "",
          construction: false,
          external: false,
        },
        p,
      );
      const d = distance2(p, q);
      if (d < bd) [best, bd] = [q, d];
    }

    return best;
  }

  if (curve.kind === "line") {
    const d: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p[0] - curve.a[0]) * d[0] + (p[1] - curve.a[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1] || 1),
      ),
    );

    return [curve.a[0] + d[0] * t, curve.a[1] + d[1] * t];
  }

  const a = Math.atan2(p[1] - curve.center[1], p[0] - curve.center[0]);

  return [curve.center[0] + curve.radius * Math.cos(a), curve.center[1] + curve.radius * Math.sin(a)];
}

export function refsOfEntity(entity: SketchEntity): string[] {
  return entity.type === "line"
    ? [entity.p1, entity.p2]
    : entity.type === "circle"
      ? [entity.center]
      : entity.type === "arc"
        ? [entity.center, entity.start, entity.end]
        : entity.type === "spline"
          ? entity.points
          : [];
}

export function refsOf(constraint: SketchConstraint): string[] {
  return Object.entries(constraint)
    .filter(([k, v]) => k !== "id" && k !== "type" && typeof v === "string")
    .map(([, v]) => (v as string).split(".")[0]!);
}

/** A model edge lying in the sketch plane, as a polyline in sketch coordinates. */
export interface ModelEdge {
  pts: Vec2[];
  /** Centre of a round edge (circle or arc), for snapping to it. */
  center?: Vec2;
}

/**
 * Edges of the model that lie in the sketch plane (a face's outline and holes when sketching on it),
 * so the magnet can snap to them like to sketch lines. Round ones get their centre.
 */
export function planeEdges(
  meshes: readonly { edgeLines: Float32Array; edgeRanges: Int32Array }[],
  frame: { origin: number[]; u: number[]; v: number[]; normal: number[] },
  tol: number,
): ModelEdge[] {
  const out: ModelEdge[] = [];
  const [o, u, v, n] = [frame.origin, frame.u, frame.v, frame.normal];

  for (const m of meshes) {
    for (let g = 0; g < m.edgeRanges.length; g += 3) {
      const [start, count] = [m.edgeRanges[g]!, m.edgeRanges[g + 1]!];
      const pts: Vec2[] = [];
      let flat = true;

      for (let k = start; k < start + count && flat; k++) {
        const d = [0, 1, 2].map((i) => m.edgeLines[k * 3 + i]! - o[i]!);
        if (Math.abs(d[0]! * n[0]! + d[1]! * n[1]! + d[2]! * n[2]!) > tol) flat = false;

        pts.push([
          d[0]! * u[0]! + d[1]! * u[1]! + d[2]! * u[2]!,
          d[0]! * v[0]! + d[1]! * v[1]! + d[2]! * v[2]!,
        ]);
      }

      if (!flat || pts.length < 2) continue;

      out.push({ pts, ...(roundCenter(pts) ? { center: roundCenter(pts)! } : {}) });
    }
  }

  return out;
}

/** Centre of a polyline that follows a circle or arc (every point equally far from it), or null. */
function roundCenter(pts: Vec2[]): Vec2 | null {
  if (pts.length < 6) return null;

  const [a, b, c] = [pts[0]!, pts[Math.floor(pts.length / 3)]!, pts[Math.floor((2 * pts.length) / 3)]!];
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;

  const sq = (p: Vec2) => p[0] * p[0] + p[1] * p[1];
  const center: Vec2 = [
    (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d,
    (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d,
  ];
  const r = distance2(center, a);

  return pts.every((p) => Math.abs(distance2(center, p) - r) < r * 0.01 + 1e-4) ? center : null;
}

/** Closest point on a polyline and how far it is. */
export function nearestOnPolyline(pts: Vec2[], p: Vec2): { pos: Vec2; dist: number } {
  let best = { pos: pts[0]!, dist: Infinity };

  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    const q: Vec2 = [a[0] + dx * t, a[1] + dy * t];
    const dist = distance2(p, q);
    if (dist < best.dist) best = { pos: q, dist };
  }

  return best;
}

export function dimensionGeometry(constraint: SketchConstraint, solved: SolvedSketch): Vec2[] | null {
  if (!("value" in constraint) || !constraint.label) return null;

  const L = constraint.label;
  const seg = (a: Vec2, b: Vec2): Vec2[] => [a, b];

  if (constraint.type === "length" || constraint.type === "distance") {
    let a: Vec2 | undefined;
    let b: Vec2 | undefined;

    if (constraint.type === "length") {
      const line = solved.curves.find((x) => x.id === constraint.line);
      if (line?.kind !== "line") return null;

      [a, b] = [line.a, line.b];
    } else {
      a = solved.points.get(constraint.a);
      b = solved.points.get(constraint.b);

      if (!b) {
        const line = solved.curves.find((x) => x.id === constraint.b);
        if (line?.kind === "line" && a) b = projectOnCurve(line, a);
      }
    }

    if (!a || !b) return null;

    if (constraint.type === "distance" && constraint.axis) {
      const ax = constraint.axis === "x";
      const a2: Vec2 = ax ? [a[0], L[1]] : [L[0], a[1]];
      const b2: Vec2 = ax ? [b[0], L[1]] : [L[0], b[1]];

      return [...seg(a, a2), ...seg(b, b2), ...seg(a2, b2)];
    }

    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const len = Math.hypot(...d) || 1;
    const n: Vec2 = [-d[1] / len, d[0] / len];
    const off = (L[0] - a[0]) * n[0] + (L[1] - a[1]) * n[1];
    const a2: Vec2 = [a[0] + n[0] * off, a[1] + n[1] * off];
    const b2: Vec2 = [b[0] + n[0] * off, b[1] + n[1] * off];

    return [...seg(a, a2), ...seg(b, b2), ...seg(a2, b2)];
  }

  if (constraint.type === "radius" || constraint.type === "diameter") {
    const curve = solved.curves.find((x) => x.id === constraint.curve);
    if (!curve || curve.kind === "line" || curve.kind === "spline") return null;

    const ang = Math.atan2(L[1] - curve.center[1], L[0] - curve.center[0]);
    const onCurve: Vec2 = [
      curve.center[0] + curve.radius * Math.cos(ang),
      curve.center[1] + curve.radius * Math.sin(ang),
    ];

    return constraint.type === "diameter"
      ? [[curve.center[0] - curve.radius * Math.cos(ang), curve.center[1] - curve.radius * Math.sin(ang)], L]
      : ([curve.center, L].concat([onCurve, L]) as Vec2[]);
  }

  if (constraint.type === "arc_angle") {
    // Spokes from the centre to both ends show what the angle measures.
    const curve = solved.curves.find((x) => x.id === constraint.curve);
    if (!curve || curve.kind !== "arc") return null;

    const end = (a: number): Vec2 => [
      curve.center[0] + curve.radius * Math.cos(a),
      curve.center[1] + curve.radius * Math.sin(a),
    ];

    return [curve.center, end(curve.a0), curve.center, end(curve.a1)];
  }

  return null;
}

/** The end of a (non-construction) line nearest `p` within `within`; a corner on the origin counts. */
export function nearestLineEnd(
  sketch: SketchFeature,
  points: Map<string, Vec2>,
  p: Vec2,
  within: number,
): string | null {
  const ends = new Set(
    sketch.entities.flatMap((entity) =>
      entity.type === "line" && !entity.construction ? [entity.p1, entity.p2] : [],
    ),
  );
  let corner: string | null = null;
  let best = within;

  for (const id of ends) {
    const q = points.get(id);
    const d = q ? distance2(p, q) : Infinity;
    if (d < best) [corner, best] = [id, d];
  }

  return corner;
}

/** The lines and arcs joined end to end with `start`, construction geometry left out. */
export function joinedChain(sketch: SketchFeature, start: string): string[] {
  const ends = (entity: SketchEntity) =>
    entity.type === "line" ? [entity.p1, entity.p2] : entity.type === "arc" ? [entity.start, entity.end] : [];
  const curves = sketch.entities.filter(
    (entity) => (entity.type === "line" || entity.type === "arc") && !entity.construction,
  );
  const chain = new Set([start]);

  for (let grew = true; grew;) {
    grew = false;

    const pts = new Set(curves.filter((entity) => chain.has(entity.id)).flatMap(ends));

    for (const entity of curves) {
      if (!chain.has(entity.id) && ends(entity).some((q) => pts.has(q))) {
        (chain.add(entity.id), (grew = true));
      }
    }
  }

  return [...chain];
}
