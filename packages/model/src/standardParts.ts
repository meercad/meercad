/**
 * Standard parts by their norms: socket head cap screws (ISO 4762), countersunk screws (ISO 10642),
 * hex head screws (ISO 4017), set screws (ISO 4026), hex nuts (ISO 4032), plain washers (ISO 7089),
 * heat-set inserts, deep-groove ball bearings (outer dimensions) and round magnets. Threads are
 * not modelled (as drawings show them); sizes are the nominal dimensions.
 */
import type { DocOp, Expr, Mechanism, MeercadDocument, StandardPartFeature } from "@meercad/schema";
import { INSERT_SIZES, insertDims, InsertError, insertLabel } from "./holes.js";

export type StandardKind = "socket_screw" | "countersunk_screw" | "hex_screw" | "set_screw" | "hex_nut" | "washer" | "insert" | "bearing" | "magnet" | "profile" | "corner_bracket" | "t_nut" | "linear_bearing" | "shaft" | "lead_screw" | "rail";

/** Kinds sold by length, chosen from SCREW_LENGTHS. */
export const STANDARD_WITH_LENGTH: readonly StandardKind[] = ["socket_screw", "countersunk_screw", "hex_screw", "set_screw"];
/** Kinds cut to any length (profiles, shafts, lead screws, rails): a free length field, default 200 mm. */
export const STANDARD_CUT_TO_LENGTH: readonly StandardKind[] = ["profile", "shaft", "lead_screw", "rail"];
/** Kinds that come with a moving part: a lead screw's nut, a rail's carriage. */
export const STANDARD_WITH_MOVING: readonly StandardKind[] = ["lead_screw", "rail"];
/** Kinds that lie on the face along its u axis (turned by `angle`) instead of standing on it. */
export const STANDARD_LYING: readonly StandardKind[] = ["rail", "corner_bracket"];

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
/** ISO 10642 (90° head, hex socket): head diameter (theoretical maximum), socket key size and depth. */
const COUNTERSUNK: Record<string, { d: number; head: number; key: number; t: number }> = {
  M3: { d: 3, head: 6.72, key: 2, t: 1.1 },
  M4: { d: 4, head: 8.96, key: 2.5, t: 1.5 },
  M5: { d: 5, head: 11.2, key: 3, t: 1.9 },
  M6: { d: 6, head: 13.44, key: 4, t: 2.2 },
  M8: { d: 8, head: 17.92, key: 5, t: 3 },
  M10: { d: 10, head: 22.4, key: 6, t: 3.6 },
  M12: { d: 12, head: 26.88, key: 8, t: 4.3 },
  M16: { d: 16, head: 33.6, key: 10, t: 5.6 },
};
/** ISO 4017: width across flats and height of the hex head. */
const HEX_SCREWS: Record<string, { d: number; s: number; k: number }> = {
  M3: { d: 3, s: 5.5, k: 2 },
  M4: { d: 4, s: 7, k: 2.8 },
  M5: { d: 5, s: 8, k: 3.5 },
  M6: { d: 6, s: 10, k: 4 },
  M8: { d: 8, s: 13, k: 5.3 },
  M10: { d: 10, s: 16, k: 6.4 },
  M12: { d: 12, s: 18, k: 7.5 },
  M16: { d: 16, s: 24, k: 10 },
};
/** ISO 4026 (flat point, hex socket): socket key size and depth. */
const SET_SCREWS: Record<string, { d: number; key: number; t: number }> = {
  M3: { d: 3, key: 1.5, t: 1.2 },
  M4: { d: 4, key: 2, t: 1.5 },
  M5: { d: 5, key: 2.5, t: 2 },
  M6: { d: 6, key: 3, t: 2 },
  M8: { d: 8, key: 4, t: 3 },
  M10: { d: 10, key: 5, t: 4 },
  M12: { d: 12, key: 6, t: 4.8 },
  M16: { d: 16, key: 8, t: 6.4 },
};
/** Standard lengths of screws, mm. */
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

/**
 * Aluminium profiles, slot type B (the common "Nut 6" / "Nut 8" systems), simplified to their
 * outline: square cells with a T-slot in each open side and a centre bore. Size, slot opening,
 * lip thickness, slot cavity width and depth, centre bore.
 */
const PROFILES: Record<string, { w: number; h: number; open: number; lip: number; cavity: number; depth: number; bore: number }> = {
  "2020": { w: 20, h: 20, open: 6.2, lip: 1.8, cavity: 11, depth: 6.1, bore: 4.2 },
  "2040": { w: 40, h: 20, open: 6.2, lip: 1.8, cavity: 11, depth: 6.1, bore: 4.2 },
  "3030": { w: 30, h: 30, open: 8.2, lip: 2.2, cavity: 16.5, depth: 9, bore: 6.8 },
  "4040": { w: 40, h: 40, open: 8.2, lip: 4.3, cavity: 20, depth: 12.2, bore: 6.8 },
};
/** Corner brackets for the profiles: leg length, width, sheet thickness, hole diameter. */
const BRACKETS: Record<string, { leg: number; width: number; t: number; hole: number }> = {
  "2020": { leg: 20, width: 20, t: 3, hole: 5.5 },
  "3030": { leg: 30, width: 30, t: 3.5, hole: 6.6 },
  "4040": { leg: 40, width: 40, t: 4, hole: 8.5 },
};
/** Slide-in T-nuts: thread, then the slot they fit (6 or 8); body width, length, height, neck height. */
const T_NUTS: Record<string, { d: number; w: number; l: number; h: number; neck: number; neckW: number }> = {
  "M3-6": { d: 3, w: 10, l: 10, h: 3.5, neck: 1.8, neckW: 6 },
  "M4-6": { d: 4, w: 10, l: 10, h: 3.5, neck: 1.8, neckW: 6 },
  "M5-6": { d: 5, w: 10, l: 10, h: 3.5, neck: 1.8, neckW: 6 },
  "M4-8": { d: 4, w: 15, l: 15, h: 5, neck: 2.2, neckW: 8 },
  "M5-8": { d: 5, w: 15, l: 15, h: 5, neck: 2.2, neckW: 8 },
  "M6-8": { d: 6, w: 15, l: 15, h: 5, neck: 2.2, neckW: 8 },
};
/** Linear ball bushings: shaft, outside diameter, length. */
const LINEAR_BEARINGS: Record<string, { bore: number; outer: number; length: number }> = {
  LM6UU: { bore: 6, outer: 12, length: 19 },
  LM8UU: { bore: 8, outer: 15, length: 24 },
  LM10UU: { bore: 10, outer: 19, length: 29 },
  LM12UU: { bore: 12, outer: 21, length: 30 },
};
const SHAFTS = ["6", "8", "10", "12", "16"];
/** Trapezoidal lead screws: diameter and lead (travel per turn); their flanged nut: flange Ø, flange thickness, barrel Ø, overall length, mounting holes Ø and pitch circle. */
const LEAD_SCREWS: Record<string, { d: number; lead: number; flange: number; ft: number; barrel: number; nl: number; hole: number; pcd: number }> = {
  Tr8x8: { d: 8, lead: 8, flange: 22, ft: 3.5, barrel: 10.2, nl: 15, hole: 3.5, pcd: 16 },
  Tr8x2: { d: 8, lead: 2, flange: 22, ft: 3.5, barrel: 10.2, nl: 15, hole: 3.5, pcd: 16 },
  Tr10x2: { d: 10, lead: 2, flange: 25, ft: 4, barrel: 14, nl: 20, hole: 4, pcd: 19 },
  Tr12x3: { d: 12, lead: 3, flange: 28, ft: 5, barrel: 16, nl: 22, hole: 4.5, pcd: 22 },
};
/**
 * Miniature linear guides (MGN): rail width and height, mounting hole, counterbore Ø and depth,
 * hole pitch; carriage (type C) width, length, height over the rail's foot and the gap under it.
 */
const RAILS: Record<string, { w: number; h: number; hole: number; cb: number; cbDepth: number; pitch: number; cw: number; cl: number; ch: number; gap: number }> = {
  MGN7: { w: 7, h: 4.8, hole: 2.4, cb: 4.2, cbDepth: 2.3, pitch: 15, cw: 17, cl: 22.5, ch: 8, gap: 1.5 },
  MGN9: { w: 9, h: 6.5, hole: 3.5, cb: 6, cbDepth: 3.3, pitch: 20, cw: 20, cl: 28.9, ch: 10, gap: 2 },
  MGN12: { w: 12, h: 8, hole: 3.5, cb: 6, cbDepth: 4.5, pitch: 25, cw: 27, cl: 34.7, ch: 13, gap: 3 },
  MGN15: { w: 15, h: 10, hole: 3.5, cb: 6, cbDepth: 4.5, pitch: 40, cw: 32, cl: 42.1, ch: 16, gap: 4 },
};

/** Travel per turn of a lead screw size (mm), for coupling its nut to its turning. */
export function leadOf(size: string | undefined): number | undefined {
  return size ? LEAD_SCREWS[size]?.lead : undefined;
}

export const STANDARD_SIZES: Record<StandardKind, readonly string[]> = {
  socket_screw: Object.keys(SCREWS),
  countersunk_screw: Object.keys(COUNTERSUNK),
  hex_screw: Object.keys(HEX_SCREWS),
  set_screw: Object.keys(SET_SCREWS),
  insert: INSERT_SIZES,
  hex_nut: Object.keys(NUTS),
  washer: Object.keys(WASHERS),
  bearing: Object.keys(BEARINGS),
  magnet: [],
  profile: Object.keys(PROFILES),
  corner_bracket: Object.keys(BRACKETS),
  t_nut: Object.keys(T_NUTS),
  linear_bearing: Object.keys(LINEAR_BEARINGS),
  shaft: SHAFTS,
  lead_screw: Object.keys(LEAD_SCREWS),
  rail: Object.keys(RAILS),
};

/** The size a kind starts with in the dialog. */
export const STANDARD_DEFAULT_SIZE: Record<StandardKind, string | undefined> = {
  socket_screw: "M3", countersunk_screw: "M3", hex_screw: "M3", set_screw: "M3", hex_nut: "M3", washer: "M3", insert: "M3",
  bearing: "608", magnet: undefined, profile: "2020", corner_bracket: "2020", t_nut: "M5-6", linear_bearing: "LM8UU", shaft: "8", lead_screw: "Tr8x8", rail: "MGN12",
};

export const STANDARD_NAMES: Record<StandardKind, string> = {
  socket_screw: "Socket head cap screw ISO 4762",
  countersunk_screw: "Countersunk screw ISO 10642",
  hex_screw: "Hex head screw ISO 4017",
  set_screw: "Set screw ISO 4026",
  hex_nut: "Hex nut ISO 4032",
  washer: "Washer ISO 7089",
  insert: "Heat-set insert",
  bearing: "Ball bearing",
  magnet: "Round magnet",
  profile: "Aluminium profile",
  corner_bracket: "Corner bracket",
  t_nut: "T-nut",
  linear_bearing: "Linear bearing",
  shaft: "Precision shaft",
  lead_screw: "Lead screw",
  rail: "Linear guide rail",
};

/** The part as stacked rings about its axis, from where it stands (0) outwards: what the kernel turns into a solid. */
export interface StandardShape {
  /**
   * Turned sections: outer radius (`r2` at `to` for a cone), inner (hole) radius, from and to along
   * the axis (negative goes into the material), and what its outside is called (np1.head, …).
   */
  rings: { r: number; r2?: number; hole: number; from: number; to: number; role?: string }[];
  /** A hexagonal outline instead of round for the ring at this index (nuts): width across flats. */
  hex?: { ring: number; across: number };
  /** A hex socket cut into the top: key size and depth (screws). */
  socket?: { key: number; depth: number; top: number };
  /**
   * Straight sections from an outline (x, y), with cut-outs: along the axis (x on the plane's u,
   * y on v), or lying along u (x on v, y up the axis) from `from` to `to`.
   */
  prisms?: { outline: [number, number][]; cuts?: ({ poly: [number, number][] } | { circle: [number, number, number] })[]; along: "axis" | "u"; from: number; to: number; role?: string }[];
  /** Round holes drilled from a point (u, v, up the axis) in a direction, with an optional counterbore. */
  drills?: { at: [number, number, number]; dir: [number, number, number]; r: number; depth: number; cb?: { r: number; depth: number } }[];
  /** A second part that moves on this one (a rail's carriage, a lead screw's nut). */
  moving?: { suffix: string; label: string; shape: Omit<StandardShape, "moving"> };
  /** Label for the parts list, e.g. "M3×12 ISO 4762". */
  label: string;
  /** The label as a text to translate with its values, for labels with words in them. */
  labelText?: { text: string; values: Record<string, string | number> };
}

export class StandardPartError extends Error {}

/** The thread inside an insert, as the model shows it: the nominal diameter's radius. */
const insertBore = (size: string): number => Number(size.slice(1)) / 2;

const rect = (w: number, l: number): [number, number][] => [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]];

export function standardShape(kind: StandardKind, o: { size?: string | undefined; length?: number | undefined; diameter?: number | undefined; height?: number | undefined; moving?: boolean | undefined }): StandardShape {
  const need = <T,>(table: Record<string, T>): T => {
    const row = o.size ? table[o.size] : undefined;
    if (!row) throw new StandardPartError(`unknown size "${o.size ?? ""}": use one of ${Object.keys(table).join(", ")}`);
    return row;
  };
  const cut = (fallback: number) => {
    const L = o.length ?? fallback;
    if (!(L > 0)) throw new StandardPartError("the length must be greater than zero");
    return L;
  };
  const length = () => {
    const L = o.length ?? 10;
    if (!(L > 0)) throw new StandardPartError("the screw's length must be greater than zero");
    return L;
  };
  switch (kind) {
    case "socket_screw": {
      const s = need(SCREWS);
      const L = length();
      // The head stands on the face, the shank goes in; the length is the shank's, as screws are sold.
      return { rings: [{ r: s.head / 2, hole: 0, from: 0, to: s.k, role: "head" }, { r: s.d / 2, hole: 0, from: -L, to: 0, role: "shank" }], socket: { key: s.key, depth: s.t, top: s.k }, label: `${o.size}×${L} ISO 4762` };
    }
    case "countersunk_screw": {
      const s = need(COUNTERSUNK);
      const L = length();
      // Sunk flush into the face; the length counts the head, as countersunk screws are sold.
      const k = (s.head - s.d) / 2;
      if (L <= k) throw new StandardPartError(`an ${o.size} countersunk screw is at least ${Math.ceil(k * 10) / 10} mm long`);
      return { rings: [{ r: s.d / 2, r2: s.head / 2, hole: 0, from: -k, to: 0, role: "head" }, { r: s.d / 2, hole: 0, from: -L, to: -k, role: "shank" }], socket: { key: s.key, depth: s.t, top: 0 }, label: `${o.size}×${L} ISO 10642` };
    }
    case "hex_screw": {
      const s = need(HEX_SCREWS);
      const L = length();
      return { rings: [{ r: s.s / Math.sqrt(3), hole: 0, from: 0, to: s.k, role: "head" }, { r: s.d / 2, hole: 0, from: -L, to: 0, role: "shank" }], hex: { ring: 0, across: s.s }, label: `${o.size}×${L} ISO 4017` };
    }
    case "set_screw": {
      const s = need(SET_SCREWS);
      const L = length();
      // In the hole, flush with the face.
      return { rings: [{ r: s.d / 2, hole: 0, from: -L, to: 0 }], socket: { key: s.key, depth: Math.min(s.t, L * 0.8), top: 0 }, label: `${o.size}×${L} ISO 4026` };
    }
    case "insert": {
      let ins;
      try {
        ins = o.size ? insertDims(o.size, o.length) : undefined;
      } catch (e) {
        if (e instanceof InsertError) throw new StandardPartError(e.message);
        // insertDims throws InsertError only: anything else is a bug and goes on as it is.
        /* v8 ignore next */
        throw e;
      }
      if (!ins) throw new StandardPartError(`unknown size "${o.size ?? ""}": use one of ${INSERT_SIZES.join(", ")}`);
      // Melted into its hole, flush with the face: as wide as the hole, so it does not collide with the part.
      return { rings: [{ r: ins.hole / 2, hole: insertBore(ins.size), from: -ins.length, to: 0 }], label: insertLabel(ins), labelText: { text: "{size}×{length} heat-set insert", values: { size: ins.size, length: ins.length } } };
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
    case "profile": {
      const p = need(PROFILES);
      const L = cut(200);
      // Each 20/30/40 cell gets a slot in every outside face and a centre bore.
      const cells = Math.round(p.w / p.h);
      const cuts: ({ poly: [number, number][] } | { circle: [number, number, number] })[] = [];
      const slot = (cx: number, cy: number, nx: number, ny: number) => {
        // A T: the opening through the lip, then the wider cavity, pointing inwards from (cx, cy).
        const tx = -ny, ty = nx;
        const q = (a: number, b: number): [number, number] => [cx - nx * b + tx * a, cy - ny * b + ty * a];
        cuts.push({ poly: [q(-p.open / 2, -0.1), q(p.open / 2, -0.1), q(p.open / 2, p.lip), q(-p.open / 2, p.lip)] });
        cuts.push({ poly: [q(-p.cavity / 2, p.lip), q(p.cavity / 2, p.lip), q(p.open / 2, p.depth), q(-p.open / 2, p.depth)] });
      };
      for (let k = 0; k < cells; k++) {
        const cx = -p.w / 2 + p.h / 2 + k * p.h;
        cuts.push({ circle: [cx, 0, p.bore / 2] });
        slot(cx, p.h / 2, 0, 1);
        slot(cx, -p.h / 2, 0, -1);
      }
      slot(p.w / 2, 0, 1, 0);
      slot(-p.w / 2, 0, -1, 0);
      const outline: [number, number][] = [[-p.w / 2, -p.h / 2], [p.w / 2, -p.h / 2], [p.w / 2, p.h / 2], [-p.w / 2, p.h / 2]];
      return { rings: [], prisms: [{ outline, cuts, along: "axis", from: 0, to: L, role: "side" }], label: `${o.size} profile × ${L}`, labelText: { text: "{size} profile × {length}", values: { size: o.size!, length: L } } };
    }
    case "corner_bracket": {
      const b = need(BRACKETS);
      // An L lying along u: one leg on the face, one standing up at x = 0, each with a hole.
      const outline: [number, number][] = [[0, 0], [b.leg, 0], [b.leg, b.t], [b.t, b.t], [b.t, b.leg], [0, b.leg]];
      return {
        rings: [],
        prisms: [{ outline, along: "u", from: -b.width / 2, to: b.width / 2, role: "side" }],
        drills: [
          { at: [0, (b.leg + b.t) / 2, -1], dir: [0, 0, 1], r: b.hole / 2, depth: b.t + 2 },
          { at: [0, -1, (b.leg + b.t) / 2], dir: [0, 1, 0], r: b.hole / 2, depth: b.t + 2 },
        ],
        label: `Corner bracket ${o.size}`,
        labelText: { text: "Corner bracket {size}", values: { size: o.size! } },
      };
    }
    case "t_nut": {
      const n = need(T_NUTS);
      // In the slot under the face: the neck through the lip, the body in the cavity.
      return {
        rings: [],
        prisms: [
          { outline: rect(n.neckW - 0.4, n.l), along: "axis", from: -n.neck, to: 0, role: "neck" },
          { outline: rect(n.w, n.l), along: "axis", from: -n.neck - n.h, to: -n.neck, role: "side" },
        ],
        drills: [{ at: [0, 0, 1], dir: [0, 0, -1], r: n.d / 2, depth: n.neck + n.h + 2 }],
        label: `T-nut ${o.size}`,
        labelText: { text: "T-nut {size}", values: { size: o.size! } },
      };
    }
    case "linear_bearing": {
      const b = need(LINEAR_BEARINGS);
      return { rings: [{ r: b.outer / 2, hole: b.bore / 2, from: 0, to: b.length }], label: `${o.size} ${b.bore}×${b.outer}×${b.length}` };
    }
    case "shaft": {
      const d = Number(o.size);
      if (!SHAFTS.includes(o.size ?? "")) throw new StandardPartError(`unknown size "${o.size ?? ""}": use one of ${SHAFTS.join(", ")}`);
      const L = cut(200);
      return { rings: [{ r: d / 2, hole: 0, from: 0, to: L, role: "rod" }], label: `Shaft Ø${d} × ${L}`, labelText: { text: "Shaft Ø{d} × {length}", values: { d, length: L } } };
    }
    case "lead_screw": {
      const s = need(LEAD_SCREWS);
      const L = cut(200);
      const nut: Omit<StandardShape, "moving"> = {
        rings: [{ r: s.flange / 2, hole: s.d / 2, from: 0, to: s.ft, role: "flange" }, { r: s.barrel / 2, hole: s.d / 2, from: s.ft, to: s.nl, role: "barrel" }],
        drills: [0, 90, 180, 270].map((deg) => ({ at: [(s.pcd / 2) * Math.cos((deg * Math.PI) / 180), (s.pcd / 2) * Math.sin((deg * Math.PI) / 180), -1] as [number, number, number], dir: [0, 0, 1] as [number, number, number], r: s.hole / 2, depth: s.ft + 2 })),
        label: `${o.size} nut`,
        labelText: { text: "{size} nut", values: { size: o.size! } },
      };
      return { rings: [{ r: s.d / 2, hole: 0, from: 0, to: L, role: "rod" }], label: `${o.size} lead screw × ${L}`, labelText: { text: "{size} lead screw × {length}", values: { size: o.size!, length: L } }, ...(o.moving ? { moving: { suffix: "nut", label: `${o.size} nut`, shape: nut } } : {}) };
    }
    case "rail": {
      const r = need(RAILS);
      const L = cut(200);
      // The rail lies on the face along u, with a groove in each side for the balls.
      const g = Math.min(1, r.w * 0.08);
      const outline: [number, number][] = [[-r.w / 2, 0], [r.w / 2, 0], [r.w / 2, r.h * 0.55], [r.w / 2 - g, r.h * 0.62], [r.w / 2 - g, r.h * 0.72], [r.w / 2, r.h * 0.8], [r.w / 2, r.h], [-r.w / 2, r.h], [-r.w / 2, r.h * 0.8], [-r.w / 2 + g, r.h * 0.72], [-r.w / 2 + g, r.h * 0.62], [-r.w / 2, r.h * 0.55]];
      const holes: NonNullable<StandardShape["drills"]> = [];
      // Holes at the hole pitch, the ends equally far from the first and last one.
      const n = Math.max(1, Math.floor((L - 2 * Math.min(r.pitch / 2, 10)) / r.pitch) + 1);
      const start = (L - (n - 1) * r.pitch) / 2;
      for (let k = 0; k < n; k++) holes.push({ at: [start + k * r.pitch, 0, r.h + 1], dir: [0, 0, -1], r: r.hole / 2, depth: r.h + 2, cb: { r: r.cb / 2, depth: r.cbDepth + 1 } });
      const carriage: Omit<StandardShape, "moving"> = {
        rings: [],
        prisms: [{ outline: [[-r.cw / 2, r.gap], [-r.w / 2 - 0.3, r.gap], [-r.w / 2 - 0.3, r.h + 0.3], [r.w / 2 + 0.3, r.h + 0.3], [r.w / 2 + 0.3, r.gap], [r.cw / 2, r.gap], [r.cw / 2, r.ch], [-r.cw / 2, r.ch]], along: "u", from: 0, to: r.cl, role: "side" }],
        label: `${o.size}C carriage`,
        labelText: { text: "{size}C carriage", values: { size: o.size! } },
      };
      return { rings: [], prisms: [{ outline, along: "u", from: 0, to: L, role: "side" }], drills: holes, label: `${o.size} rail × ${L}`, labelText: { text: "{size} rail × {length}", values: { size: o.size!, length: L } }, ...(o.moving ? { moving: { suffix: "carriage", label: `${o.size}C carriage`, shape: carriage } } : {}) };
    }
    case "magnet": {
      const d = o.diameter ?? 6, h = o.height ?? 3;
      if (!(d > 0) || !(h > 0)) throw new StandardPartError("the magnet needs a diameter and a height greater than zero");
      return { rings: [{ r: d / 2, hole: 0, from: 0, to: h }], label: `Magnet ${d}×${h}` };
    }
  }
}

/**
 * The joints that make a rail's carriage and a lead screw's nut move, for each placed part: the
 * carriage slides on its rail; the screw turns and its nut slides along it, coupled by the lead.
 * Joints of these parts the feature no longer makes (moving part off, fewer places) are deleted.
 */
export function standardMotionOps(f: StandardPartFeature, mech: Mechanism | undefined): DocOp[] {
  const ids = f.points.map((_, k) => (k === 0 ? f.id : `${f.id}_${k + 1}`));
  const want = new Set<string>();
  const ops: DocOp[] = [];
  const len: Expr = f.length ?? 200;
  const span = (minus: number): Expr => (typeof len === "number" ? +(len - minus).toFixed(3) : `(${len}) - ${minus} mm`);
  if (f.withMoving && f.kind === "rail" && f.size && RAILS[f.size]) {
    const r = RAILS[f.size]!;
    for (const id of ids) {
      const jid = `j_${id}_carriage`;
      want.add(jid);
      ops.push({ type: "set_joint", joint: { id: jid, name: `${f.size} carriage`, type: "slider", a: `${id}_carriage`, b: id, anchor: { edge: { edge: [`${id}.top`, `${id}.right`] } }, limits: [0, span(r.cl)] } });
    }
  }
  if (f.withMoving && f.kind === "lead_screw" && f.size && LEAD_SCREWS[f.size]) {
    const s = LEAD_SCREWS[f.size]!;
    for (const id of ids) {
      const screw = `j_${id}`, nut = `j_${id}_nut`;
      want.add(screw).add(nut);
      const axis = { axisOf: { face: `${id}.rod` } };
      ops.push({ type: "set_joint", joint: { id: screw, name: `${f.size} turning`, type: "revolute", a: id, b: "ground", anchor: axis } });
      ops.push({ type: "set_joint", joint: { id: nut, name: `${f.size} nut`, type: "slider", a: `${id}_nut`, b: "ground", anchor: axis, limits: [0, span(s.nl)] } });
      // One turn moves the nut by the lead: mm per degree.
      ops.push({ type: "set_coupling", coupling: { id: `c_${id}_nut`, driver: screw, driven: nut, ratio: s.lead / 360 } });
    }
  }
  // Joints this feature made before but no longer needs.
  const mine = (j: string) => j === `j_${f.id}` || j.startsWith(`j_${f.id}_`);
  // Couplings first: deleting a joint takes its couplings with it.
  for (const c of mech?.couplings ?? []) if (c.id.startsWith(`c_${f.id}`) && !want.has(c.driven)) ops.push({ type: "delete_coupling", id: c.id });
  for (const j of mech?.joints ?? []) if (mine(j.id) && !want.has(j.id)) ops.push({ type: "delete_joint", id: j.id });
  return ops;
}

/** The ops plus the joints for every rail or lead screw they add or change (see standardMotionOps). */
export function withMotion(ops: DocOp[], doc: MeercadDocument): DocOp[] {
  const out = [...ops];
  for (const op of ops) {
    const fs = op.type === "add_features" ? op.features : op.type === "edit_feature" ? [{ ...(doc.features.find((f) => f.id === op.id) ?? {}), ...op.patch }] : [];
    for (const f of fs as { op?: string }[]) {
      if (f.op !== "standard_part") continue;
      const sp = Object.fromEntries(Object.entries(f).filter(([, v]) => v !== null)) as unknown as StandardPartFeature;
      if (sp.kind === "rail" || sp.kind === "lead_screw" || doc.mechanism?.joints.some((j) => j.id.startsWith(`j_${sp.id}`))) out.push(...standardMotionOps(sp, doc.mechanism));
    }
  }
  return out;
}
