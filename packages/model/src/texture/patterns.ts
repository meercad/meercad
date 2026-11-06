/**
 * Height functions of the surface texture patterns. Each takes a point in pattern units (one unit is
 * one `pitch`), `a` across and `b` along the pattern (with angle 0, ribs run along `b`), and returns
 * a height from 0 (the face itself) to 1 (the full depth). Every pattern repeats after its periods
 * in `a` and `b`, so it can close seamlessly around a round face (see `fitWrap`). The random patterns
 * use noise that repeats too, seeded so the same seed gives the same surface on every device.
 */
import type { TexturePattern } from "@meercad/schema";

/** A greyscale height picture, decoded: `pixels` row by row from the top, 0–255. */
export interface HeightImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface PatternOptions {
  /** Raised share of each repeat (patterns that take it); undefined: the pattern's default. */
  ratio?: number;
  seed?: number;
  image?: HeightImage;
  invert?: boolean;
}

export interface PatternInfo {
  /** Repeat across (`a`) and along (`b`) in pattern units; `b` 0: the height does not change along `b`. */
  periodA: number;
  periodB: number;
  /** Default raised share, when the pattern takes one. */
  ratio?: number;
  /** Starting values for a new texture: repeat and depth in mm. */
  pitch: number;
  depth: number;
}

const SQRT3 = Math.sqrt(3);
const KNURL = Math.tan(Math.PI / 6);

export const PATTERNS: Record<TexturePattern, PatternInfo> = {
  ribs: { periodA: 1, periodB: 0, ratio: 0.8, pitch: 3, depth: 0.6 },
  ribs_square: { periodA: 1, periodB: 0, ratio: 0.5, pitch: 3, depth: 0.6 },
  ribs_v: { periodA: 1, periodB: 0, pitch: 2, depth: 0.6 },
  knurl: { periodA: 1, periodB: 1 / KNURL, pitch: 2, depth: 0.5 },
  cross_knurl: { periodA: 1, periodB: 1, pitch: 2, depth: 0.5 },
  hex: { periodA: 1, periodB: SQRT3, ratio: 0.85, pitch: 6, depth: 0.6 },
  dots: { periodA: 1, periodB: SQRT3, ratio: 0.7, pitch: 3, depth: 0.5 },
  waves: { periodA: 1, periodB: 2, pitch: 5, depth: 0.6 },
  brick: { periodA: 1, periodB: 1, ratio: 0.9, pitch: 10, depth: 0.6 },
  wood: { periodA: 4, periodB: 16, pitch: 4, depth: 0.4 },
  leather: { periodA: 8, periodB: 8, pitch: 3, depth: 0.4 },
  weave: { periodA: 1, periodB: 1, pitch: 5, depth: 0.5 },
  image: { periodA: 1, periodB: 1, pitch: 20, depth: 0.8 },
};

const fract = (x: number) => x - Math.floor(x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
/** Triangle wave: 0 at whole numbers, 1 halfway between. */
const tri = (x: number) => 1 - Math.abs(2 * fract(x) - 1);
const mod = (i: number, n: number) => ((i % n) + n) % n;

/** Integer hash of a lattice point and a seed, as a number in [0, 1). */
function hash(i: number, j: number, seed: number): number {
  let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(seed + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1] that repeats every `px` × `py` lattice cells. */
function noise(x: number, y: number, px: number, py: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const i0 = mod(i, px), i1 = mod(i + 1, px), j0 = mod(j, py), j1 = mod(j + 1, py);
  const a = hash(i0, j0, seed), b = hash(i1, j0, seed), c = hash(i0, j1, seed), d = hash(i1, j1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Sum of noise octaves, each twice as fine; still repeats every `px` × `py` of the first octave. */
function fbm(x: number, y: number, px: number, py: number, seed: number, octaves: number): number {
  let sum = 0, amp = 0.5, total = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f, y * f, px * f, py * f, seed + o * 101);
    total += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / total;
}

/**
 * Hex lattice with neighbouring centres 1 apart along `a`: the offset from the nearest centre. Rows
 * are √3/2 apart, every other row shifted by half.
 */
function hexOffset(a: number, b: number): [number, number] {
  const rowH = SQRT3 / 2;
  const r = Math.round(b / rowH);
  let best: [number, number] = [0, 0];
  let bestD = Infinity;
  for (let dr = -1; dr <= 1; dr++) {
    const row = r + dr;
    const shift = mod(row, 2) * 0.5;
    const col = Math.round(a - shift);
    for (let dc = -1; dc <= 1; dc++) {
      const x = a - (col + dc + shift);
      const y = b - row * rowH;
      const d = x * x + y * y;
      if (d < bestD) {
        bestD = d;
        best = [x, y];
      }
    }
  }
  return best;
}

/** Hexagonal distance: 0.5 on the border of a cell (flat sides facing the neighbours). */
function hexNorm([x, y]: [number, number]): number {
  const c = 0.5, s = SQRT3 / 2;
  return Math.max(Math.abs(x), Math.abs(c * x + s * y), Math.abs(c * x - s * y));
}

/** Distances to the nearest and second-nearest cell points (one jittered point per cell, cells repeat every `p`). */
function cells(x: number, y: number, p: number, seed: number): [number, number] {
  const i = Math.floor(x), j = Math.floor(y);
  let f1 = Infinity, f2 = Infinity;
  for (let di = -1; di <= 1; di++)
    for (let dj = -1; dj <= 1; dj++) {
      const ci = i + di, cj = j + dj;
      const hi = mod(ci, p), hj = mod(cj, p);
      const px = ci + 0.15 + 0.7 * hash(hi, hj, seed);
      const py = cj + 0.15 + 0.7 * hash(hi, hj, seed + 7);
      const d = Math.hypot(x - px, y - py);
      if (d < f1) {
        f2 = f1;
        f1 = d;
      } else if (d < f2) f2 = d;
    }
  return [f1, f2];
}

function sampleImage(img: HeightImage, a: number, b: number): number {
  // The picture spans one pitch across and keeps its proportions along; row 0 is its top.
  const aspect = img.height / img.width;
  const x = fract(a) * img.width - 0.5;
  const y = (1 - fract(b / aspect)) * img.height - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const tx = x - x0, ty = y - y0;
  const px = (i: number, j: number) => img.pixels[mod(j, img.height) * img.width + mod(i, img.width)]! / 255;
  const top = px(x0, y0) * (1 - tx) + px(x0 + 1, y0) * tx;
  const bottom = px(x0, y0 + 1) * (1 - tx) + px(x0 + 1, y0 + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** Periods of a pattern, `image` taking the picture's proportions. */
export function patternPeriods(pattern: TexturePattern, image?: HeightImage): [number, number] {
  if (pattern === "image" && image) return [1, image.height / image.width];
  return [PATTERNS[pattern].periodA, PATTERNS[pattern].periodB];
}

/** The height function of a pattern with its options filled in. */
export function patternHeight(pattern: TexturePattern, opts: PatternOptions = {}): (a: number, b: number) => number {
  const ratio = Math.min(0.95, Math.max(0.1, opts.ratio ?? PATTERNS[pattern].ratio ?? 0.5));
  const seed = Math.round(opts.seed ?? 0);
  const h = base(pattern, ratio, seed, opts.image);
  return opts.invert ? (a, b) => 1 - h(a, b) : h;
}

function base(pattern: TexturePattern, ratio: number, seed: number, image?: HeightImage): (a: number, b: number) => number {
  switch (pattern) {
    case "ribs": {
      // Round ribs: a half-round across each rib, `ratio` of the repeat wide, centred in it.
      const w = ratio / 2;
      return (a) => {
        const x = (fract(a) - 0.5) / w;
        return x * x < 1 ? Math.sqrt(1 - x * x) : 0;
      };
    }
    case "ribs_square": {
      const w = ratio / 2;
      return (a) => smooth(w + 0.03, w - 0.03, Math.abs(fract(a) - 0.5));
    }
    case "ribs_v":
      return (a) => tri(a);
    case "knurl":
      // Diamonds between two sets of grooves at ±30° to the length.
      return (a, b) => Math.min(tri(a + b * KNURL), tri(a - b * KNURL));
    case "cross_knurl":
      return (a, b) => Math.min(tri(a), tri(b));
    case "hex": {
      // Raised hexagonal cells; grooves between them take 1 − ratio of the cell.
      const ramp = Math.max(0.02, 0.5 - ratio / 2);
      return (a, b) => smooth(0, 1, (0.5 - hexNorm(hexOffset(a, b))) / ramp);
    }
    case "dots": {
      const r = ratio / 2;
      return (a, b) => {
        const [x, y] = hexOffset(a, b);
        const d = (x * x + y * y) / (r * r);
        return d < 1 ? Math.sqrt(1 - d) : 0;
      };
    }
    case "waves":
      return (a, b) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (a + 0.3 * Math.sin(Math.PI * b)));
    case "brick": {
      // Bricks one pitch long and half a pitch high, every other row shifted by half; the mortar
      // joints take 1 − ratio of a brick's height.
      const g = (1 - ratio) * 0.25;
      return (a, b) => {
        const row = Math.floor(b * 2);
        const x = fract(a + 0.5 * mod(row, 2));
        const y = fract(b * 2);
        const d = Math.min(Math.min(x, 1 - x), Math.min(y, 1 - y) * 0.5);
        return smooth(g, g + 0.03, d);
      };
    }
    case "wood":
      // Grain lines along the length, bent by slow noise, with fine fibres.
      return (a, b) => {
        const warp = fbm(a * 0.5, b * 0.125, 2, 2, seed, 3);
        const lines = 0.5 + 0.5 * Math.sin(2 * Math.PI * (a + 1.6 * warp));
        const fibres = noise(a * 4, b * 0.5, 16, 8, seed + 31);
        return clamp01(0.8 * lines * lines + 0.2 * fibres);
      };
    case "leather":
      // Cells with grooves between them, and a fine grain on top.
      return (a, b) => {
        const [f1, f2] = cells(a, b, 8, seed);
        const cell = smooth(0, 0.3, f2 - f1);
        const grain = fbm(a * 4, b * 4, 32, 32, seed + 17, 2);
        return clamp01(0.85 * cell + 0.15 * grain);
      };
    case "weave": {
      // Basket weave: strands half a pitch wide, alternating direction from square to square.
      const s = (t: number) => Math.sqrt(Math.sin(Math.PI * clamp01(t)));
      return (a, b) => {
        const i = Math.floor(a * 2), j = Math.floor(b * 2);
        const x = fract(a * 2), y = fract(b * 2);
        return mod(i + j, 2) === 0 ? s(y) * (0.6 + 0.4 * s(x)) : s(x) * (0.6 + 0.4 * s(y));
      };
    }
    case "image":
      return image ? (a, b) => sampleImage(image, a, b) : () => 0;
  }
}

/**
 * Pitch and angle adjusted so the pattern closes on itself around a round face of circumference
 * `perimeter` (mm): whole repeats around, in both pattern directions. Close to what was asked.
 */
export function fitWrap(perimeter: number, pitch: number, angleDeg: number, periodA: number, periodB: number): { pitch: number; angle: number } {
  const t = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(t), sa = Math.sin(t);
  // Going once round moves (perimeter·cos, −perimeter·sin) in (a, b), in mm.
  const m = Math.round((perimeter * ca) / (pitch * periodA));
  if (periodB === 0) {
    // Stripes: only the count across matters.
    if (m === 0 || Math.abs(ca) < 1e-9) return { pitch, angle: angleDeg };
    return { pitch: (perimeter * Math.abs(ca)) / (Math.abs(m) * periodA), angle: angleDeg };
  }
  const n = Math.round((perimeter * sa) / (pitch * periodB));
  if (m === 0 && n === 0) return { pitch, angle: angleDeg };
  const len = Math.hypot(m * periodA, n * periodB);
  return { pitch: perimeter / len, angle: (Math.atan2(n * periodB, m * periodA) * 180) / Math.PI };
}

/** Decodes a texture's base64 picture (see TextureImage). */
export function decodeHeightImage(img: { width: number; height: number; pixels: string }): HeightImage {
  const bin = atob(img.pixels);
  const pixels = new Uint8Array(img.width * img.height);
  for (let i = 0; i < pixels.length && i < bin.length; i++) pixels[i] = bin.charCodeAt(i);
  return { width: img.width, height: img.height, pixels };
}
