/**
 * A dimension's text laid into its sketch plane like a sticker: a rectangle fixed in the plane (its size
 * from the zoom), on the side of its line away from what it measures, and the CSS matrix3d that maps
 * the text box onto its projected corners (a true perspective). It runs along its dimension line, left
 * to right on the screen, its top towards the top of the screen (turned round in the plane about its
 * middle when the view needs it, never mirrored).
 */
type V3 = readonly [number, number, number];
type Screen = readonly [number, number];

/** Gap between a dimension line and its text (screen pixels). */
const TEXT_GAP_PX = 2;

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/**
 * The homography that takes the unit square's corners (0,0), (1,0), (1,1), (0,1) to `quad`'s, as
 * [a, b, c, d, e, f, g, h]: x' = (a u + b v + c) / (g u + h v + 1), y' = (d u + e v + f) / (same).
 */
export function squareToQuad(quad: readonly Screen[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad as [Screen, Screen, Screen, Screen];
  const [dx1, dx2, dx3] = [x1 - x2, x3 - x2, x0 - x1 + x2 - x3];
  const [dy1, dy2, dy3] = [y1 - y2, y3 - y2, y0 - y1 + y2 - y3];
  const det = dx1 * dy2 - dx2 * dy1;
  const g = det ? (dx3 * dy2 - dx2 * dy3) / det : 0;
  const h = det ? (dx1 * dy3 - dx3 * dy1) / det : 0;

  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/** The CSS matrix3d that maps a box `width` × `height` (its top left at 0, 0) onto `quad`. */
export function boxToQuad(width: number, height: number, quad: readonly Screen[]): number[] {
  const [a, b, c, d, e, f, g, h] = squareToQuad(quad) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // Column-major: x scales by 1/width, y by 1/height.
  return [a / width, d / width, 0, g / width, b / height, e / height, 0, h / height, 0, 0, 1, 0, c, f, 0, 1];
}

/** A text box's corners in the world: top left, top right, bottom right, bottom left. */
export type PlaneQuad = readonly [V3, V3, V3, V3];

/** Which way the text is turned in its plane: along its line (or back), towards its side (or back). */
export interface Turn {
  x: 1 | -1;
  up: 1 | -1;
}

/**
 * How far past the turning point the view must go before the text turns round (sine of the angle,
 * about 15°): near it the text keeps its way, so it does not flip back and forth while orbiting.
 */
const TURN_HYSTERESIS = 0.26;
/** The plane is seen this nearly edge on (a square in it this much of a square on the screen, ~6°). */
const EDGE_ON = 0.1;

/**
 * The corners in its plane of a text box `width` × `height` (pixels), lying there like a sticker: its
 * middle fixed just off `anchor` on the side `away` from what it measures (unit directions in the
 * plane, its line running `along`), its size `pixel` world units per pixel (from the zoom, not the
 * angle it is seen at). Only which way it is turned depends on the view: left to right and upright on
 * the screen, turned round about its middle once the view is clearly past the turning point (`turn`,
 * the way it was before). Null when the line is seen end on or a point is behind the camera.
 */
export function planeCorners(
  anchor: V3,
  along: V3,
  away: V3,
  width: number,
  height: number,
  pixel: number,
  project: (p: V3) => Screen | null,
  turn?: Turn,
): { corners: PlaneQuad; turn: Turn } | null {
  const at = project(anchor);
  const ahead = project(add(anchor, along));
  const aside = project(add(anchor, away));
  if (!at || !ahead || !aside) return null;

  const r: Screen = [ahead[0] - at[0], ahead[1] - at[1]];
  const a: Screen = [aside[0] - at[0], aside[1] - at[1]];
  const run = unit(r);
  if (!run || !unit(a)) return null;

  // Left to right on the screen, once clearly past the turning point. Its top then is the side that
  // keeps the letters unmirrored (y runs down the screen): one turn of half a circle, never a flip of
  // one axis alone. (From behind the plane, that is the other side; which side the camera is on is
  // kept while it looks along the plane, where the text cannot be read anyway.)
  const x = turn && turn.x * run[0] > -TURN_HYSTERESIS ? turn.x : run[0] < 0 ? -1 : 1;
  // How open the plane is seen: the screen area of a square in it against its longer side's square.
  const cross = (r[0] * a[1] - r[1] * a[0]) / Math.max(r[0] ** 2 + r[1] ** 2, a[0] ** 2 + a[1] ** 2);
  const behind = turn && Math.abs(cross) < EDGE_ON ? turn.up !== turn.x : cross > 0;
  const up: 1 | -1 = behind ? (x === 1 ? -1 : 1) : x;
  const [w, h] = [(width / 2) * pixel, (height / 2) * pixel];
  const centre = add(anchor, away, h + TEXT_GAP_PX * pixel);
  const [ax, ay] = [scaled(along, x), scaled(away, up)];

  return {
    corners: [
      add(add(centre, ax, -w), ay, h),
      add(add(centre, ax, w), ay, h),
      add(add(centre, ax, w), ay, -h),
      add(add(centre, ax, -w), ay, -h),
    ],
    turn: { x, up },
  };
}

/** The matrix3d that lays a text box into its plane (see planeCorners), or null. */
export function planeLabel(
  anchor: V3,
  along: V3,
  away: V3,
  width: number,
  height: number,
  pixel: number,
  project: (p: V3) => Screen | null,
  turn?: Turn,
): number[] | null {
  const laid = planeCorners(anchor, along, away, width, height, pixel, project, turn);
  const seen = laid?.corners.map(project);
  if (!seen || seen.some((p) => !p)) return null;

  return boxToQuad(width, height, seen as Screen[]);
}

const scaled = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

function unit(v: Screen): Screen | null {
  const length = Math.hypot(v[0], v[1]);

  return length > 1e-6 ? [v[0] / length, v[1] / length] : null;
}

/** A dimension's number: at most two decimals, no trailing zeros, with a decimal comma if asked. */
export function dimensionNumber(value: number, decimalComma: boolean): string {
  const text = String(+value.toFixed(2));

  return decimalComma ? text.replace(".", ",") : text;
}
