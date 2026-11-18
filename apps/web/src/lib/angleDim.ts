/**
 * How an angle between two lines of a sketch is drawn: an arc round the corner where the lines meet
 * (or would meet if they went on), between the two rays the angle opens between, with its value in
 * the middle of the arc. Which of the four corners the arc spans follows the label (where a person
 * put the value); without one, the corner the lines themselves lie in.
 */
import { distance2, sub2, type Vec2 } from "@meercad/sketch";

/** Lines whose directions differ by less than this (sine of the angle) meet nowhere. */
const PARALLEL = 1e-6;
/** Arc pieces per full turn: smooth at any size an angle is drawn. */
const ARC_STEPS_PER_TURN = 96;
/** Without a label, the arc's radius as a share of the shorter line. */
const DEFAULT_RADIUS_SHARE = 0.35;

/** A corner shows a wanted angle if it is this close to it (degrees; the solver's tolerance). */
const MATCH_DEGREES = 0.5;

/** A corner round the meeting point: counter-clockwise from one ray to the other (radians). */
interface Span {
  from: number;
  to: number;
}

export interface Segment {
  a: Vec2;
  b: Vec2;
}

export interface AngleArc {
  /** Where the lines meet. */
  corner: Vec2;
  /** Directions (radians) of the two rays, counter-clockwise from `from` to `to`. */
  from: number;
  to: number;
  radius: number;
  /** The angle the arc spans, in degrees (0 to 180). */
  degrees: number;
  /** Where its value goes: on the arc, halfway round. */
  label: Vec2;
}

const unit = (v: Vec2): Vec2 => {
  const length = Math.hypot(v[0], v[1]);

  return [v[0] / length, v[1] / length];
};

const cross = (u: Vec2, v: Vec2) => u[0] * v[1] - u[1] * v[0];

/** Where the lines through two segments meet; null when they are parallel. */
export function lineCorner(p: Segment, q: Segment): Vec2 | null {
  const d1 = sub2(p.b, p.a);
  const d2 = sub2(q.b, q.a);
  const denominator = cross(d1, d2);
  // A line of no length has no direction; parallel lines meet nowhere.
  if (Math.abs(denominator) <= PARALLEL * Math.hypot(...d1) * Math.hypot(...d2)) return null;

  const t = cross(sub2(q.a, p.a), d2) / denominator;

  return [p.a[0] + d1[0] * t, p.a[1] + d1[1] * t];
}

/** The direction from the corner along a segment, towards its end further away. */
function rayAlong(segment: Segment, corner: Vec2): Vec2 {
  const far = distance2(segment.a, corner) > distance2(segment.b, corner) ? segment.a : segment.b;

  return unit(sub2(far, corner));
}

/** Of the corners, the one whose middle is nearest the direction `angle`. */
function closestTo(spans: Span[], angle: number): Span {
  const off = (s: Span) => {
    const d = turn(s.from + turn(s.from, s.to) / 2, angle);

    return Math.min(d, 2 * Math.PI - d);
  };

  return spans.reduce((best, s) => (off(s) < off(best) ? s : best));
}

/** Angle (radians, 0 to 2π) counter-clockwise from `from` to `to`. */
function turn(from: number, to: number): number {
  const d = (to - from) % (2 * Math.PI);

  return d < 0 ? d + 2 * Math.PI : d;
}

/**
 * The arc of the angle between two segments, spanning the corner `label` lies in; without a label the
 * corner whose angle is nearest `wanted` (degrees), else the one the lines lie in. Null if parallel.
 */
export function angleArc(p: Segment, q: Segment, label?: Vec2 | null, wanted?: number): AngleArc | null {
  const corner = lineCorner(p, q);
  if (!corner) return null;

  const rayP = rayAlong(p, corner);
  const rayQ = rayAlong(q, corner);
  // The four corners round the meeting point: each pair of rays, the arc going the short way.
  const pairs: [Vec2, Vec2][] = [
    [rayP, rayQ],
    [[-rayP[0], -rayP[1]], rayQ],
    [rayP, [-rayQ[0], -rayQ[1]]],
    [
      [-rayP[0], -rayP[1]],
      [-rayQ[0], -rayQ[1]],
    ],
  ];
  const toward = label ? Math.atan2(label[1] - corner[1], label[0] - corner[0]) : null;
  const spans: Span[] = pairs.map(([u, v]) => {
    const [a, b] = [Math.atan2(u[1], u[0]), Math.atan2(v[1], v[0])];

    return turn(a, b) <= Math.PI ? { from: a, to: b } : { from: b, to: a };
  });
  const degreesOf = (s: Span) => (turn(s.from, s.to) * 180) / Math.PI;
  const nearest = (pool: Span[]) =>
    pool.reduce((best, s) =>
      Math.abs(degreesOf(s) - wanted!) < Math.abs(degreesOf(best) - wanted!) - 1e-9 ? s : best,
    );
  // The corners that show the angle wanted (it and the one opposite); the label picks between them,
  // or among all four when the angle is not known.
  const showing =
    wanted === undefined ? spans : spans.filter((s) => Math.abs(degreesOf(s) - wanted) <= MATCH_DEGREES);
  const pool = showing.length ? showing : spans;
  const contains = (s: Span, angle: number) => turn(s.from, angle) <= turn(s.from, s.to);
  const span =
    toward === null
      ? wanted === undefined
        ? spans[0]!
        : nearest(spans)
      : (pool.find((s) => contains(s, toward)) ?? closestTo(pool, toward));
  const shorter = Math.min(distance2(p.a, p.b), distance2(q.a, q.b));
  const radius = label ? distance2(label, corner) : shorter * DEFAULT_RADIUS_SHARE;
  const sweep = turn(span.from, span.to);
  const middle = span.from + sweep / 2;

  return {
    corner,
    from: span.from,
    to: span.from + sweep,
    radius,
    degrees: (sweep * 180) / Math.PI,
    label: [corner[0] + radius * Math.cos(middle), corner[1] + radius * Math.sin(middle)],
  };
}

/**
 * Lines to draw for an angle: the arc, and a ray from the corner out to each end of the arc where the
 * line itself does not reach that far (as extension lines show where a length is measured).
 */
export function angleArcLines(arc: AngleArc, p: Segment, q: Segment): Segment[] {
  const at = (angle: number, r = arc.radius): Vec2 => [
    arc.corner[0] + r * Math.cos(angle),
    arc.corner[1] + r * Math.sin(angle),
  ];
  const steps = Math.max(2, Math.ceil(((arc.to - arc.from) / (2 * Math.PI)) * ARC_STEPS_PER_TURN));
  const lines: Segment[] = [];

  for (let i = 0; i < steps; i++) {
    const a = arc.from + ((arc.to - arc.from) * i) / steps;
    const b = arc.from + ((arc.to - arc.from) * (i + 1)) / steps;
    lines.push({ a: at(a), b: at(b) });
  }

  // From the corner to the arc, along each side: only the stretch the line does not cover.
  for (const angle of [arc.from, arc.to]) {
    const end = at(angle);
    const covered = [p, q].some((segment) => onSegment(segment, end));
    if (!covered) lines.push({ a: arc.corner, b: end });
  }

  return lines;
}

/** True when a point lies on a segment (within a hair). */
function onSegment(segment: Segment, point: Vec2): boolean {
  const length = distance2(segment.a, segment.b);

  return Math.abs(distance2(segment.a, point) + distance2(point, segment.b) - length) < length * 1e-6 + 1e-9;
}
