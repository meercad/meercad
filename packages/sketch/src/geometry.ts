/** Plain 2D/3D geometry helpers and the solved-sketch data model shared by kernel and UI. */

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface PlaneFrame {
  origin: Vec3;
  u: Vec3;
  v: Vec3;
  /** u × v */
  normal: Vec3;
}

export const ORIGIN_FRAMES: Record<"origin.XY" | "origin.XZ" | "origin.YZ", PlaneFrame> = {
  "origin.XY": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  "origin.XZ": { origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
  "origin.YZ": { origin: [0, 0, 0], u: [0, 1, 0], v: [0, 0, 1], normal: [1, 0, 0] },
};

export const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale3 = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot3 = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len3 = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
export const norm3 = (a: Vec3): Vec3 => scale3(a, 1 / (len3(a) || 1));

export const add2 = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
export const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
export const scale2 = (a: Vec2, s: number): Vec2 => [a[0] * s, a[1] * s];
export const dot2 = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
/** The z part of a × b: positive when b lies counter-clockwise of a. */
export const cross2 = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];
export const len2 = (a: Vec2) => Math.hypot(a[0], a[1]);
export const distance2 = (a: Vec2, b: Vec2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const midpoint2 = (a: Vec2, b: Vec2): Vec2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
/** `a` turned a quarter turn counter-clockwise. */
export const perpendicular2 = (a: Vec2): Vec2 => [-a[1], a[0]];

export function toWorld(frame: PlaneFrame, [a, b]: Vec2): Vec3 {
  const { origin: o, u, v } = frame;

  return [o[0] + a * u[0] + b * v[0], o[1] + a * u[1] + b * v[1], o[2] + a * u[2] + b * v[2]];
}

export function toSketch(frame: PlaneFrame, p: Vec3): Vec2 {
  const d = sub3(p, frame.origin);

  return [dot3(d, frame.u), dot3(d, frame.v)];
}

/**
 * Deterministic frame for a plane given by a point and normal: origin = projection of the world
 * origin, u = projection of world X (or Y when the normal is along X).
 */
export function frameFromPlane(point: Vec3, normal: Vec3): PlaneFrame {
  const n = norm3(normal);
  const origin = sub3([0, 0, 0], scale3(n, dot3(sub3([0, 0, 0], point), n)));
  const ref: Vec3 = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm3(sub3(ref, scale3(n, dot3(ref, n))));
  const v = cross3(n, u);

  // Keep origin planes identical to the named frames (e.g. a face at z=10 behaves like XY).
  for (const frame of Object.values(ORIGIN_FRAMES)) {
    if (dot3(frame.normal, n) > 1 - 1e-9) {
      return {
        origin: add3(frame.origin, scale3(n, dot3(sub3(point, frame.origin), n))),
        u: frame.u,
        v: frame.v,
        normal: frame.normal,
      };
    }
  }

  return { origin, u, v, normal: n };
}

export function offsetFrame(frame: PlaneFrame, offset: number, angleDeg = 0): PlaneFrame {
  const origin = add3(frame.origin, scale3(frame.normal, offset));
  if (!angleDeg) return { ...frame, origin };

  // Rotate v and normal about u.
  const a = (angleDeg * Math.PI) / 180;
  const v = add3(scale3(frame.v, Math.cos(a)), scale3(frame.normal, Math.sin(a)));
  const normal = cross3(frame.u, v);

  return { origin, u: frame.u, v, normal };
}

// ---------------------------------------------------------------- solved sketch

export type SolvedCurve =
  | {
      id: string;
      kind: "line";
      a: Vec2;
      b: Vec2;
      p1: string;
      p2: string;
      construction: boolean;
      external: boolean;
    }
  | {
      id: string;
      kind: "circle";
      center: Vec2;
      radius: number;
      c: string;
      construction: boolean;
      external: boolean;
    }
  /** Counter-clockwise from angle a0 to a1 (radians). */
  | {
      id: string;
      kind: "arc";
      center: Vec2;
      radius: number;
      a0: number;
      a1: number;
      c: string;
      start: string;
      end: string;
      construction: boolean;
      external: boolean;
    }
  /**
   * Smooth curve through the points `through` (ids `points`); `pts` samples it densely, ends
   * included, `fine` finer still where it bends (for drawing). `tangents` are the points' own
   * tangents (null: automatic).
   */
  | {
      id: string;
      kind: "spline";
      pts: Vec2[];
      fine?: Vec2[];
      through: Vec2[];
      tangents?: (Vec2 | null)[];
      points: string[];
      closed: boolean;
      construction: boolean;
      external: boolean;
    };

/** Samples per span between two through-points of a spline. */
export const SPLINE_SAMPLES = 16;

/**
 * A spline point's handle: where the curve leaves the point backwards (`back`) and forwards
 * (`ahead`), as offsets from the point. They are the inner control points of the cubic Bézier
 * spans on either side, so the curve runs along them.
 */
export interface SplineArms {
  back: Vec2;
  ahead: Vec2;
}

/**
 * The handles of a spline's points. A point without its own tangent (`tangents[i]` missing or
 * null) gets the centripetal Catmull-Rom tangent (no cusps or loops within a span, no
 * overshoot); open ends repeat their neighbour mirrored, so the curve leaves straight towards the
 * next point. A point's own tangent is its forward arm, the backward arm mirrors it.
 */
export function splineArms(
  through: readonly Vec2[],
  closed = false,
  tangents?: readonly (Vec2 | null | undefined)[],
): SplineArms[] {
  const n = through.length;
  if (n < 2) return through.map(() => ({ back: [0, 0], ahead: [0, 0] }));

  const at = (i: number): Vec2 => {
    if (closed) return through[((i % n) + n) % n]!;
    if (i < 0) return [2 * through[0]![0] - through[1]![0], 2 * through[0]![1] - through[1]![1]];

    if (i >= n) {
      return [2 * through[n - 1]![0] - through[n - 2]![0], 2 * through[n - 1]![1] - through[n - 2]![1]];
    }

    return through[i]!;
  };

  // Knot spacing by the square root of the chord lengths (centripetal).
  const dt = (a: Vec2, b: Vec2) => Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-9);

  return through.map((p, i) => {
    const own = tangents?.[i];
    if (own) return { back: [-own[0], -own[1]], ahead: [own[0], own[1]] };

    const [p0, p2] = [at(i - 1), at(i + 1)];
    const [d0, d1] = [dt(p0, p), dt(p, p2)];
    // The curve's velocity at the point (Barry-Goldman), scaled to each side's span.
    const v = [0, 1].map(
      (k) => (p[k]! - p0[k]!) / d0 - (p2[k]! - p0[k]!) / (d0 + d1) + (p2[k]! - p[k]!) / d1,
    ) as Vec2;

    return { back: [(-v[0] * d0) / 3, (-v[1] * d0) / 3], ahead: [(v[0] * d1) / 3, (v[1] * d1) / 3] };
  });
}

/** The cubic Bézier spans of a spline: start, two control points, end. */
export function splineSpans(
  through: readonly Vec2[],
  closed = false,
  tangents?: readonly (Vec2 | null | undefined)[],
): [Vec2, Vec2, Vec2, Vec2][] {
  const n = through.length;
  if (n < 2) return [];

  const arms = splineArms(through, closed, tangents);
  const spans = closed ? n : n - 1;

  return Array.from({ length: spans }, (_, i) => {
    const [a, b] = [through[i]!, through[(i + 1) % n]!];
    const [out, back] = [arms[i]!.ahead, arms[(i + 1) % n]!.back];

    return [a, [a[0] + out[0], a[1] + out[1]], [b[0] + back[0], b[1] + back[1]], b];
  });
}

function bezier([a, b, c, d]: readonly [Vec2, Vec2, Vec2, Vec2], s: number): Vec2 {
  const r = 1 - s;
  const [w0, w1, w2, w3] = [r * r * r, 3 * r * r * s, 3 * r * s * s, s * s * s];

  return [
    w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0],
    w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1],
  ];
}

/** Whether any point of the spline has its own tangent. */
const hasOwn = (tangents?: readonly (Vec2 | null | undefined)[]) => !!tangents?.some((x) => !!x);

/**
 * The spline through the points sampled SPLINE_SAMPLES times per span (an open spline of two
 * points without tangents is just its two ends). Regions and the model are built from these
 * samples, so their number per span stays fixed.
 */
export function splinePoints(
  through: readonly Vec2[],
  closed = false,
  tangents?: readonly (Vec2 | null | undefined)[],
): Vec2[] {
  return sampleSpans(through, closed, tangents);
}

/** Largest turn of the drawn curve between two samples (radians), about 1.5°. */
const DISPLAY_TURN = Math.PI / 120;
/** How often a stretch between two of the model's samples is halved at most for drawing. */
const DISPLAY_DEPTH = 6;

/** The angle between two directions (radians, 0 when one of them is empty). */
function turnBetween(u: Vec2, w: Vec2): number {
  if (!Math.hypot(u[0], u[1]) || !Math.hypot(w[0], w[1])) return 0;

  return Math.abs(Math.atan2(u[0] * w[1] - u[1] * w[0], u[0] * w[0] + u[1] * w[1]));
}

/**
 * The spline sampled for drawing: the model's samples (`splinePoints`), and more between them
 * where it bends, so that it turns no more than about 1.5° from one sample to the next at any zoom.
 */
export function splineDisplayPoints(
  through: readonly Vec2[],
  closed = false,
  tangents?: readonly (Vec2 | null | undefined)[],
): Vec2[] {
  return sampleSpans(through, closed, tangents, (span, s0, s1, out) => {
    const refine = (a: number, pa: Vec2, b: number, pb: Vec2, depth: number) => {
      const m = (a + b) / 2;
      const pm = bezier(span, m);
      const bent =
        turnBetween([pm[0] - pa[0], pm[1] - pa[1]], [pb[0] - pm[0], pb[1] - pm[1]]) > DISPLAY_TURN / 2;

      if (bent && depth < DISPLAY_DEPTH) {
        refine(a, pa, m, pm, depth + 1);
        refine(m, pm, b, pb, depth + 1);
      } else if (depth) {
        out.push(pm);
      }
    };

    refine(s0, bezier(span, s0), s1, bezier(span, s1), 0);
  });
}

function sampleSpans(
  through: readonly Vec2[],
  closed: boolean,
  tangents: readonly (Vec2 | null | undefined)[] | undefined,
  /** Adds samples strictly between the span's parameters `s0` and `s1` (display only). */
  between?: (span: readonly [Vec2, Vec2, Vec2, Vec2], s0: number, s1: number, out: Vec2[]) => void,
): Vec2[] {
  const n = through.length;
  if (n < 2) return [...through];
  if (n === 2 && !closed && !hasOwn(tangents)) return [through[0]!, through[1]!];

  const out: Vec2[] = [through[0]!];

  for (const span of splineSpans(through, closed, tangents)) {
    for (let k = 1; k <= SPLINE_SAMPLES; k++) {
      between?.(span, (k - 1) / SPLINE_SAMPLES, k / SPLINE_SAMPLES, out);
      // Through-points exactly, so neighbouring curves still meet them.
      out.push(k === SPLINE_SAMPLES ? span[3] : bezier(span, k / SPLINE_SAMPLES));
    }
  }

  return out;
}

/** Where along a spline's samples `q` is nearest, as a fractional sample index. */
export function splineParam(pts: readonly Vec2[], q: Vec2): number {
  let best = 0;
  let bestD = Infinity;

  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[i + 1]!];
    const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    const t = len2
      ? Math.min(1, Math.max(0, ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / len2))
      : 0;
    const d = Math.hypot(a[0] + (b[0] - a[0]) * t - q[0], a[1] + (b[1] - a[1]) * t - q[1]);
    if (d < bestD) [best, bestD] = [i + t, d];
  }

  return best;
}

/**
 * One piece of a trimmed spline: its through-points in order, each an index into the old spline's points or
 * into the cuts.
 */
export type SplinePiece = Array<{ point: number } | { cut: number }>;

/**
 * Trimming a spline at `click` removes the stretch between the nearest cuts (intersections with
 * other curves) around it. Returns the pieces that stay: none when nothing bounds the stretch,
 * two when an open spline is cut in its middle. The pieces go through the old points, so their
 * shape stays close to the old one; only the spans next to a cut bend a little.
 */
export function trimSpline(
  c: Extract<SolvedCurve, { kind: "spline" }>,
  click: Vec2,
  cuts: readonly Vec2[],
): SplinePiece[] {
  const spans = c.closed ? c.through.length : c.through.length - 1;
  const total = c.pts.length - 1;
  const per = total / spans;
  const eps = 1e-6 * per;
  const sc = splineParam(c.pts, click);
  const params = cuts
    .map((q, cut) => ({ cut, s: splineParam(c.pts, q) }))
    .filter((h) => c.closed || (h.s > eps && h.s < total - eps));
  const below = params.filter((h) => h.s < sc).sort((a, b) => b.s - a.s);
  const above = params.filter((h) => h.s > sc).sort((a, b) => a.s - b.s);

  // Through-points strictly between two positions (unwrapped: past the end goes on from the start).
  const between = (from: number, to: number) => {
    const out: { point: number }[] = [];

    for (let k = 0; k <= 2 * c.through.length; k++) {
      if (k * per > from + eps && k * per < to - eps) out.push({ point: k % c.through.length });
    }

    return out;
  };

  const piece = (
    from: { cut: number; s: number } | null,
    to: { cut: number; s: number } | null,
    toS: number,
  ): SplinePiece => [
    ...(from ? [{ cut: from.cut }] : []),
    ...between(from?.s ?? -1, toS).map(({ point }) => ({ point })),
    ...(to ? [{ cut: to.cut }] : []),
  ];

  if (c.closed) {
    const after = above[0] ?? [...params].sort((a, b) => a.s - b.s)[0];
    const before = below[0] ?? [...params].sort((a, b) => b.s - a.s)[0];
    if (!after || !before || after === before) return [];

    return [piece(after, before, before.s > after.s ? before.s : before.s + total)];
  }

  const before = below[0];
  const after = above[0];
  const pieces: SplinePiece[] = [];
  if (before) pieces.push(piece(null, before, before.s));
  if (after) pieces.push(piece(after, null, total + per / 2));

  return pieces;
}

export interface SolveDiagnostics {
  /** Remaining degrees of freedom; 0 = fully constrained. */
  dof: number;
  ok: boolean;
  conflicting: string[];
  redundant: string[];
  message?: string;
}

export interface SolvedSketch {
  points: Map<string, Vec2>;
  /** Points that are fully determined (drawn black in the editor). */
  curves: SolvedCurve[];
  diagnostics: SolveDiagnostics;
}

export function arcPoint(center: Vec2, r: number, a: number): Vec2 {
  return [center[0] + r * Math.cos(a), center[1] + r * Math.sin(a)];
}

/** Normalised CCW sweep from a0 to a1 in (0, 2π]. */
export function sweep(a0: number, a1: number): number {
  let s = (a1 - a0) % (2 * Math.PI);
  if (s <= 1e-12) s += 2 * Math.PI;

  return s;
}
