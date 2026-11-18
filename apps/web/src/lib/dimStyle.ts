/**
 * How a dimension is drawn in its sketch's plane, as on a technical drawing: a length or distance as a
 * dimension line parallel to what it measures, set off to the side, with arrowheads at its ends and
 * extension lines from the measured points (a little gap at the points, a little overshoot past the
 * line), its value on the line; an angle as an arc between its two lines with arrowheads at both ends.
 * All in sketch coordinates; sizes come in sketch units (the caller turns screen pixels into them).
 */
import { dot2, sub2, type Vec2 } from "@meercad/sketch";
import { arcPoints, type AngleArc, type Segment } from "./angleDim";

/** Sizes of the drawing in sketch units (from screen pixels at the current zoom). */
export interface DimensionSizes {
  /** Gap between a measured point and its extension line. */
  gap: number;
  /** How far an extension line goes past the dimension line. */
  overshoot: number;
  /** Length of an arrowhead. */
  arrow: number;
  /** How far a dimension stands off what it measures until it is moved. */
  offset: number;
}

export interface DimensionDrawing {
  lines: Segment[];
  /** Filled arrowheads, three corners each. */
  arrows: [Vec2, Vec2, Vec2][];
  /** Where the value goes, the way its text runs and the side of the line it stands on. */
  text: { at: Vec2; along: Vec2; up: Vec2 };
  /** How far the dimension line stands off (signed, along `up` of the measured line). */
  offset: number;
}

/** An angle's arc is at least this many times a dimension's offset in radius (about 60 pixels). */
const MIN_ARC_PER_OFFSET = 2;

/** A value stands this far (per dimension offset) off its line: its gap and height. */
const TEXT_PER_OFFSET = 0.75;

/** Arrowheads are this much narrower than long (half width per length). */
const ARROW_HALF_WIDTH = 0.3;

const scaled = (v: Vec2, k: number): Vec2 => [v[0] * k, v[1] * k];
const plus = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];

/** A filled arrowhead with its tip at `tip`, pointing along the unit direction `dir`. */
export function arrowhead(tip: Vec2, dir: Vec2, length: number): [Vec2, Vec2, Vec2] {
  const back = plus(tip, scaled(dir, -length));
  const side: Vec2 = [-dir[1] * length * ARROW_HALF_WIDTH, dir[0] * length * ARROW_HALF_WIDTH];

  return [tip, plus(back, side), plus(back, scaled(side, -1))];
}

/**
 * A length between `a` and `b`, measured along `axis` (a unit direction; by default the way from `a`
 * to `b`). The dimension line goes through `label` when it has been moved (its distance off the
 * points, and where along it the value sits); otherwise it stands `sizes.offset` off, on the side
 * away from `inside` (the middle of the shape, so it does not run through it) — unless the sketch
 * lies on a part and only the other side keeps the dimension on the part's face (`onFace`): past the
 * face's edge it would hang in the air.
 */
export function lengthDrawing(
  a: Vec2,
  b: Vec2,
  sizes: DimensionSizes,
  label?: Vec2 | null,
  inside?: Vec2 | null,
  axis?: Vec2,
  onFace?: ((p: Vec2) => boolean) | null,
): DimensionDrawing | null {
  const u = axis ?? unit(sub2(b, a));
  if (!u) return null;

  const n: Vec2 = [-u[1], u[0]];
  const middle: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const away = inside && dot2(sub2(inside, middle), n) > 0 ? -1 : 1;

  // The dimension line's ends and its value (standing off the line by about its height) on the face.
  const fits = (side: number) => {
    const ends = [
      plus(a, scaled(n, side * sizes.offset)),
      plus(b, scaled(n, side * sizes.offset - dot2(sub2(b, a), n))),
    ];
    const text = plus(middleOf(ends)!, scaled(n, side * sizes.offset * TEXT_PER_OFFSET));

    return [...ends, text].every((p) => onFace!(p));
  };

  const awaySide = onFace && !label && !fits(away) && fits(-away) ? -away : away;
  const moved = label ? dot2(sub2(label, a), n) : 0;
  const offset = label && Math.abs(moved) > sizes.gap ? moved : awaySide * sizes.offset;
  const side = Math.sign(offset);
  // The measured points on the dimension line (for a length along an axis they differ in height).
  const a2 = plus(a, scaled(n, offset));
  const b2 = plus(b, scaled(n, offset - dot2(sub2(b, a), n)));
  const along = dot2(sub2(b2, a2), u);
  if (Math.abs(along) < 1e-12) return null;

  const t = label ? dot2(sub2(label, a2), u) / along : 0.5;
  const textAt = plus(a2, scaled(u, along * t));
  const lines: Segment[] = [{ a: a2, b: b2 }];

  // Moved past an end: the dimension line goes on to its value.
  if (t < 0 || t > 1) lines.push({ a: t < 0 ? a2 : b2, b: textAt });

  for (const [p, onLine] of [
    [a, a2],
    [b, b2],
  ] as const) {
    const reach = dot2(sub2(onLine, p), n);
    const way = Math.sign(reach) || side;
    lines.push({ a: plus(p, scaled(n, way * sizes.gap)), b: plus(onLine, scaled(n, way * sizes.overshoot)) });
  }

  const outward = Math.sign(along);

  return {
    lines,
    arrows: [arrowhead(a2, scaled(u, -outward), sizes.arrow), arrowhead(b2, scaled(u, outward), sizes.arrow)],
    text: { at: textAt, along: u, up: scaled(n, side) },
    offset,
  };
}

/** A unit vector along `v`, or null for none. */
function unit(v: Vec2): Vec2 | null {
  const length = Math.hypot(v[0], v[1]);

  return length > 1e-12 ? [v[0] / length, v[1] / length] : null;
}

/** An angle drawn as its arc with arrowheads at both ends (tangent to the arc), its value on the arc. */
export function angleDrawing(given: AngleArc, sizes: DimensionSizes): DimensionDrawing {
  // Never smaller than its arrowheads and value need (about 60 pixels on the screen).
  const radius = Math.max(given.radius, sizes.offset * MIN_ARC_PER_OFFSET);
  const middle = (given.from + given.to) / 2;
  const arc: AngleArc = {
    ...given,
    radius,
    label: [given.corner[0] + radius * Math.cos(middle), given.corner[1] + radius * Math.sin(middle)],
  };
  const points = arcPoints(arc);
  const lines = points.slice(1).map((b, i) => ({ a: points[i]!, b }));
  const tangent = (angle: number, way: number): Vec2 => [-Math.sin(angle) * way, Math.cos(angle) * way];

  return {
    lines,
    arrows: [
      arrowhead(points[0]!, tangent(arc.from, -1), sizes.arrow),
      arrowhead(points.at(-1)!, tangent(arc.to, 1), sizes.arrow),
    ],
    text: { at: arc.label, along: tangent(middle, 1), up: [Math.cos(middle), Math.sin(middle)] },
    offset: arc.radius,
  };
}

/** The middle of a set of points, to tell the inside of a shape from its outside. */
export function middleOf(points: Iterable<Vec2>): Vec2 | null {
  let sum: Vec2 = [0, 0];
  let count = 0;

  for (const p of points) {
    sum = plus(sum, p);
    count++;
  }

  return count ? scaled(sum, 1 / count) : null;
}

/** A sketch this many units across is drawn with dimension sizes of one unit per "pixel" below. */
const UNITS_PER_PIXEL = 1 / 350;
/** Sketches smaller than this (mm) are sized as if this big, so their dimensions stay readable. */
const MIN_EXTENT = 10;
/** On the model, one "pixel" of the dimension sizes is between this many screen pixels. */
const MIN_PIXELS_PER_UNIT = 0.9;
const MAX_PIXELS_PER_UNIT = 1.6;

/**
 * Sizes for a sketch `extent` units across (the diagonal of its points): the same on the drawing at
 * any zoom, in proportion to the sketch, as a drawing's dimensions are.
 */
export function sizesFor(extent: number, screenPixel?: number): DimensionSizes {
  const own = Math.max(extent, MIN_EXTENT) * UNITS_PER_PIXEL;
  // On the model, where it is seen from any distance: arrowheads and gaps no smaller and no bigger on
  // the screen than these bounds (one screen pixel is `screenPixel` units there).
  const pixel = screenPixel
    ? Math.min(Math.max(own, screenPixel * MIN_PIXELS_PER_UNIT), screenPixel * MAX_PIXELS_PER_UNIT)
    : own;

  return { gap: pixel * 3, overshoot: pixel * 5, arrow: pixel * 9, offset: pixel * 28 };
}

/** The diagonal of the box round some points (0 for none). */
export function extentOf(points: Iterable<Vec2>): number {
  const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

  for (const [x, y] of points) {
    box.x0 = Math.min(box.x0, x);
    box.y0 = Math.min(box.y0, y);
    box.x1 = Math.max(box.x1, x);
    box.y1 = Math.max(box.y1, y);
  }

  return box.x1 >= box.x0 ? Math.hypot(box.x1 - box.x0, box.y1 - box.y0) : 0;
}

/** Height of a dimension's text in sketch units it aims for (mm), and the pixel size its font has. */
const TEXT_HEIGHT = 3.2;
const FONT_PX = 12;
/** The text never shrinks or grows past these factors of its font size, however far it is zoomed. */
const MIN_TEXT_SCALE = 0.85;
const MAX_TEXT_SCALE = 1.4;
