/**
 * Hole sizes for metric screws: clearance holes (ISO 273), counterbores for socket head cap screws
 * (ISO 4762 heads, DIN 974-1 counterbores), countersinks for countersunk screws (ISO 10642, 90°),
 * tap drills (coarse pitch), and holes for heat-set threaded inserts as printed parts use them.
 * Shared by the kernel, which cuts the holes, and the app, which offers the sizes.
 */

import { METRIC_THREADS } from "./threads.js";

export type HoleKind = "simple" | "clearance" | "counterbore" | "countersink" | "tapped" | "insert";
export type HoleFit = "close" | "normal" | "loose";

interface Row {
  size: string;
  d: number;
  /** ISO 273 fine / medium / coarse series. */
  clearance: [number, number, number];
  /** Counterbore diameter and the cap screw head height it takes. */
  counterbore: [number, number];
  /** Countersunk head diameter (ISO 10642, theoretical maximum). */
  countersink: number;
  /** Heat-set insert: hole diameter and insert length (typical knurled brass inserts for plastic). */
  insert?: [number, number];
}

const ROWS: Row[] = [
  { size: "M2", d: 2, clearance: [2.2, 2.4, 2.6], counterbore: [4.3, 2], countersink: 4.4, insert: [3.2, 4] },
  { size: "M2.5", d: 2.5, clearance: [2.7, 2.9, 3.1], counterbore: [5, 2.5], countersink: 5.5, insert: [3.6, 5.7] },
  { size: "M3", d: 3, clearance: [3.2, 3.4, 3.6], counterbore: [6, 3], countersink: 6.72, insert: [4, 5.7] },
  { size: "M4", d: 4, clearance: [4.3, 4.5, 4.8], counterbore: [8, 4], countersink: 8.96, insert: [5.6, 8.1] },
  { size: "M5", d: 5, clearance: [5.3, 5.5, 5.8], counterbore: [10, 5], countersink: 11.2, insert: [6.4, 9.5] },
  { size: "M6", d: 6, clearance: [6.4, 6.6, 7], counterbore: [11, 6], countersink: 13.44, insert: [8, 12.7] },
  { size: "M8", d: 8, clearance: [8.4, 9, 10], counterbore: [15, 8], countersink: 17.92, insert: [9.7, 12.7] },
  { size: "M10", d: 10, clearance: [10.5, 11, 12], counterbore: [18, 10], countersink: 22.4 },
  { size: "M12", d: 12, clearance: [13, 13.5, 14.5], counterbore: [20, 12], countersink: 26.88 },
  { size: "M16", d: 16, clearance: [17, 17.5, 18.5], counterbore: [26, 16], countersink: 33.6 },
];

export const HOLE_SIZES: readonly string[] = ROWS.map((r) => r.size);
export const INSERT_SIZES: readonly string[] = ROWS.filter((r) => r.insert).map((r) => r.size);

/** The shape of one hole, from the surface inwards. */
export interface HoleShape {
  /** Main bore diameter. */
  diameter: number;
  /** Counterbore: wider bore at the top. */
  counterbore?: { diameter: number; depth: number };
  /** Countersink: 90° cone at the top, this wide at the surface. */
  countersink?: { diameter: number };
  /** Depth of the main bore (blind holes); undefined = through. */
  depth?: number;
  /** Thread to model in the bore (tapped holes). */
  thread?: { size: string; pitch: number };
}

export class HoleError extends Error {}

/**
 * The hole for a kind and size. `allowance` widens every diameter (printed holes come out small);
 * `depth` is the bore depth for blind holes (inserts default to the insert length plus 1 mm).
 */
export function holeShape(kind: HoleKind, o: { size?: string | undefined; diameter?: number | undefined; fit?: HoleFit | undefined; depth?: number | undefined; allowance?: number | undefined }): HoleShape {
  const a = o.allowance ?? 0;
  if (kind === "simple") {
    if (!(o.diameter! > 0)) throw new HoleError("a simple hole needs a diameter");
    return { diameter: o.diameter! + a, ...(o.depth !== undefined ? { depth: o.depth } : {}) };
  }
  const row = ROWS.find((r) => r.size === o.size);
  if (!row) throw new HoleError(`unknown size "${o.size ?? ""}": use one of ${HOLE_SIZES.join(", ")}`);
  const fit = o.fit === "close" ? 0 : o.fit === "loose" ? 2 : 1;
  const depth = o.depth !== undefined ? { depth: o.depth } : {};
  switch (kind) {
    case "clearance":
      return { diameter: row.clearance[fit] + a, ...depth };
    case "counterbore":
      // Head height plus a little, so the head sits just below the surface.
      return { diameter: row.clearance[fit] + a, counterbore: { diameter: row.counterbore[0] + a, depth: row.counterbore[1] + 0.4 }, ...depth };
    case "countersink":
      return { diameter: row.clearance[fit] + a, countersink: { diameter: row.countersink + 0.4 + a }, ...depth };
    case "tapped": {
      const t = METRIC_THREADS.find((x) => x.d === row.d);
      const pitch = t?.pitch ?? row.d * 0.15;
      return { diameter: row.d - pitch + a, thread: { size: row.size, pitch }, ...depth };
    }
    case "insert": {
      if (!row.insert) throw new HoleError(`no insert size for ${row.size}: use one of ${INSERT_SIZES.join(", ")}`);
      return { diameter: row.insert[0] + a, depth: o.depth ?? row.insert[1] + 1 };
    }
  }
}
