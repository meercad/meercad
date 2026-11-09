/**
 * Hole sizes for metric screws: clearance holes (ISO 273), counterbores for socket head cap screws
 * (ISO 4762 heads, DIN 974-1 counterbores), countersinks for countersunk screws (ISO 10642, 90°),
 * tap drills (coarse pitch), and holes for heat-set threaded inserts as printed parts use them
 * (sizes, lengths and minimum walls as the common makers give them).
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
}

/**
 * Heat-set inserts for printed parts (knurled brass, as the common makers sell them, e.g. CNC Kitchen
 * and ruthex): the hole to melt them into, their outside, the thinnest wall around them that still
 * holds, and the lengths they come in (the first is the usual one, short versions after it).
 */
interface InsertRow {
  hole: number;
  outer: number;
  wall: number;
  lengths: number[];
}

const INSERTS: Record<string, InsertRow> = {
  M2: { hole: 3.2, outer: 3.6, wall: 1.3, lengths: [4, 3] },
  "M2.5": { hole: 4, outer: 4.6, wall: 1.6, lengths: [5.7, 4] },
  M3: { hole: 4, outer: 4.6, wall: 1.6, lengths: [5.7, 4, 3] },
  M4: { hole: 5.6, outer: 6.3, wall: 2.1, lengths: [8.1, 4] },
  M5: { hole: 6.4, outer: 7.1, wall: 2.6, lengths: [9.5, 5.8] },
  M6: { hole: 8, outer: 8.7, wall: 3.3, lengths: [12.7] },
  M8: { hole: 9.7, outer: 10.2, wall: 4.5, lengths: [12.7] },
  M10: { hole: 12, outer: 12.6, wall: 6, lengths: [12.7] },
};

const ROWS: Row[] = [
  { size: "M2", d: 2, clearance: [2.2, 2.4, 2.6], counterbore: [4.3, 2], countersink: 4.4 },
  { size: "M2.5", d: 2.5, clearance: [2.7, 2.9, 3.1], counterbore: [5, 2.5], countersink: 5.5 },
  { size: "M3", d: 3, clearance: [3.2, 3.4, 3.6], counterbore: [6, 3], countersink: 6.72 },
  { size: "M4", d: 4, clearance: [4.3, 4.5, 4.8], counterbore: [8, 4], countersink: 8.96 },
  { size: "M5", d: 5, clearance: [5.3, 5.5, 5.8], counterbore: [10, 5], countersink: 11.2 },
  { size: "M6", d: 6, clearance: [6.4, 6.6, 7], counterbore: [11, 6], countersink: 13.44 },
  { size: "M8", d: 8, clearance: [8.4, 9, 10], counterbore: [15, 8], countersink: 17.92 },
  { size: "M10", d: 10, clearance: [10.5, 11, 12], counterbore: [18, 10], countersink: 22.4 },
  { size: "M12", d: 12, clearance: [13, 13.5, 14.5], counterbore: [20, 12], countersink: 26.88 },
  { size: "M16", d: 16, clearance: [17, 17.5, 18.5], counterbore: [26, 16], countersink: 33.6 },
];

export const HOLE_SIZES: readonly string[] = ROWS.map((r) => r.size);
export const INSERT_SIZES: readonly string[] = Object.keys(INSERTS);

/** A heat-set insert: the lengths a size comes in, the usual one first. */
export function insertLengths(size: string): readonly number[] {
  return INSERTS[size]?.lengths ?? [];
}

export interface InsertDims {
  size: string;
  /** Hole to melt it into (also the part's outside as the model shows it, flush in that hole). */
  hole: number;
  /** Outside of the knurl, for ordering. */
  outer: number;
  length: number;
  /** Thinnest wall around the hole that still holds the insert. */
  wall: number;
}

export class InsertError extends Error {}

/**
 * A heat-set insert's sizes, for sizes that have one; `length` picks one of the lengths it comes
 * in (default the usual one). Undefined for an unknown size; an unknown length throws.
 */
export function insertDims(size: string, length?: number): InsertDims | undefined {
  const r = INSERTS[size];
  if (!r) return undefined;
  const L = length ?? r.lengths[0]!;
  if (!r.lengths.some((x) => Math.abs(x - L) < 1e-6)) throw new InsertError(`${size} inserts come ${r.lengths.length === 1 ? "only" : "in"} ${r.lengths.map((x) => `${x} mm`).join(", ")} long, not ${L} mm`);
  return { size, hole: r.hole, outer: r.outer, length: L, wall: r.wall };
}

/** How an insert is called in the parts list: "M3×5.7 heat-set insert". */
export const insertLabel = (d: InsertDims): string => `${d.size}×${d.length} heat-set insert`;

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
  /** The heat-set insert the hole is for. */
  insert?: InsertDims;
}

export class HoleError extends Error {}

/**
 * The hole for a kind and size. `allowance` widens every diameter (printed holes come out small);
 * `depth` is the bore depth for blind holes (inserts default to the insert length plus 1 mm).
 */
export function holeShape(kind: HoleKind, o: { size?: string | undefined; diameter?: number | undefined; fit?: HoleFit | undefined; depth?: number | undefined; allowance?: number | undefined; length?: number | undefined }): HoleShape {
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
      let ins: InsertDims | undefined;
      try {
        ins = insertDims(row.size, o.length);
      } catch (e) {
        if (e instanceof InsertError) throw new HoleError(e.message);
        throw e;
      }
      if (!ins) throw new HoleError(`no insert size for ${row.size}: use one of ${INSERT_SIZES.join(", ")}`);
      // 1 mm deeper than the insert: room for the plastic it pushes down.
      const depth = o.depth ?? ins.length + 1;
      if (depth < ins.length) throw new HoleError(`the hole must be at least as deep as the insert (${ins.length} mm)`);
      return { diameter: ins.hole + a, depth, insert: ins };
    }
  }
}
