/**
 * Sizes of the open wall storage systems, written from their published dimensions: the openGrid
 * board (David D, CC BY 4.0) and its snaps, and the common pegboard hole patterns.
 *
 * openGrid: a 28 mm grid of square openings. Between two cells stands a 3 mm wall (1.5 mm from
 * each cell) that narrows to 1.6 mm in the middle of the board's depth, so a snap's flexible
 * sides click in behind the narrow front. At every crossing a node (a square turned 45°) takes
 * the openings' corners off. The lite board is the front 4 mm of the full 6.8 mm board.
 */

export const OPENGRID = {
  /** Grid pitch, mm. */
  pitch: 28,
  full: 6.8,
  lite: 4,
  /**
   * The wall beside each opening of the full board, as [depth from the back, how far it reaches
   * in from the cell's edge]: 0.4 mm chamfers at the faces, 1.5 mm at the front and back, 0.8 mm
   * in the middle with 1 mm transitions.
   */
  wall: [
    [0, 1.1],
    [0.4, 1.5],
    [1.4, 1.5],
    [2.4, 0.8],
    [4.4, 0.8],
    [5.4, 1.5],
    [6.4, 1.5],
    [6.8, 1.1],
  ] as [number, number][],
  /**
   * The node at each crossing, as [depth, reach]: the opening's corner is cut where the distances
   * to the two edges of the cell add up to less than the reach. 1.4 mm 45° chamfers at both faces.
   */
  node: [
    [0, 5.9],
    [1.4, 7.88],
    [5.4, 7.88],
    [6.8, 5.9],
  ] as [number, number][],
  /** The board's outside corners are cut off this far along each edge. */
  cornerCut: 4.2,
  /** Countersunk screws for the board: 4.1 mm through, 7.2 mm head, sunk 1 mm below the front. */
  screwDiameter: 4.1,
  screwHead: 7.2,
  screwInset: 1,
  /**
   * A snap: a 24.8 mm square with its corners cut 4.82 mm back (3.3 mm at the front 0.4 mm, and
   * 45° between down to 1.4 mm, just clear of the nodes' chamfer), as thick as the board (3.4 mm
   * for the lite board, whose snaps sit in its front).
   */
  snap: 24.8,
  snapCorner: 4.818,
  snapFrontCorner: 3.3,
  snapLite: 3.4,
  /**
   * The catch on each side: 11 mm long, 0.4 mm proud, from 0.2 to 2 mm above the snap's base (+3.4 on a full
   * snap).
   */
  nubLength: 11,
  nubHeight: 0.4,
  /** Behind each catch a 0.6 mm slot 1 mm in from the edge frees a 0.7 mm spring 12.4 mm long. */
  slotInset: 1,
  slotWidth: 0.6,
  slotLength: 12.4,
} as const;

export type PegGrid = "us_quarter" | "us_eighth" | "metric_25" | "square_38";

/** Pegboard presets: hole pitch, hole size (round diameter or square side), board thickness, shape. */
export const PEGBOARDS: Record<PegGrid, { pitch: number; hole: number; thickness: number; square: boolean }> =
  {
    us_quarter: { pitch: 25.4, hole: 7.1, thickness: 6.35, square: false },
    us_eighth: { pitch: 25.4, hole: 4.8, thickness: 3.2, square: false },
    metric_25: { pitch: 25, hole: 5, thickness: 3, square: false },
    square_38: { pitch: 38, hole: 10, thickness: 1.5, square: true },
  };

/** English names for the pegboard presets. */
export const PEGBOARD_NAMES: Record<PegGrid, string> = {
  us_quarter: '1" pitch, 7 mm holes',
  us_eighth: '1" pitch, 5 mm holes',
  metric_25: "25 mm pitch, 5 mm holes",
  square_38: "38 mm pitch, square holes",
};

export const WALL = {
  /** A holder's back plate is this much smaller than its cells. */
  plateGap: 1,
  plate: 3,
  /** Play between a peg and its hole (on the diameter). */
  pegPlay: 0.6,
  hookDepth: 40,
  hookRise: 10,
  ringDiameter: 20,
  ringDepth: 10,
  shelfDepth: 60,
  shelfLip: 8,
  bins: 1,
  screw: 4.1,
} as const;

export class WallError extends Error {}

/** The wall beside an openGrid opening at a depth (full board, from the back). */
export function openGridWall(z: number): number {
  return interp(OPENGRID.wall, z);
}

/** The reach of the crossing nodes at a depth (full board, from the back). */
export function openGridNode(z: number): number {
  return interp(OPENGRID.node, z);
}

function interp(table: readonly (readonly [number, number])[], z: number): number {
  if (z <= table[0]![0]) return table[0]![1];

  for (let i = 1; i < table.length; i++) {
    const [z1, v1] = table[i]!;
    const [z0, v0] = table[i - 1]!;
    if (z <= z1) return v0 + ((v1 - v0) * (z - z0)) / (z1 - z0);
  }

  return table[table.length - 1]![1];
}

/**
 * One openGrid opening (centred on the origin) as outlines from the back of the board to its
 * front: [z, octagon] with z from 0, every point where the profile bends.
 */
export function openGridOpening(variant: "full" | "lite"): { z: number; loop: [number, number][] }[] {
  const T = variant === "lite" ? OPENGRID.lite : OPENGRID.full;
  const off = OPENGRID.full - T;
  const zs = [
    ...new Set(
      [...OPENGRID.wall.map(([z]) => z), ...OPENGRID.node.map(([z]) => z), off].filter(
        (z) => z >= off - 1e-9,
      ),
    ),
  ].sort((a, b) => a - b);
  const half = OPENGRID.pitch / 2;

  return zs.map((z) => {
    const w = openGridWall(z),
      n = openGridNode(z);
    const a = half - w; // half the opening's width
    const b = OPENGRID.pitch - n - a; // where the corner cut meets the edge, |x| + |y| = pitch − node

    return { z: z - off, loop: octagon(a, b) };
  });
}

/**
 * A square of half-width a with its corners cut where |x| + |y| = a + b (b ≤ a), counter-clockwise from (a,
 * −b).
 */
export function octagon(a: number, b: number): [number, number][] {
  b = Math.min(b, a);

  return [
    [a, -b],
    [a, b],
    [b, a],
    [-b, a],
    [-a, b],
    [-a, -b],
    [-b, -a],
    [b, -a],
  ];
}

/** Board size for a wall area: as many whole cells as fit, and what is left on each side. */
export function wallFit(
  system: "opengrid" | "pegboard",
  size: [number, number],
  pitch: number = OPENGRID.pitch,
): { units: [number, number]; border: [number, number] } {
  const units: [number, number] = [Math.floor(size[0] / pitch + 1e-9), Math.floor(size[1] / pitch + 1e-9)];

  if (units[0] < 1 || units[1] < 1) {
    throw new WallError(`the ${system === "opengrid" ? "openGrid" : "pegboard"} needs at least ${pitch} mm`);
  }

  return { units, border: [(size[0] - units[0] * pitch) / 2, (size[1] - units[1] * pitch) / 2] };
}

/** The pegboard sizes a feature uses: its preset with any overrides. */
export function pegboard(grid: PegGrid | undefined, pitch?: number, hole?: number, thickness?: number) {
  const p = PEGBOARDS[grid ?? "us_quarter"];

  return {
    pitch: pitch ?? p.pitch,
    hole: hole ?? p.hole,
    thickness: thickness ?? p.thickness,
    square: p.square,
  };
}

/** Holder cells needed for a Gridfinity shelf of `bins` bins (42 mm each plus 1.5 mm side walls). */
export function binShelfCells(bins: number, pitch: number): number {
  return Math.ceil((bins * 42 + 3 + WALL.plateGap) / pitch - 1e-9);
}
