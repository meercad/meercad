/**
 * A dimension's text laid into its sketch plane as the camera really sees it: a rectangle in the plane
 * (as big there as the text is on the screen), its four corners projected, and the CSS matrix3d that
 * maps the text box onto that quadrilateral (a true perspective, no slanting stand-in). The text runs
 * along its dimension line, left to right on the screen, its top towards the top of the screen (turned
 * in the plane as needed, never mirrored), on the side of the line away from what it measures.
 */
type V3 = readonly [number, number, number];
type Screen = readonly [number, number];

/** Gap between a dimension line and its text (screen pixels). */
const TEXT_GAP_PX = 2;
/** A slanted plane enlarges its text at most this much, so it does not grow huge near the horizon. */
const MAX_STRETCH = 2.5;

const add = (a: V3, b: V3, k = 1): V3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

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

/**
 * The matrix3d that lays a text box `width` × `height` (pixels) into its plane: at `anchor` on its
 * line, the line running along `along` and its far side (away from what it measures) along `away`
 * (unit directions in the plane), `pixel` world units per screen pixel there. Null when the line is
 * seen end on or a corner is behind the camera.
 */
export function planeLabel(
  anchor: V3,
  along: V3,
  away: V3,
  width: number,
  height: number,
  pixel: number,
  project: (p: V3) => Screen | null,
): number[] | null {
  const at = project(anchor);
  const ahead = project(add(anchor, along));
  const aside = project(add(anchor, away));
  if (!at || !ahead || !aside) return null;

  const run: Screen = [ahead[0] - at[0], ahead[1] - at[1]];
  if (Math.hypot(run[0], run[1]) < 1e-6) return null;

  // Left to right, top up on the screen (y runs down); the text stands on the far side of the line.
  const x = run[0] < 0 ? neg(along) : along;
  const up = aside[1] > at[1] ? neg(away) : away;
  const outward = up === away ? 1 : -1;
  const [w, h] = halfSizes(anchor, x, up, width, height, pixel, project);

  return quad(add(anchor, up, outward * (h + TEXT_GAP_PX * pixel)), x, up, w, h, width, height, project);
}

/**
 * Half the text's width and height in the plane. Seen at a slant the plane shortens the text; it is
 * made that much larger there (within bounds), so it reads as on the screen while lying in the plane.
 */
function halfSizes(
  anchor: V3,
  x: V3,
  up: V3,
  width: number,
  height: number,
  pixel: number,
  project: (p: V3) => Screen | null,
): [number, number] {
  const across = (dir: V3, size: number) => {
    const p = project(add(anchor, dir, (size / 2) * pixel));
    const q = project(add(anchor, dir, (-size / 2) * pixel));

    return p && q ? Math.hypot(p[0] - q[0], p[1] - q[1]) : size;
  };

  const stretch = (dir: V3, size: number) =>
    Math.max(1, Math.min(MAX_STRETCH, size / Math.max(across(dir, size), 1e-6)));

  return [(width / 2) * pixel * stretch(x, width), (height / 2) * pixel * stretch(up, height)];
}

/** The matrix3d for the text box onto the rectangle round `centre` (half sizes w, h along x and up). */
function quad(
  centre: V3,
  x: V3,
  up: V3,
  w: number,
  h: number,
  width: number,
  height: number,
  project: (p: V3) => Screen | null,
): number[] | null {
  const corners = [
    add(add(centre, x, -w), up, h),
    add(add(centre, x, w), up, h),
    add(add(centre, x, w), up, -h),
    add(add(centre, x, -w), up, -h),
  ].map(project);
  if (corners.some((p) => !p)) return null;

  return boxToQuad(width, height, corners as Screen[]);
}

/** In-plane directions tried for a level text (every 5°: plenty to look level). */
const LEVEL_STEPS = 36;

/**
 * An angle's value in its plane, outside its arc in front of the arc's middle (`anchor`, the arc
 * running round towards `outward` from its corner): turned in the plane so it looks as level as it can
 * on the screen, upright, clear of the arc. `normal` is the plane's normal.
 */
export function levelLabel(
  anchor: V3,
  outward: V3,
  normal: V3,
  width: number,
  height: number,
  pixel: number,
  project: (p: V3) => Screen | null,
): number[] | null {
  const at = project(anchor);
  if (!at) return null;

  // The other way in the plane, across `outward`.
  const side = cross(normal, outward);
  let best: { x: V3; slope: number } | null = null;

  for (let i = 0; i < LEVEL_STEPS; i++) {
    const t = (i * Math.PI) / LEVEL_STEPS;
    const dir = add(scale(outward, Math.cos(t)), side, Math.sin(t));
    const p = project(add(anchor, dir));
    if (!p) continue;

    const [dx, dy] = [p[0] - at[0], p[1] - at[1]];
    const slope = Math.abs(dy) / Math.max(Math.abs(dx), 1e-9);
    if (!best || slope < best.slope) best = { x: dx < 0 ? neg(dir) : dir, slope };
  }

  if (!best) return null;

  // Up in the plane, across the text, towards the top of the screen.
  const across = cross(normal, best.x);
  const ahead = project(add(anchor, across));
  const up = ahead && ahead[1] > at[1] ? neg(across) : across;
  const [w, h] = halfSizes(anchor, best.x, up, width, height, pixel, project);
  // Out past the arc by enough that no corner of the text reaches back over it.
  const clear = Math.hypot(w, h) + TEXT_GAP_PX * pixel;

  return quad(add(anchor, outward, clear), best.x, up, w, h, width, height, project);
}

const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

/** A dimension's number: at most two decimals, no trailing zeros, with a decimal comma if asked. */
export function dimensionNumber(value: number, decimalComma: boolean): string {
  const text = String(+value.toFixed(2));

  return decimalComma ? text.replace(".", ",") : text;
}
