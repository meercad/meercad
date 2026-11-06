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
export function binSize(units: [number, number], height: number): { width: number; depth: number; rim: number; top: number } {
  const G = GRIDFINITY;
  return { width: units[0] * G.pitch - G.gap, depth: units[1] * G.pitch - G.gap, rim: height * G.unit, top: height * G.unit + G.lipHeight };
}

/**
 * A baseplate for a drawer: as many whole cells as fit inside `size` (less `margin` all round so
 * it drops in), and the border left on each side to fill the drawer.
 */
export function drawerFit(size: [number, number], margin = 0.5): { units: [number, number]; outer: [number, number]; border: [number, number] } {
  const G = GRIDFINITY;
  const outer: [number, number] = [size[0] - 2 * margin, size[1] - 2 * margin];
  const units: [number, number] = [Math.floor(outer[0] / G.pitch + 1e-9), Math.floor(outer[1] / G.pitch + 1e-9)];
  if (units[0] < 1 || units[1] < 1) throw new GridfinityError(`the drawer must be at least ${G.pitch + 2 * margin} mm wide and deep`);
  return { units, outer, border: [(outer[0] - units[0] * G.pitch) / 2, (outer[1] - units[1] * G.pitch) / 2] };
}

/** The compartments' sizes inside a bin: width, depth and height above the floor. */
export function compartments(units: [number, number], height: number, dividers: [number, number], wall: number = GRIDFINITY.wall, thickness: number = wall, floor: number = GRIDFINITY.binFloor) {
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

export const LABEL_SYMBOLS = ["screw_pan", "screw_countersunk", "screw_socket", "screw_hex", "nut", "washer", "insert"] as const;
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

/** A screw's shank from x0 to x1 with thread teeth on both edges, as points along the top edge (left to right). */
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
  const shank: Loop2 = [...top, [tip, r - 0.08], [tip, -(r - 0.08)], ...top.map(([x, y]) => [x, -y] as [number, number]).reverse()];
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
        const c = Math.cos(a), s = Math.sin(a);
        // A squarer dome than an ellipse (superellipse, exponent 3).
        dome.push([hw + hw * Math.sign(c) * Math.abs(c) ** (2 / 3), 0.4 * Math.sign(s) * Math.abs(s) ** (2 / 3)]);
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
      const len = 1.3, r = 0.38, lead = 0.16, pitch = 0.13, depth = 0.07;
      const top: Loop2 = [[0, r - 0.1], [lead, r - 0.1], [lead, r - depth]];
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
