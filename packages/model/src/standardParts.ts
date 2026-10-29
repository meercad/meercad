/**
 * Standard parts by their norms: socket head cap screws (ISO 4762), hex nuts (ISO 4032), plain
 * washers (ISO 7089), deep-groove ball bearings (outer dimensions) and round magnets. Threads are
 * not modelled (as drawings show them); sizes are the nominal dimensions.
 */

export type StandardKind = "socket_screw" | "hex_nut" | "washer" | "bearing" | "magnet";

/** ISO 4762: head diameter, head height, socket (hex key) size, socket depth. */
const SCREWS: Record<string, { d: number; head: number; k: number; key: number; t: number }> = {
  M2: { d: 2, head: 3.8, k: 2, key: 1.5, t: 1 },
  "M2.5": { d: 2.5, head: 4.5, k: 2.5, key: 2, t: 1.1 },
  M3: { d: 3, head: 5.5, k: 3, key: 2.5, t: 1.3 },
  M4: { d: 4, head: 7, k: 4, key: 3, t: 2 },
  M5: { d: 5, head: 8.5, k: 5, key: 4, t: 2.5 },
  M6: { d: 6, head: 10, k: 6, key: 5, t: 3 },
  M8: { d: 8, head: 13, k: 8, key: 6, t: 4 },
  M10: { d: 10, head: 16, k: 10, key: 8, t: 5 },
  M12: { d: 12, head: 18, k: 12, key: 10, t: 6 },
  M16: { d: 16, head: 24, k: 16, key: 14, t: 8 },
};
/** Standard lengths of socket head cap screws, mm. */
export const SCREW_LENGTHS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100] as const;
/** ISO 4032: width across flats, height. */
const NUTS: Record<string, { d: number; s: number; m: number }> = {
  M2: { d: 2, s: 4, m: 1.6 },
  "M2.5": { d: 2.5, s: 5, m: 2 },
  M3: { d: 3, s: 5.5, m: 2.4 },
  M4: { d: 4, s: 7, m: 3.2 },
  M5: { d: 5, s: 8, m: 4.7 },
  M6: { d: 6, s: 10, m: 5.2 },
  M8: { d: 8, s: 13, m: 6.8 },
  M10: { d: 10, s: 16, m: 8.4 },
  M12: { d: 12, s: 18, m: 10.8 },
  M16: { d: 16, s: 24, m: 14.8 },
};
/** ISO 7089: inner and outer diameter, thickness. */
const WASHERS: Record<string, { inner: number; outer: number; h: number }> = {
  M2: { inner: 2.2, outer: 5, h: 0.3 },
  "M2.5": { inner: 2.7, outer: 6, h: 0.5 },
  M3: { inner: 3.2, outer: 7, h: 0.5 },
  M4: { inner: 4.3, outer: 9, h: 0.8 },
  M5: { inner: 5.3, outer: 10, h: 1 },
  M6: { inner: 6.4, outer: 12, h: 1.6 },
  M8: { inner: 8.4, outer: 16, h: 1.6 },
  M10: { inner: 10.5, outer: 20, h: 2 },
  M12: { inner: 13, outer: 24, h: 2.5 },
  M16: { inner: 17, outer: 30, h: 3 },
};
/** Deep-groove ball bearings: bore, outside diameter, width. */
const BEARINGS: Record<string, { bore: number; outer: number; width: number }> = {
  MR105: { bore: 5, outer: 10, width: 4 },
  "623": { bore: 3, outer: 10, width: 4 },
  "624": { bore: 4, outer: 13, width: 5 },
  "625": { bore: 5, outer: 16, width: 5 },
  "626": { bore: 6, outer: 19, width: 6 },
  "688": { bore: 8, outer: 16, width: 5 },
  "608": { bore: 8, outer: 22, width: 7 },
  "6000": { bore: 10, outer: 26, width: 8 },
  "6001": { bore: 12, outer: 28, width: 8 },
  "6200": { bore: 10, outer: 30, width: 9 },
};

export const STANDARD_SIZES: Record<StandardKind, readonly string[]> = {
  socket_screw: Object.keys(SCREWS),
  hex_nut: Object.keys(NUTS),
  washer: Object.keys(WASHERS),
  bearing: Object.keys(BEARINGS),
  magnet: [],
};

export const STANDARD_NAMES: Record<StandardKind, string> = {
  socket_screw: "Socket head cap screw ISO 4762",
  hex_nut: "Hex nut ISO 4032",
  washer: "Washer ISO 7089",
  bearing: "Ball bearing",
  magnet: "Round magnet",
};

/** The part as stacked rings about its axis, from where it stands (0) outwards: what the kernel turns into a solid. */
export interface StandardShape {
  /** Turned sections: outer radius, inner (hole) radius, from and to along the axis (negative goes into the material). */
  rings: { r: number; hole: number; from: number; to: number }[];
  /** A hexagonal outline instead of round for the ring at this index (nuts): width across flats. */
  hex?: { ring: number; across: number };
  /** A hex socket cut into the top: key size and depth (screws). */
  socket?: { key: number; depth: number; top: number };
  /** Label for the parts list, e.g. "M3×12 ISO 4762". */
  label: string;
}

export class StandardPartError extends Error {}

export function standardShape(kind: StandardKind, o: { size?: string | undefined; length?: number | undefined; diameter?: number | undefined; height?: number | undefined }): StandardShape {
  const need = <T,>(table: Record<string, T>): T => {
    const row = o.size ? table[o.size] : undefined;
    if (!row) throw new StandardPartError(`unknown size "${o.size ?? ""}": use one of ${Object.keys(table).join(", ")}`);
    return row;
  };
  switch (kind) {
    case "socket_screw": {
      const s = need(SCREWS);
      const L = o.length ?? 10;
      if (!(L > 0)) throw new StandardPartError("the screw's length must be greater than zero");
      // The head stands on the face, the shank goes in; the length is the shank's, as screws are sold.
      return { rings: [{ r: s.head / 2, hole: 0, from: 0, to: s.k }, { r: s.d / 2, hole: 0, from: -L, to: 0 }], socket: { key: s.key, depth: s.t, top: s.k }, label: `${o.size}×${L} ISO 4762` };
    }
    case "hex_nut": {
      const n = need(NUTS);
      return { rings: [{ r: n.s / Math.sqrt(3), hole: n.d / 2, from: 0, to: n.m }], hex: { ring: 0, across: n.s }, label: `${o.size} ISO 4032` };
    }
    case "washer": {
      const w = need(WASHERS);
      return { rings: [{ r: w.outer / 2, hole: w.inner / 2, from: 0, to: w.h }], label: `${o.size} ISO 7089` };
    }
    case "bearing": {
      const b = need(BEARINGS);
      return { rings: [{ r: b.outer / 2, hole: b.bore / 2, from: 0, to: b.width }], label: `${o.size} ${b.bore}×${b.outer}×${b.width}` };
    }
    case "magnet": {
      const d = o.diameter ?? 6, h = o.height ?? 3;
      if (!(d > 0) || !(h > 0)) throw new StandardPartError("the magnet needs a diameter and a height greater than zero");
      return { rings: [{ r: d / 2, hole: 0, from: 0, to: h }], label: `Magnet ${d}×${h}` };
    }
  }
}
