/**
 * Wall storage built as solids: openGrid boards and snaps, pegboards and pegs, and the holders
 * on them (hooks, rings, shelves, Gridfinity shelves).
 *
 * Everything is built in a local frame: x across, y up the wall, z out of it. A board's back is
 * at z = 0; a holder's z = 0 is the board's front, its snaps or pegs reaching back into the board
 * and its plate and accessory standing out in front. Faces are named there by where they lie.
 */

import { FeatureError, GRIDFINITY, OPENGRID, WALL, WallError, binShelfCells, octagon, openGridOpening, pegboard, type ResolvedWall } from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { Builder } from "./gridfinity.js";
import type { OC } from "./occt.js";

/** A built board as later holders see it. */
export interface WallRecord {
  frame: PlaneFrame;
  /** Centre of the board in plane coordinates. */
  position: [number, number];
  units: [number, number];
  system: "opengrid" | "pegboard";
  pitch: number;
  /** Board thickness (its front above the plane). */
  thickness: number;
  variant: "full" | "lite";
  /** Pegboard holes: size and shape. */
  hole: number;
  square: boolean;
}

const checked = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof WallError) throw new FeatureError(e.message);
    throw e;
  }
};

export function wallBody(oc: OC, arena: Arena, f: ResolvedWall, frame: PlaneFrame, board: WallRecord | undefined, warnings: string[]): { body: Body; record?: WallRecord } {
  return checked(() => (f.kind === "board" ? boardBody(oc, arena, f, frame) : { body: holderBody(oc, arena, f, frame, board, warnings) }));
}

/** Sizes of a feature's system: grid pitch, board thickness, holes. */
function sizes(f: ResolvedWall, board: WallRecord | undefined) {
  if (board) return board;
  if (f.system === "opengrid") {
    const variant = f.variant ?? "full";
    return { pitch: OPENGRID.pitch, thickness: variant === "lite" ? OPENGRID.lite : OPENGRID.full, variant, hole: 0, square: false };
  }
  const p = pegboard(f.grid, f.pitch, f.hole, f.thickness);
  if (!(p.pitch >= 8 && p.pitch <= 100)) throw new FeatureError("the pitch must be between 8 and 100 mm");
  if (!(p.hole >= 2 && p.hole <= p.pitch - 2)) throw new FeatureError(`the holes must be between 2 and ${p.pitch - 2} mm`);
  if (!(p.thickness >= 0.5 && p.thickness <= 30)) throw new FeatureError("the board must be between 0.5 and 30 mm thick");
  return { ...p, variant: "full" as const };
}

const cellCentres = (nx: number, ny: number, pitch: number): [number, number, number, number][] => {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) out.push([i, j, (i - (nx - 1) / 2) * pitch, (j - (ny - 1) / 2) * pitch]);
  return out;
};

// ---------------------------------------------------------------- board

function boardBody(oc: OC, arena: Arena, f: ResolvedWall, frame: PlaneFrame): { body: Body; record: WallRecord } {
  const b = new Builder(oc, arena);
  const s = sizes(f, undefined);
  const [nx, ny] = f.units;
  const W = nx * s.pitch, H = ny * s.pitch, T = s.thickness;
  const cuts: TopoDS_Shape[] = [];
  const holes: [number, number, number][] = [];
  let shape: TopoDS_Shape;
  if (f.system === "opengrid") {
    shape = b.block(0, 0, W, H, 0, 0, T);
    // One opening, copied to every cell; its ends carried a hair past the faces for clean cuts.
    const sections = openGridOpening(s.variant);
    const first = sections[0]!, last = sections[sections.length - 1]!;
    const opening = b.polyLoft([{ z: -0.05, loop: first.loop }, ...sections, { z: T + 0.05, loop: last.loop }]);
    for (const [, , cx, cy] of cellCentres(nx, ny, s.pitch)) cuts.push(b.moved(opening, cx, cy, 0));
    // The outside corners cut off.
    const c = OPENGRID.cornerCut;
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const x = (sx * W) / 2, y = (sy * H) / 2;
        const loop: [number, number][] = [[x + sx * 0.1, y + sy * 0.1], [x - sx * (c + 0.1), y + sy * 0.1], [x + sx * 0.1, y - sy * (c + 0.1)]];
        if (sx * sy < 0) loop.reverse();
        const face = b.polyFace(loop, [], -0.1);
        if (face) cuts.push(b.prismZ(face, T + 0.2));
      }
    if (f.screws) {
      if (nx < 2 || ny < 2) throw new FeatureError("screw holes sit at crossings inside the board: it needs at least 2 × 2 cells");
      const seen = new Set<string>();
      const rs = OPENGRID.screwDiameter / 2, rh = OPENGRID.screwHead / 2;
      const zh = T - OPENGRID.screwInset;
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          const x = sx * (W / 2 - s.pitch), y = sy * (H / 2 - s.pitch);
          const key = `${x.toFixed(3)},${y.toFixed(3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          cuts.push(b.cylinderZ(x, y, rs, -1, T + 1), b.cylinderZ(x, y, rh, zh, T + 1), b.coneZ(x, y, rs, rh, zh - (rh - rs), zh));
          holes.push([x, y, rh]);
        }
    }
  } else {
    shape = b.block(0, 0, W, H, Math.min(3, s.pitch / 4), 0, T);
    for (const [, , cx, cy] of cellCentres(nx, ny, s.pitch)) {
      cuts.push(s.square ? b.block(cx, cy, s.hole, s.hole, 0, -1, T + 1) : b.cylinderZ(cx, cy, s.hole / 2, -1, T + 1));
      holes.push([cx, cy, s.square ? (s.hole / 2) * Math.SQRT2 : s.hole / 2]);
    }
  }
  shape = b.unify(b.bool("cut", shape, cuts));
  const local = new Body(oc, arena, f.id, shape);
  const name = (p: string) => [`${f.id}.${p}`];
  const outline = (p: Vec3) => Math.abs(Math.abs(p[0]) - W / 2) < 1e-3 || Math.abs(Math.abs(p[1]) - H / 2) < 1e-3;
  local.faceTags = local.faces.map((_, i) => {
    const p = local.facePoints[i]!;
    const n = local.faceInfo[i]!.normal;
    if (n && n[2] < -0.99 && Math.abs(p[2]) < 1e-6) return name("back");
    if (n && n[2] > 0.99 && Math.abs(p[2] - T) < 1e-6) return name("front");
    if (holes.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r + 1e-3) && f.system === "opengrid") return name("hole");
    const c = OPENGRID.cornerCut;
    const corner = f.system === "opengrid" && Math.abs(Math.abs(p[0]) + Math.abs(p[1]) - ((W + H) / 2 - c)) < 1e-3 && Math.abs(p[0]) > W / 2 - c - 1e-3 && Math.abs(p[1]) > H / 2 - c - 1e-3;
    if (outline(p) || corner) return name("side");
    return name(f.system === "opengrid" ? "opening" : "hole");
  });
  const body = b.place(local, b.placement(frame, f.position), f.id);
  return { body, record: { frame, position: f.position, units: [nx, ny], system: f.system, pitch: s.pitch, thickness: T, variant: s.variant, hole: s.hole, square: s.square } };
}

// ---------------------------------------------------------------- holder

/** Cells that get a snap or a pair of pegs: the four corners of the holder's footprint. */
function anchorCells(nx: number, ny: number): [number, number][] {
  const out = new Map<string, [number, number]>();
  for (const i of [0, nx - 1]) for (const j of [0, ny - 1]) out.set(`${i},${j}`, [i, j]);
  return [...out.values()];
}

/** One openGrid snap centred on (cx, cy), its front at z = 0 and `depth` deep. */
function snap(b: Builder, cx: number, cy: number, depth: number, top: number): TopoDS_Shape {
  const a = OPENGRID.snap / 2;
  const core = octagon(a, a - OPENGRID.snapCorner), front = octagon(a, a - OPENGRID.snapFrontCorner);
  const at = (loop: [number, number][]) => loop.map(([x, y]) => [x + cx, y + cy] as [number, number]);
  // The corners follow the board's nodes: cut back at the front 0.4 mm, then 45° out to the core.
  let shape = b.polyLoft([
    { z: -depth, loop: at(core) },
    { z: -1.4, loop: at(core) },
    { z: -0.4, loop: at(front) },
    { z: top, loop: at(front) },
  ]);
  // The catches sit as deep in both kinds of snap: in the lite board's back half.
  const zb = -OPENGRID.snapLite;
  // A catch on each side and, behind it, a slot that turns the side into a spring.
  const h = OPENGRID.nubHeight, L = OPENGRID.nubLength / 2;
  const prof = (o: number) => [[o - 0.3 * Math.sign(o), zb + 0.2], [o, zb + 0.2], [o + h * Math.sign(o), zb + 0.8], [o + h * Math.sign(o), zb + 1.4], [o, zb + 2], [o - 0.3 * Math.sign(o), zb + 2]] as [number, number][];
  const nubs: TopoDS_Shape[] = [];
  const slots: TopoDS_Shape[] = [];
  const si = OPENGRID.slotInset, sw = OPENGRID.slotWidth, sl = OPENGRID.slotLength;
  for (const sgn of [-1, 1]) {
    const o = sgn * a;
    const px = prof(o).map(([u, z]) => [u + cx, z] as [number, number]);
    nubs.push(b.prismY(sgn > 0 ? px.slice().reverse() : px, cy - L, cy + L));
    const py = prof(o).map(([u, z]) => [u + cy, z] as [number, number]);
    nubs.push(b.prismX(sgn > 0 ? py : py.slice().reverse(), cx - L, cx + L));
    const mid = sgn * (a - si);
    slots.push(b.block(cx + mid, cy, sw, sl, 0, -depth - 1, zb + 2.8), b.block(cx, cy + mid, sl, sw, 0, -depth - 1, zb + 2.8));
    // The spring's top freed from the core above the catch.
    slots.push(b.block(cx + sgn * (a - 0.35 + 0.5), cy, 1.7, sl - 0.4, 0, zb + 2.2, zb + 2.6), b.block(cx, cy + sgn * (a - 0.35 + 0.5), sl - 0.4, 1.7, 0, zb + 2.2, zb + 2.6));
  }
  shape = b.bool("fuse", shape, nubs);
  return b.bool("cut", shape, slots);
}

function holderBody(oc: OC, arena: Arena, f: ResolvedWall, frame0: PlaneFrame, board: WallRecord | undefined, warnings: string[]): Body {
  const b = new Builder(oc, arena);
  const s = sizes(f, board);
  const [nx, ny] = f.units;
  const acc = f.accessory ?? "hook";
  if (acc === "screw" && f.system !== "opengrid") throw new FeatureError("the screw snap is for openGrid boards");
  const W = nx * s.pitch - WALL.plateGap, H = ny * s.pitch - WALL.plateGap;
  const p = acc === "screw" ? 0 : (f.plate ?? WALL.plate);
  if (acc !== "screw" && !(p >= 1 && p <= 20)) throw new FeatureError("the plate must be between 1 and 20 mm thick");
  const Y0 = -H / 2;
  const adds: TopoDS_Shape[] = [];
  const cuts: TopoDS_Shape[] = [];
  const regions: { tag: string; test: (q: Vec3) => boolean }[] = [];
  let back = 0; // how far the snaps or pegs reach behind the board's front

  // Snaps or pegs.
  if (f.system === "opengrid") {
    const lite = s.variant === "lite";
    back = lite ? OPENGRID.snapLite : OPENGRID.full;
    const cells = acc === "screw" ? cellCentres(nx, ny, s.pitch) : anchorCells(nx, ny).map(([i, j]) => [i, j, (i - (nx - 1) / 2) * s.pitch, (j - (ny - 1) / 2) * s.pitch] as const);
    for (const [, , cx, cy] of cells) {
      adds.push(snap(b, cx, cy, back, acc === "screw" ? 0 : 0.05));
      if (acc === "screw") {
        const d = f.size ?? WALL.screw;
        if (!(d >= 2 && d <= 8)) throw new FeatureError("the screw hole must be between 2 and 8 mm");
        const r = d / 2, rh = Math.min(d * 0.9, 5.5);
        cuts.push(b.cylinderZ(cx, cy, r, -back - 1, 1), b.coneZ(cx, cy, r, rh + 0.5, -(rh - r) , 0.5));
      }
    }
    if (acc === "screw") {
      const rh = Math.min((f.size ?? WALL.screw) * 0.9, 5.5) + 0.5;
      regions.push({ tag: "hole", test: (q) => cells.some(([, , cx, cy]) => Math.hypot(q[0] - cx, q[1] - cy) < rh + 1e-3) && Math.abs(q[2]) > 1e-6 });
    }
    regions.push({ tag: "snap", test: (q) => q[2] < 1e-3 });
  } else {
    const T = s.thickness;
    const d = s.hole - WALL.pegPlay;
    back = T + 0.4 + d;
    const tip = s.hole + 1;
    for (const [i, j] of anchorCells(nx, ny)) {
      const cx = (i - (nx - 1) / 2) * s.pitch, cy = (j - (ny - 1) / 2) * s.pitch;
      const top = j === ny - 1;
      const z0 = top ? -back : -T;
      adds.push(s.square ? b.block(cx, cy, d, d, 0, z0, 0.05) : b.cylinderZ(cx, cy, d / 2, z0, 0.05));
      // The top row hooks up behind the board.
      if (top) adds.push(s.square ? b.block(cx, cy + tip / 2, d, tip, 0, -back, -back + d) : b.cylinderY(cx, -back + d / 2, d / 2, cy, cy + tip - d / 2));
    }
    regions.push({ tag: "peg", test: (q) => q[2] < 1e-3 });
  }

  // The back plate.
  if (p > 0) adds.push(b.block(0, 0, W, H, Math.min(2, W / 4, H / 4), 0, p));
  regions.push({ tag: "plate", test: (q) => q[2] <= p + 1e-3 });

  // The accessory in front.
  const bottom = Y0 + Math.min(2, H / 8);
  if (acc === "hook") {
    const depth = f.depth ?? WALL.hookDepth, rise = f.size ?? WALL.hookRise;
    const aw = Math.min(10, W - 2), ah = Math.min(6, H - 2);
    if (!(depth >= ah + 2 && depth <= 300)) throw new FeatureError(`the hook must reach between ${ah + 2} and 300 mm`);
    if (!(rise >= 0 && rise <= 100)) throw new FeatureError("the hook's tip must rise between 0 and 100 mm");
    const gs = Math.max(0, Math.min(8, depth - ah - 2, H - (bottom - Y0) - ah - 1));
    const y0 = bottom, y1 = bottom + ah;
    const prof: [number, number][] = [[y0, p - 0.05], [y0, p + depth], [y1 + rise, p + depth], [y1 + rise, p + depth - ah], [y1, p + depth - ah]];
    if (gs > 0.5) prof.push([y1, p + gs], [y1 + gs, p - 0.05]);
    else prof.push([y1, p - 0.05]);
    adds.push(b.prismX(prof.slice().reverse(), -aw / 2, aw / 2));
    regions.push({ tag: "hook", test: () => true });
  } else if (acc === "ring") {
    const di = f.size ?? WALL.ringDiameter, gap = f.depth ?? WALL.ringDepth;
    if (!(di >= 3 && di <= 200)) throw new FeatureError("the ring must be between 3 and 200 mm across");
    if (!(gap >= 0 && gap <= 200)) throw new FeatureError("the ring must stand between 0 and 200 mm off the plate");
    const t = Math.max(2.5, Math.min(5, di * 0.15)), ri = di / 2, ro = ri + t;
    const zc = p + gap + ro, rh = Math.min(10, H - 2);
    const y0 = bottom, y1 = bottom + rh;
    adds.push(b.bool("cut", b.bool("fuse", b.cylinderY(0, zc, ro, y0, y1), [b.block(0, (y0 + y1) / 2, Math.min(2 * ro, W - 2), rh, 0, p - 0.05, zc)]), [b.cylinderY(0, zc, ri, y0 - 1, y1 + 1)]));
    regions.push({ tag: "ring", test: () => true });
  } else if (acc === "shelf" || acc === "bin") {
    const sides = (w: number, depth: number, top: number) => {
      // Side walls from the plate's top down to the front.
      const prof: [number, number][] = [[Y0, p - 0.05], [Y0 + H, p - 0.05], [Y0 + top, p + depth], [Y0, p + depth]];
      for (const sx of [-1, 1]) adds.push(b.prismX(prof.slice().reverse(), sx > 0 ? w / 2 - 2 : -w / 2, sx > 0 ? w / 2 : -w / 2 + 2));
    };
    if (acc === "shelf") {
      const depth = f.depth ?? WALL.shelfDepth, lip = f.size ?? WALL.shelfLip;
      if (!(depth >= 10 && depth <= 300)) throw new FeatureError("the shelf must be between 10 and 300 mm deep");
      if (!(lip >= 0 && lip <= 100)) throw new FeatureError("the shelf's lip must be between 0 and 100 mm");
      const ft = 3;
      adds.push(b.block(0, Y0 + ft / 2, W, ft, 0, p - 0.05, p + depth));
      if (lip > 0) adds.push(b.block(0, Y0 + (ft + lip) / 2, W, ft + lip, 0, p + depth - 2, p + depth));
      sides(W, depth, Math.max(ft + lip, ft + 1));
    } else {
      const n = Math.round(f.size ?? WALL.bins);
      if (!(n >= 1 && n <= 10)) throw new FeatureError("the shelf holds between 1 and 10 bins");
      const G = GRIDFINITY;
      const Wb = n * G.pitch + 3, Db = G.pitch + 3, fl = 1.5, top = fl + G.pocketHeight;
      if (Wb > W + 1e-6) throw new FeatureError(`${n} bin${n > 1 ? "s need" : " needs"} a holder at least ${binShelfCells(n, s.pitch)} cells wide`);
      // A small baseplate built lying down (pockets up, depth along −y), then stood against the plate.
      let shelf = b.block(0, -Db / 2, Wb, Db, G.plateRadius, 0, top);
      const prof: [number, number][] = G.pocket.map(([z, d]) => [fl + z, d] as [number, number]);
      prof.push([top + 0.5, -0.5]);
      const pockets = Array.from({ length: n }, (_, k) => b.profileSolid((k - (n - 1) / 2) * G.pitch, -Db / 2, G.pitch, G.pitch, G.plateRadius, prof));
      shelf = b.bool("cut", shelf, pockets);
      adds.push(b.turnedX(shelf, -90, Y0, p - 0.05));
      sides(Wb, Db, top);
    }
    regions.push({ tag: "shelf", test: () => true });
  }
  regions.push({ tag: "plate", test: () => true });

  let shape = adds[0]!;
  shape = b.bool("fuse", shape, adds.slice(1));
  if (cuts.length) shape = b.bool("cut", shape, cuts);
  shape = b.unify(shape);
  const local = new Body(oc, arena, f.id, shape);
  local.faceTags = local.faces.map((_, i) => {
    const q = local.facePoints[i]!;
    const r = regions.find((x) => x.test(q))!;
    return [`${f.id}.${r.tag}`];
  });

  // Placement: on a board's cell, or free on the plane with its back on it.
  let frame = frame0;
  let position = f.position;
  if (board) {
    const [bx, by] = board.units;
    const [ci, cj] = f.cell;
    if (ci + nx > bx || cj + ny > by) warnings.push(`the holder reaches past the board (${bx}×${by} cells)`);
    frame = { ...board.frame, origin: toWorld(board.frame, [0, 0]).map((v, k) => v + board.frame.normal[k]! * board.thickness) as Vec3 };
    position = [board.position[0] + (ci + nx / 2 - bx / 2) * board.pitch, board.position[1] + (cj + ny / 2 - by / 2) * board.pitch];
  } else frame = { ...frame0, origin: frame0.origin.map((v, k) => v + frame0.normal[k]! * back) as Vec3 };
  return b.place(local, b.placement(frame, position), f.id);
}
