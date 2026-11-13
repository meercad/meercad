/**
 * Sizes of the open Gridfinity storage system (a 42 mm grid with 7 mm height units), written from
 * its published dimensions, and the outlines of the symbols on printable labels.
 *
 * Profiles are lists of [height, inset] from the bottom up: how far the outline lies inside the
 * part's outer edge at that height. Every outline is a rounded rectangle, its corner radius the
 * outer radius minus the inset, so the profile's slopes become flat faces and cone corners.
 */

export const GRIDFINITY = {
  /** Grid pitch, mm. */
  pitch: 42,
  /** Height unit, mm. */
  unit: 7,
  /** A bin is this much smaller than its cells (0.25 mm clearance on every side). */
  gap: 0.5,
  binRadius: 3.75,
  plateRadius: 4,
  /** A bin's foot under each cell: 0.8 mm 45° slope, 1.8 mm straight, 2.15 mm 45° slope. */
  foot: [
    [0, 2.95],
    [0.8, 2.15],
    [2.6, 2.15],
    [4.75, 0],
  ] as [number, number][],
  footHeight: 4.75,
  /** A baseplate's pocket, from its floor up: 0.7 mm 45°, 1.8 mm straight, 2.15 mm 45°. */
  pocket: [
    [0, 2.85],
    [0.7, 2.15],
    [2.5, 2.15],
    [4.65, 0],
  ] as [number, number][],
  pocketHeight: 4.65,
  /**
   * The stacking lip above a bin's rim, as seen from inside: 1.9 mm 45°, 1.8 mm straight,
   * 0.7 mm 45° up to a sharp edge at the outside, 4.4 mm above the rim. Below it a 45° support
   * runs down into the wall. A bin stacked on top sits 0.35 mm below the rim with its foot's
   * slopes on the lip's.
   */
  lip: [
    [0, 2.6],
    [1.9, 0.7],
    [3.7, 0.7],
    [4.4, 0],
  ] as [number, number][],
  lipHeight: 4.4,
  /** How far a stacked bin's bottom sits below the rim of the one under it. */
  stackDrop: 0.35,
  /** Magnet and screw holes: 13 mm from the cell's centre along both axes (four per cell). */
  holeOffset: 13,
  magnetDiameter: 6.5,
  magnetDepth: 2.4,
  screwDiameter: 3,
  screwDepth: 6,
  /** Through hole of a baseplate's screw (one per cell, countersunk 90° from the top). */
  plateScrewDiameter: 3.5,
  plateScrewHead: 7,
  wall: 1.2,
  binFloor: 7,
  plateFloorWithHoles: 3.4,
  tabWidth: 13,
  tabAngle: 36,
  /** A tab that does not run the compartment's full width is this long. */
  tabLength: 36,
} as const;

export class GridfinityError extends Error {}

/** Outer size of a bin, mm: width, depth, and height without and with the stacking lip. */
export function binSize(
  units: [number, number],
  height: number,
): { width: number; depth: number; rim: number; top: number } {
  const G = GRIDFINITY;

  return {
    width: units[0] * G.pitch - G.gap,
    depth: units[1] * G.pitch - G.gap,
    rim: height * G.unit,
    top: height * G.unit + G.lipHeight,
  };
}

/**
 * A baseplate for a drawer: as many whole cells as fit inside `size` (less `margin` all round so
 * it drops in), and the border left on each side to fill the drawer.
 */
export function drawerFit(
  size: [number, number],
  margin = 0.5,
): { units: [number, number]; outer: [number, number]; border: [number, number] } {
  const G = GRIDFINITY;
  const outer: [number, number] = [size[0] - 2 * margin, size[1] - 2 * margin];
  const units: [number, number] = [
    Math.floor(outer[0] / G.pitch + 1e-9),
    Math.floor(outer[1] / G.pitch + 1e-9),
  ];

  if (units[0] < 1 || units[1] < 1) {
    throw new GridfinityError(`the drawer must be at least ${G.pitch + 2 * margin} mm wide and deep`);
  }

  return { units, outer, border: [(outer[0] - units[0] * G.pitch) / 2, (outer[1] - units[1] * G.pitch) / 2] };
}

// ---------------------------------------------------------------- baseplates for an area

export type Poly2 = [number, number][];

/**
 * An area for a baseplate to fill, in the plane's coordinates: a rectangle of the plate's outer
 * size centred on the origin, or closed outlines (an outer loop and holes, inside by the even-odd
 * rule) with the gap to their edge still to take off.
 */
export type GridArea = { rect: [number, number] } | { loops: Poly2[]; gap: number };

/** How a baseplate fills an area and comes apart into pieces for the print bed. */
export interface AreaPlan {
  /** Bounds of the plate. */
  min: [number, number];
  max: [number, number];
  /** Lower-left corner of the grid's cell [0, 0]. */
  origin: [number, number];
  /** The grid's size in cells (its bounds; an outline may leave some out). */
  units: [number, number];
  /** The cells that get a pocket, [column, row] from the lower left. */
  cells: [number, number][];
  /** Where the pieces meet across x and across y, from min to max (both ends included). */
  cuts: [number[], number[]];
  /** The pieces lie turned by 90° on the bed (fewer of them that way). */
  turned: boolean;
}

const segDist = (px: number, py: number, a: [number, number], b: [number, number]) => {
  const dx = b[0] - a[0],
    dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2)) : 0;

  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
};

/** Point inside closed outlines (even-odd: holes count as outside). */
export function insideLoops(loops: readonly Poly2[], x: number, y: number): boolean {
  let n = 0;

  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const a = l[i]!,
        b = l[(i + 1) % l.length]!;
      if (a[1] > y !== b[1] > y && x < a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1])) n++;
    }
  }

  return n % 2 === 1;
}

/** Distance from an axis-aligned square (x0, y0, size s) to a segment, 0 where they cross. */
function squareSegDist(x0: number, y0: number, s: number, a: [number, number], b: [number, number]): number {
  const x1 = x0 + s,
    y1 = y0 + s;
  const inSq = (p: [number, number]) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  if (inSq(a) || inSq(b)) return 0;

  const corners: [number, number][] = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  let d = Infinity;

  for (let k = 0; k < 4; k++) {
    const c = corners[k]!,
      e = corners[(k + 1) % 4]!;
    // Crossing an edge of the square?
    const o = (p: [number, number], q: [number, number], r: [number, number]) =>
      (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    if (o(a, b, c) * o(a, b, e) < 0 && o(c, e, a) * o(c, e, b) < 0) return 0;

    d = Math.min(d, segDist(c[0], c[1], a, b));
  }

  const toSq = (p: [number, number]) =>
    Math.hypot(Math.max(x0 - p[0], 0, p[0] - x1), Math.max(y0 - p[1], 0, p[1] - y1));

  return Math.min(d, toSq(a), toSq(b));
}

/** The cells of a grid starting at (ox, oy) that lie wholly inside the outlines, `gap` from their edge. */
function cellsInLoops(
  loops: readonly Poly2[],
  gap: number,
  min: [number, number],
  max: [number, number],
  ox: number,
  oy: number,
): [number, number][] {
  const P = GRIDFINITY.pitch;
  const segs: [[number, number], [number, number]][] = [];
  for (const l of loops) for (let i = 0; i < l.length; i++) segs.push([l[i]!, l[(i + 1) % l.length]!]);

  const out: [number, number][] = [];
  const i0 = Math.ceil((min[0] - ox) / P - 1e-9),
    j0 = Math.ceil((min[1] - oy) / P - 1e-9);

  for (let i = i0; ox + (i + 1) * P <= max[0] + 1e-9; i++) {
    for (let j = j0; oy + (j + 1) * P <= max[1] + 1e-9; j++) {
      const x = ox + i * P,
        y = oy + j * P;
      if (!insideLoops(loops, x + P / 2, y + P / 2)) continue;

      let ok = true;

      for (const [a, b] of segs) {
        // Quick reject: a segment's box far from the square.
        if (
          Math.min(a[0], b[0]) > x + P + gap ||
          Math.max(a[0], b[0]) < x - gap ||
          Math.min(a[1], b[1]) > y + P + gap ||
          Math.max(a[1], b[1]) < y - gap
        ) {
          continue;
        }

        if (squareSegDist(x, y, P, a, b) < gap - 1e-9) {
          ok = false;
          break;
        }
      }

      if (ok) out.push([i, j]);
    }
  }

  return out;
}

/**
 * Cuts across one direction from `a` to `b` into pieces no longer than `L`, only on the lines at
 * `origin` + k · 42 mm (between cells): as few pieces as possible, as even as the lines allow.
 * Null when a stretch between two lines is longer than `L`.
 */
export function splitLine(a: number, b: number, origin: number, L: number): number[] | null {
  const P = GRIDFINITY.pitch,
    eps = 1e-6;
  if (b - a <= L + eps) return [a, b];

  const lines: number[] = [];

  for (let k = Math.ceil((a - origin) / P); origin + k * P < b - eps; k++) {
    if (origin + k * P > a + eps) lines.push(origin + k * P);
  }

  const greedy = [a];
  let pos = a;

  while (b - pos > L + eps) {
    const next = lines.filter((x) => x > pos + eps && x <= pos + L + eps).pop();
    if (next === undefined) return null;

    greedy.push((pos = next));
  }

  greedy.push(b);

  // As even as possible with the same number of pieces.
  const n = greedy.length - 1;
  const even = [a];

  for (let k = 1; k < n; k++) {
    const want = a + (k * (b - a)) / n;
    const x = lines.reduce((best, l) => (Math.abs(l - want) < Math.abs(best - want) ? l : best), lines[0]!);
    if (x <= even[even.length - 1]! + eps) return greedy;

    even.push(x);
  }

  even.push(b);

  return even.every((x, i) => i === 0 || x - even[i - 1]! <= L + eps) ? even : greedy;
}

/**
 * How a baseplate fills an area: whole cells (centred in a rectangle; in an outline placed so the
 * most fit, centred among equals), the rest of the area as a solid border (the fillers; without
 * `fill` the plate ends at its cells), and with a `bed` (usable width and depth) the cuts that part
 * it into pieces that each fit on it.
 */
export function areaPlan(area: GridArea, bed?: readonly [number, number], fill = true): AreaPlan {
  const P = GRIDFINITY.pitch;
  let min: [number, number],
    max: [number, number],
    origin: [number, number],
    units: [number, number],
    cells: [number, number][];

  if ("rect" in area) {
    const [w, d] = area.rect;
    units = [Math.floor(w / P + 1e-9), Math.floor(d / P + 1e-9)];

    if (units[0] < 1 || units[1] < 1) {
      throw new GridfinityError(`the area must be at least ${P} mm wide and deep`);
    }

    min = [-w / 2, -d / 2];
    max = [w / 2, d / 2];
    origin = [(-units[0] * P) / 2, (-units[1] * P) / 2];
    cells = [];
    for (let i = 0; i < units[0]; i++) for (let j = 0; j < units[1]; j++) cells.push([i, j]);
  } else {
    const pts = area.loops.flat();
    if (!pts.length) throw new GridfinityError("the outline is empty");

    min = [Math.min(...pts.map((p) => p[0])) + area.gap, Math.min(...pts.map((p) => p[1])) + area.gap];
    max = [Math.max(...pts.map((p) => p[0])) - area.gap, Math.max(...pts.map((p) => p[1])) - area.gap];

    // Grid offsets to try: lined up with the outline's corners (gap off), and centred.
    const mod = (v: number) => ((v % P) + P) % P;

    const offsets = (k: 0 | 1) => {
      const centre = mod((min[k] + max[k]) / 2 - (Math.floor((max[k] - min[k]) / P) * P) / 2);
      const set = [centre];
      for (const p of pts) set.push(mod(p[k] + area.gap), mod(p[k] - area.gap));

      const uniq = [...new Set(set.map((v) => Math.round(v * 100) / 100))];
      if (uniq.length <= 24) return uniq;

      return [centre, ...Array.from({ length: 21 }, (_, n) => n * 2)];
    };

    const mid: [number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2];
    let best: { ox: number; oy: number; cells: [number, number][]; off: number } | null = null;

    for (const ox of offsets(0)) {
      for (const oy of offsets(1)) {
        const c = cellsInLoops(area.loops, area.gap, min, max, ox, oy);
        if (!c.length) continue;

        const cx = c.reduce((s, [i]) => s + ox + (i + 0.5) * P, 0) / c.length,
          cy = c.reduce((s, [, j]) => s + oy + (j + 0.5) * P, 0) / c.length;
        const off = Math.hypot(cx - mid[0], cy - mid[1]);

        if (
          !best ||
          c.length > best.cells.length ||
          (c.length === best.cells.length && off < best.off - 1e-6)
        ) {
          best = { ox, oy, cells: c, off };
        }
      }
    }

    if (!best) throw new GridfinityError(`no ${P} mm cell fits inside the outline`);

    const i0 = Math.min(...best.cells.map((c) => c[0])),
      j0 = Math.min(...best.cells.map((c) => c[1]));
    const i1 = Math.max(...best.cells.map((c) => c[0])),
      j1 = Math.max(...best.cells.map((c) => c[1]));
    origin = [best.ox + i0 * P, best.oy + j0 * P];
    units = [i1 - i0 + 1, j1 - j0 + 1];
    cells = best.cells.map(([i, j]) => [i - i0, j - j0]);
  }

  // Without the border the plate is just its cells: pieces are measured from the grid's edge.
  if (!fill) {
    min = [origin[0], origin[1]];
    max = [origin[0] + units[0] * P, origin[1] + units[1] * P];
  }

  let cuts: [number[], number[]] = [
    [min[0], max[0]],
    [min[1], max[1]],
  ];
  let turned = false;

  if (bed) {
    if (!(bed[0] > 0 && bed[1] > 0)) {
      throw new GridfinityError("the print bed's usable size must be greater than zero");
    }

    const plan = (w: number, d: number) => {
      const x = splitLine(min[0], max[0], origin[0], w),
        y = splitLine(min[1], max[1], origin[1], d);

      return x && y ? { cuts: [x, y] as [number[], number[]], n: (x.length - 1) * (y.length - 1) } : null;
    };

    const flat = plan(bed[0], bed[1]),
      turn = bed[0] !== bed[1] ? plan(bed[1], bed[0]) : null;

    if (!flat && !turn) {
      throw new GridfinityError(
        `the print bed (${+bed[0].toFixed(1)} × ${+bed[1].toFixed(1)} mm usable) is too small for one cell and the border next to it`,
      );
    }

    if (flat && (!turn || flat.n <= turn.n)) {
      cuts = flat.cuts;
    } else {
      cuts = turn!.cuts;
      turned = true;
    }
  }

  return { min, max, origin, units, cells, cuts, turned };
}

/** Name of a piece of a cut-up baseplate: rows A, B, … from the front, columns 1, 2, … from the left. */
export function pieceName(col: number, row: number): string {
  let r = "";
  for (let n = row + 1; n > 0; n = Math.floor((n - 1) / 26)) r = String.fromCharCode(65 + ((n - 1) % 26)) + r;

  return `${r}${col + 1}`;
}

/** The compartments' sizes inside a bin: width, depth and height above the floor. */
export function compartments(
  units: [number, number],
  height: number,
  dividers: [number, number],
  wall: number = GRIDFINITY.wall,
  thickness: number = wall,
  floor: number = GRIDFINITY.binFloor,
) {
  const s = binSize(units, height);
  const inner = [s.width - 2 * wall, s.depth - 2 * wall];

  return {
    count: (dividers[0] + 1) * (dividers[1] + 1),
    width: (inner[0]! - dividers[0] * thickness) / (dividers[0] + 1),
    depth: (inner[1]! - dividers[1] * thickness) / (dividers[1] + 1),
    height: s.rim - floor,
  };
}

// ---------------------------------------------------------------- label symbols

export type Loop2 = [number, number][];

export const LABEL_SYMBOLS = [
  "screw_pan",
  "screw_countersunk",
  "screw_socket",
  "screw_hex",
  "nut",
  "washer",
  "insert",
] as const;
export type LabelSymbolKind = (typeof LABEL_SYMBOLS)[number];

/** English names for the label symbols. */
export const LABEL_SYMBOL_NAMES: Record<LabelSymbolKind, string> = {
  screw_pan: "Pan head screw",
  screw_countersunk: "Countersunk screw",
  screw_socket: "Socket head screw",
  screw_hex: "Hex head screw",
  nut: "Nut",
  washer: "Washer",
  insert: "Heat-set insert",
};

const circle = (cx: number, cy: number, r: number, n = 48, cw = false): Loop2 => {
  const pts = Array.from({ length: n }, (_, k) => {
    const a = (2 * Math.PI * k) / n;

    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });

  return cw ? pts.reverse() : pts;
};

const rect = (x0: number, y0: number, x1: number, y1: number): Loop2 => [
  [x0, y0],
  [x1, y0],
  [x1, y1],
  [x0, y1],
];

/**
 * A screw's shank from x0 to x1 with thread teeth on both edges, as points along the top edge (left to
 * right).
 */
function threadEdge(x0: number, x1: number, r: number, pitch: number, depth: number): Loop2 {
  const pts: Loop2 = [[x0, r - depth]];
  const n = Math.max(2, Math.floor((x1 - x0 - pitch * 0.5) / pitch));
  const start = x1 - n * pitch - pitch * 0.25;
  pts.push([start, r - depth]);

  for (let k = 0; k < n; k++) {
    pts.push([start + k * pitch + pitch / 2, r]);
    pts.push([start + (k + 1) * pitch, r - depth]);
  }

  return pts;
}

/**
 * A screw seen from the side, head on the left, as one outline (plus holes): the head's outline from
 * the shank's top edge round to its bottom edge, then the threaded shank with a chamfered tip.
 */
function screw(head: Loop2, headEnd: number, holes: Loop2[] = []): Loop2[] {
  const r = 0.17;
  const tip = 2.1;
  const top = threadEdge(headEnd, tip - 0.06, r, 0.15, 0.05);
  const shank: Loop2 = [
    ...top,
    [tip, r - 0.08],
    [tip, -(r - 0.08)],
    ...top.map(([x, y]) => [x, -y] as [number, number]).reverse(),
  ];

  // The head outline runs from the shank's bottom edge, round the head, to its top edge.
  return [[...shank, ...head], ...holes];
}

/**
 * Outlines of a label symbol, counter-clockwise outers and clockwise holes, about 1 unit high
 * (centred on y = 0) and starting at x = 0; `width` is how far it reaches.
 */
export function labelSymbol(kind: LabelSymbolKind): { loops: Loop2[]; width: number } {
  switch (kind) {
    case "screw_pan": {
      // A low dome: half an ellipse turned left, flat against the shank.
      const hw = 0.42;
      const dome: Loop2 = [];

      for (let k = 0; k <= 24; k++) {
        const a = -Math.PI / 2 - (Math.PI * k) / 24;
        const c = Math.cos(a),
          s = Math.sin(a);
        // A squarer dome than an ellipse (superellipse, exponent 3).
        dome.push([
          hw + hw * Math.sign(c) * Math.abs(c) ** (2 / 3),
          0.4 * Math.sign(s) * Math.abs(s) ** (2 / 3),
        ]);
      }

      // From the bottom of the shank's flat side round the dome to its top.
      return { loops: screw(dome, hw), width: 2.1 };
    }
    case "screw_countersunk": {
      // 90° cone from a short cylinder of 0.84 to the shank.
      const head: Loop2 = [
        [0.3, 0.17],
        [0.06, 0.41],
        [0, 0.41],
        [0, -0.41],
        [0.06, -0.41],
        [0.3, -0.17],
      ];

      return { loops: screw(head.reverse() as Loop2, 0.3), width: 2.1 };
    }
    case "screw_socket": {
      // A cylinder head with rounded top corners and the hex socket cut in from the left.
      const head: Loop2 = [
        [0.46, 0.17],
        [0.46, 0.36],
        [0.06, 0.36],
        [0, 0.3],
        [0, 0.14],
        [0.2, 0.14],
        [0.2, -0.14],
        [0, -0.14],
        [0, -0.3],
        [0.06, -0.36],
        [0.46, -0.36],
        [0.46, -0.17],
      ];

      return { loops: screw(head.reverse() as Loop2, 0.46), width: 2.1 };
    }
    case "screw_hex": {
      // A hex head from the side: three faces, the edges between them as slots.
      const head: Loop2 = [
        [0.32, 0.17],
        [0.32, 0.43],
        [0.04, 0.43],
        [0, 0.39],
        [0, -0.39],
        [0.04, -0.43],
        [0.32, -0.43],
        [0.32, -0.17],
      ];
      const slot = (y: number) => rect(0.05, y - 0.025, 0.27, y + 0.025).reverse() as Loop2;

      return { loops: screw(head.reverse() as Loop2, 0.32, [slot(0.15), slot(-0.15)]), width: 2.1 };
    }
    case "nut": {
      const hex: Loop2 = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 3) * k;

        return [0.5 + 0.5 * Math.cos(a), 0.5 * Math.sin(a)] as [number, number];
      });

      return { loops: [hex, circle(0.5, 0, 0.21, 40, true)], width: 1 };
    }
    case "washer":
      return { loops: [circle(0.5, 0, 0.5, 64), circle(0.5, 0, 0.23, 40, true)], width: 1 };
    case "insert": {
      // A knurled sleeve from the side: lead-in on the left, diagonal knurls along both edges.
      const len = 1.3,
        r = 0.38,
        lead = 0.16,
        pitch = 0.13,
        depth = 0.07;
      const top: Loop2 = [
        [0, r - 0.1],
        [lead, r - 0.1],
        [lead, r - depth],
      ];

      for (let x = lead; x + pitch <= len - 0.02; x += pitch) {
        top.push([x + pitch * 0.7, r]);
        top.push([x + pitch, r - depth]);
      }

      top.push([len, r - depth]);

      const outer: Loop2 = [...top.map(([x, y]) => [x, -y] as [number, number]), ...top.slice().reverse()];

      // The thread inside, seen through its open end.
      return { loops: [outer, rect(len - 0.55, -0.12, len - 0.08, 0.12).reverse() as Loop2], width: len };
    }
  }
}

/** Signed area of an outline (counter-clockwise positive). */
export function loopArea(l: Loop2): number {
  let a = 0;

  for (let i = 0; i < l.length; i++) {
    const [x0, y0] = l[i]!;
    const [x1, y1] = l[(i + 1) % l.length]!;
    a += x0 * y1 - x1 * y0;
  }

  return a / 2;
}
