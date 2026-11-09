/**
 * Gridfinity bins and baseplates, and printable labels, built as solids.
 *
 * Everything is built in a local frame (x, y on the plane, z up from it, the footprint centred on
 * the origin), its faces named there by where they lie, and then placed on the feature's plane.
 * Sloped profiles are ruled lofts through rounded rectangles (flat faces with cone corners); a
 * bin's inside is one loft from its floor up through the stacking lip, cut out in one go.
 */

import { FeatureError, GRIDFINITY as G, type BinPlan, GridfinityError, areaPlan, labelSymbol, pieceName, type GridArea, type ResolvedGridfinity, type ResolvedLabel } from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape } from "replicad-opencascadejs";
import type { Arena } from "./arena.js";
import { Body } from "./body.js";
import { Builder, type Box3 } from "./builder.js";
import type { OC } from "./occt.js";
import { nest, textLoops } from "./text.js";

/** A built baseplate as later bins see it. */
export interface GridRecord {
  frame: PlaneFrame;
  /** Centre of the grid in plane coordinates. */
  position: [number, number];
  units: [number, number];
  /** Height of the pockets' floor above the plane. */
  floor: number;
}

/** A bin's nest for a part: its plan and the nest's solid in the bin's local frame. */
export interface BinPocket {
  plan: BinPlan;
  tool: TopoDS_Shape;
}

const inBox = (p: Vec3, b: Box3, eps = 1e-3) => p.every((v, i) => v >= b.min[i]! - eps && v <= b.max[i]! + eps);

/** Distance from a point to a rounded rectangle's outline (centred on the origin), in the plane. */
export function toOutline(x: number, y: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x) - (w / 2 - r), qy = Math.abs(y) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
  return Math.abs(outside - r);
}

const checked = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof GridfinityError) throw new FeatureError(e.message);
    throw e;
  }
};

// ---------------------------------------------------------------- bin

export function gridfinityBody(oc: OC, arena: Arena, f: ResolvedGridfinity, frame: PlaneFrame, plate: GridRecord | undefined, warnings: string[], pocket?: BinPocket): { body: Body; record?: GridRecord } {
  if (f.kind !== "bin") return plateBody(oc, arena, f, frame);
  if (!pocket) return { body: binBody(oc, arena, f, frame, plate, warnings) };
  // A nest for a part: a solid bin of the planned size, the nest cut into its top.
  const plan = pocket.plan;
  const g: ResolvedGridfinity = { ...f, units: plan.units, height: plan.height, solid: true, dividers: [0, 0], position: plan.center };
  delete g.scoop;
  delete g.tab;
  return { body: binBody(oc, arena, g, frame, plate, warnings, pocket) };
}

function binBody(oc: OC, arena: Arena, f: ResolvedGridfinity, frame0: PlaneFrame, plate: GridRecord | undefined, warnings: string[], pocket?: BinPocket): Body {
  const b = new Builder(oc, arena);
  const [nx, ny] = f.units;
  const W = nx * G.pitch - G.gap, D = ny * G.pitch - G.gap, R = G.binRadius;
  const H = f.height * G.unit;
  const lip = f.lip !== false;
  const t = f.wall ?? G.wall;
  if (!(t >= 0.4 && t <= 2.5)) throw new FeatureError("the wall must be between 0.4 and 2.5 mm thick");
  const floor = f.floor ?? (H >= 2 * G.unit ? G.binFloor : G.footHeight + 0.85);
  if (!(floor >= G.footHeight - 1e-9)) throw new FeatureError(`the floor must be at least ${G.footHeight} mm high (the feet)`);
  if (!f.solid && floor > H - (lip ? 1 : 0.5)) throw new FeatureError(`a hollow bin ${f.height} unit${f.height > 1 ? "s" : ""} high needs a floor below ${(H - (lip ? 1 : 0.5)).toFixed(1)} mm: make it taller or solid`);
  const magnetD = f.magnetDiameter ?? G.magnetDiameter, magnetDepth = f.magnetDepth ?? G.magnetDepth;
  if (f.magnets && !(magnetD > 0 && magnetD < 12 && magnetDepth > 0 && magnetDepth < G.footHeight)) throw new FeatureError(`magnet holes must be under 12 mm wide and under ${G.footHeight} mm deep`);

  // Feet, one per cell, under a block that rises to the rim (or past the lip's edge, cut later).
  const cells: [number, number][] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) cells.push([(i - (nx - 1) / 2) * G.pitch, (j - (ny - 1) / 2) * G.pitch]);
  const footW = G.pitch - G.gap;
  const feet = cells.map(([cx, cy]) => b.profileSolid(cx, cy, footW, footW, R, G.foot));
  const top = lip ? H + G.lipHeight + 0.6 : H;
  let shape = b.bool("fuse", b.block(0, 0, W, D, R, G.footHeight, top), feet);

  // The inside: from the floor up, then (with a lip) a 45° support out of the wall to the lip.
  const cuts: TopoDS_Shape[] = [];
  const lipProfile = (from: number): [number, number][] => {
    const p: [number, number][] = G.lip.map(([z, d]) => [H + z, d]);
    p.push([H + G.lipHeight + 1.2, -1.2]);
    return p.filter(([z]) => z >= from);
  };
  if (!f.solid) {
    if (lip) {
      const support = H - (G.lip[0]![1] - t);
      const profile: [number, number][] = floor < support - 1e-6 ? [[floor, t], [support, t]] : [[floor, t + (floor - support)]];
      cuts.push(b.profileSolid(0, 0, W, D, R, [...profile, ...lipProfile(floor + 1e-6)]));
    } else cuts.push(b.block(0, 0, W - 2 * t, D - 2 * t, R - t, floor, H + 1));
  } else if (lip) cuts.push(b.profileSolid(0, 0, W, D, R, lipProfile(H)));
  else if (top > H) cuts.push(b.block(0, 0, W + 2, D + 2, R + 1, H, top + 1));

  // Holes in the feet: magnets from below, screws (deeper, narrower) in the same places.
  const holes: Vec3[] = [];
  const screwDepth = Math.min(G.screwDepth, floor - 0.8);
  if (f.magnets || f.screws)
    for (const [cx, cy] of cells)
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          const x = cx + sx * G.holeOffset, y = cy + sy * G.holeOffset;
          holes.push([x, y, 0]);
          if (f.magnets) cuts.push(b.cylinderZ(x, y, magnetD / 2, -1, magnetDepth));
          if (f.screws) cuts.push(b.cylinderZ(x, y, G.screwDiameter / 2, -1, screwDepth));
        }
  if (f.screws && screwDepth < G.screwDepth) warnings.push(`the screw holes are ${screwDepth.toFixed(1)} mm deep: raise the floor for the full ${G.screwDepth} mm`);
  const grip = pocket?.plan.grip;
  if (pocket) {
    cuts.push(pocket.tool);
    if (grip) cuts.push(b.cylinderY(grip.x, grip.z, grip.radius, grip.y0, grip.y1));
  }
  shape = b.bool("cut", shape, cuts);

  // Compartments: dividers, scoops at the front, label tabs at the back.
  const [dx, dy] = f.dividers;
  const dt = f.dividerThickness ?? t;
  const ix0 = -W / 2 + t, iy0 = -D / 2 + t, iw = W - 2 * t, id = D - 2 * t;
  const cw = (iw - dx * dt) / (dx + 1), cd = (id - dy * dt) / (dy + 1);
  const ch = H - floor;
  const adds: TopoDS_Shape[] = [];
  const regions: { tag: string; box: Box3 }[] = [];
  if (!f.solid) {
    if (dx || dy) {
      if (!(dt >= 0.4 && dt <= 5)) throw new FeatureError("dividers must be between 0.4 and 5 mm thick");
      if (cw < 3 || cd < 3) throw new FeatureError("too many dividers: the compartments would be under 3 mm");
    }
    const embed = t / 2;
    for (let k = 1; k <= dx; k++) {
      const x = ix0 + k * cw + (k - 1) * dt;
      adds.push(b.block(x + dt / 2, 0, dt, id + 2 * embed, 0, floor - 0.01, H));
      regions.push({ tag: "divider", box: { min: [x, -D / 2, floor], max: [x + dt, D / 2, H] } });
    }
    for (let k = 1; k <= dy; k++) {
      const y = iy0 + k * cd + (k - 1) * dt;
      adds.push(b.block(0, y + dt / 2, iw + 2 * embed, dt, 0, floor - 0.01, H));
      regions.push({ tag: "divider", box: { min: [-W / 2, y, floor], max: [W / 2, y + dt, H] } });
    }
    const rows = Array.from({ length: dy + 1 }, (_, k) => iy0 + k * (cd + dt));
    const colsX = Array.from({ length: dx + 1 }, (_, k) => ix0 + k * (cw + dt));
    const scoop = Math.min(f.scoop ?? 0, cd * 0.8, ch * 0.9);
    if ((f.scoop ?? 0) > 0) {
      if (scoop < 1) throw new FeatureError("the compartments are too small for a scoop");
      if (scoop < f.scoop! - 1e-6) warnings.push(`the scoop is ${scoop.toFixed(1)} mm (as large as the compartments allow)`);
      for (const y0 of rows) {
        // A block in the front corner with a quarter cylinder taken out: the floor curves up into the wall.
        const x0 = ix0 - 0.05, x1 = ix0 + iw + 0.05;
        const s = b.bool("cut", b.prismX([[y0 - 0.05, floor - 0.01], [y0 + scoop, floor - 0.01], [y0 + scoop, floor + scoop], [y0 - 0.05, floor + scoop]], x0, x1), [b.cylinderX(y0 + scoop, floor + scoop, scoop, x0 - 1, x1 + 1)]);
        adds.push(s);
        regions.push({ tag: "scoop", box: { min: [x0, y0, floor + 1e-3], max: [x1, y0 + scoop, floor + scoop] } });
      }
    }
    if (f.tab) {
      const tw = f.tab.width ?? G.tabWidth;
      const ang = f.tab.angle ?? G.tabAngle;
      if (!(tw >= 3 && tw <= cd - 2)) throw new FeatureError(`the label tab must be between 3 and ${Math.max(3, cd - 2).toFixed(1)} mm wide`);
      if (!(ang >= 0 && ang <= 60)) throw new FeatureError("the tab's angle must be between 0° and 60°");
      // A ledge flush with the rim, 1 mm thick at its edge, its underside sloping down to the wall.
      const drop = Math.min(1 + tw * Math.tan((ang * Math.PI) / 180), ch - 0.5);
      const len = f.tab.style && f.tab.style !== "full" ? Math.min(cw, G.tabLength) : cw;
      for (let r = 0; r < rows.length; r++) {
        const y1 = rows[r]! + cd;
        for (const x0c of colsX) {
          const x0 = f.tab.style === "right" ? x0c + cw - len : f.tab.style === "center" ? x0c + (cw - len) / 2 : x0c;
          const over = len >= cw - 1e-6 ? 0.05 : 0;
          adds.push(b.prismX([[y1 + 0.1, H], [y1 - tw, H], [y1 - tw, H - Math.min(1, drop)], [y1 + 0.1, H - drop]], x0 - over, x0 + len + over));
          regions.push({ tag: "tab", box: { min: [x0, y1 - tw, H - drop], max: [x0 + len, y1, H] } });
        }
      }
    }
  }
  // A nest's thousands of triangles stay as they are (merging them would take long and gain little).
  shape = adds.length ? b.bool("fuse", shape, adds) : shape;
  if (!pocket) shape = b.unify(shape);
  const local = new Body(oc, arena, f.id, shape);
  const nest = pocket?.plan.footprint;
  const reach = (pocket?.plan.cell ?? 0) * 3 + (f.pocket?.clearance ?? 0);
  const name = (p: string) => [`${f.id}.${p}`];
  local.faceTags = local.faces.map((_, i) => {
    const p = local.facePoints[i]!;
    const n = local.faceInfo[i]!.normal;
    const up = !!n && n[2] > 0.99, down = !!n && n[2] < -0.99;
    if (holes.some(([x, y]) => Math.hypot(p[0] - x, p[1] - y) < magnetD / 2 + 1e-3) && p[2] < Math.max(magnetDepth, screwDepth) + 1e-3) return name("hole");
    if (down && Math.abs(p[2]) < 1e-6) return name("bottom");
    if (p[2] < G.footHeight + 1e-6 && (down || toOutline(p[0], p[1], W, D, R) > 1e-3)) return name("foot");
    // The groove is the only curved face below the rim (feet and holes are named above).
    if (grip && !n && p[2] < H) return name("grip");
    if (nest && p[2] < H - 1e-6 && p[0] > nest.min[0] - reach && p[0] < nest.max[0] + reach && p[1] > nest.min[1] - reach && p[1] < nest.max[1] + reach) return name("nest");
    if (up && Math.abs(p[2] - floor) < 1e-6 && !f.solid) return name("floor");
    // A tab's top runs on over the dividers' tops in one face: tabs first.
    const onTop = up && Math.abs(p[2] - H) < 1e-6;
    if (onTop && f.tab && regions.some((r) => r.tag === "tab" && Math.abs(p[1] - (r.box.min[1] + r.box.max[1]) / 2) < (r.box.max[1] - r.box.min[1]) / 2 + 1e-3)) return name("tab");
    for (const r of regions) if (inBox(p, r.box)) return name(r.tag === "tab" && !onTop ? "tab_under" : r.tag);
    if (toOutline(p[0], p[1], W, D, R) < 1e-3) return name("wall");
    if (up && Math.abs(p[2] - H) < 1e-6) return name("top");
    if (lip && p[2] > H - (G.lip[0]![1] - t) - 1e-3) return name("lip");
    return name("inner");
  });

  // Placement: free on the plane, or in a baseplate's cell.
  let frame = frame0;
  let position = f.position;
  if (plate) {
    const [px, py] = plate.units;
    const [ci, cj] = f.cell;
    if (ci + nx > px || cj + ny > py) warnings.push(`the bin reaches past the baseplate (${px}×${py} cells)`);
    frame = { ...plate.frame, origin: toWorld(plate.frame, [0, 0]).map((v, k) => v + plate.frame.normal[k]! * plate.floor) as Vec3 };
    position = [plate.position[0] + (ci + nx / 2 - px / 2) * G.pitch, plate.position[1] + (cj + ny / 2 - py / 2) * G.pitch];
  }
  return b.place(local, b.placement(frame, position, pocket && !plate ? (pocket.plan.angle * 180) / Math.PI : 0), f.id);
}

// ---------------------------------------------------------------- baseplate

function plateBody(oc: OC, arena: Arena, f: ResolvedGridfinity, frame: PlaneFrame): { body: Body; record: GridRecord } {
  const b = new Builder(oc, arena);
  // A plain grid of `units` (drawers, outlines and print beds go to areaPlateBodies).
  const units = f.units;
  const outer: [number, number] = [units[0] * G.pitch, units[1] * G.pitch];
  const [nx, ny] = units;
  const holes = !!(f.magnets || f.screws);
  const floor = f.floor ?? (holes ? G.plateFloorWithHoles : 0);
  const magnetD = f.magnetDiameter ?? G.magnetDiameter, magnetDepth = f.magnetDepth ?? G.magnetDepth;
  if (floor < 0) throw new FeatureError("the floor cannot be negative");
  if (f.magnets && floor < magnetDepth + 0.4) throw new FeatureError(`magnets need a floor of at least ${(magnetDepth + 0.4).toFixed(1)} mm`);
  if (f.screws && floor < G.plateScrewHead / 2 - G.plateScrewDiameter / 2 + 0.5) throw new FeatureError("countersunk screws need a floor of at least 2.3 mm");
  const top = floor + G.pocketHeight;
  let shape = b.block(0, 0, outer[0], outer[1], G.plateRadius, 0, top);
  const cells: [number, number][] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) cells.push([(i - (nx - 1) / 2) * G.pitch, (j - (ny - 1) / 2) * G.pitch]);
  // Pockets, their top slope carried on above the plate so neighbours meet in a sharp ridge.
  const profile: [number, number][] = G.pocket.map(([z, d]) => [floor + z, d] as [number, number]);
  if (floor <= 0) profile.unshift([-0.5, G.pocket[0]![1]]);
  profile.push([top + 0.5, -0.5]);
  const cuts = cells.map(([cx, cy]) => b.profileSolid(cx, cy, G.pitch, G.pitch, G.plateRadius, profile));
  const holeAt: Vec3[] = [];
  for (const [cx, cy] of cells) {
    if (f.magnets)
      for (const sx of [-1, 1])
        for (const sy of [-1, 1]) {
          const x = cx + sx * G.holeOffset, y = cy + sy * G.holeOffset;
          cuts.push(b.cylinderZ(x, y, magnetD / 2, floor - magnetDepth, floor + 0.5));
          holeAt.push([x, y, magnetD / 2]);
        }
    if (f.screws) {
      const k = G.plateScrewHead / 2 - G.plateScrewDiameter / 2;
      cuts.push(b.cylinderZ(cx, cy, G.plateScrewDiameter / 2, -1, floor + 0.5));
      cuts.push(b.coneZ(cx, cy, G.plateScrewDiameter / 2, G.plateScrewHead / 2 + 0.5, floor - k, floor + 0.5));
      holeAt.push([cx, cy, G.plateScrewHead / 2]);
    }
  }
  shape = b.unify(b.bool("cut", shape, cuts));
  const local = new Body(oc, arena, f.id, shape);
  const gx = nx * G.pitch, gy = ny * G.pitch;
  const name = (p: string) => [`${f.id}.${p}`];
  local.faceTags = local.faces.map((_, i) => {
    const p = local.facePoints[i]!;
    const n = local.faceInfo[i]!.normal;
    if (holeAt.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r + 1e-3 && p[2] < floor - 1e-6)) return name("hole");
    if (n && n[2] < -0.99 && Math.abs(p[2]) < 1e-6) return name("bottom");
    if (n && n[2] > 0.99 && Math.abs(p[2] - top) < 1e-6) return name("top");
    if (toOutline(p[0], p[1], outer[0], outer[1], G.plateRadius) < 1e-3) return name("side");
    if (n && n[2] > 0.99 && Math.abs(p[2] - floor) < 1e-6) return name("floor");
    if (Math.abs(p[0]) <= gx / 2 + 1e-3 && Math.abs(p[1]) <= gy / 2 + 1e-3) return name("pocket");
    return name("side");
  });
  const body = b.place(local, b.placement(frame, f.position), f.id);
  return { body, record: { frame, position: f.position, units, floor } };
}

// ---------------------------------------------------------------- baseplate for an area, in pieces

/** A closed region of a sketch: outer loop (counter-clockwise) and holes, in the sketch's plane. */
export interface OutlineRegion {
  outer: [number, number][];
  holes: [number, number][][];
}

/**
 * A baseplate filling a rectangle (its `units`, or a `drawer`) or sketch outlines, the rest of the
 * area a solid border at the plate's height, cut along the lines between cells into pieces that
 * fit the print bed. Every piece is a part: the feature id alone, or `gf1_A1`, `gf1_A2`, … with
 * rows from the front and columns from the left. Face names as a baseplate's, plus gf1.joint
 * where two pieces meet.
 */
export function areaPlateBodies(
  oc: OC,
  arena: Arena,
  f: ResolvedGridfinity,
  frame: PlaneFrame,
  outline: OutlineRegion[] | undefined,
  warnings: string[],
): { bodies: Body[]; record: GridRecord; info: Record<string, number> } {
  const b = new Builder(oc, arena);
  // Outlines without repeated points (a closing point equal to the first, short arc steps).
  const clean = (l: [number, number][]) => l.filter((p, i) => Math.hypot(p[0] - l[(i + 1) % l.length]![0], p[1] - l[(i + 1) % l.length]![1]) > 1e-6);
  outline = outline?.map((r) => ({ outer: clean(r.outer), holes: r.holes.map(clean).filter((h) => h.length >= 3) })).filter((r) => r.outer.length >= 3);
  if (outline && !outline.length) throw new FeatureError("the outline has no closed area");
  const gap = f.gap ?? 0.5;
  if (gap < 0 || gap > 20) throw new FeatureError("the gap to the edge must be between 0 and 20 mm");
  const area: GridArea = outline
    ? { loops: outline.flatMap((r) => [r.outer, ...r.holes]), gap }
    : f.drawer
      ? { rect: [f.drawer[0] - 2 * gap, f.drawer[1] - 2 * gap] }
      : { rect: [f.units[0] * G.pitch, f.units[1] * G.pitch] };
  const fill = f.fill !== false;
  const plan = checked(() => areaPlan(area, f.bed?.usable, fill));
  const holes = !!(f.magnets || f.screws);
  const floor = f.floor ?? (holes ? G.plateFloorWithHoles : 0);
  const magnetD = f.magnetDiameter ?? G.magnetDiameter, magnetDepth = f.magnetDepth ?? G.magnetDepth;
  if (floor < 0) throw new FeatureError("the floor cannot be negative");
  if (f.magnets && floor < magnetDepth + 0.4) throw new FeatureError(`magnets need a floor of at least ${(magnetDepth + 0.4).toFixed(1)} mm`);
  if (f.screws && floor < G.plateScrewHead / 2 - G.plateScrewDiameter / 2 + 0.5) throw new FeatureError("countersunk screws need a floor of at least 2.3 mm");
  const top = floor + G.pocketHeight;

  // The whole plate's outline as one solid, cut into tiles below (without the border: none for an
  // outline, where the plate is just its cells, and the grid's rounded rectangle for a rectangle).
  const whole = outline && !fill
    ? null
    : outline
    ? (() => {
        const parts = outline.map((r) => b.regionSolid(r.outer, r.holes, gap, 0, top)).filter((x) => b.volume(x) > 1e-6);
        if (!parts.length) throw new FeatureError("the outline is too small for the gap");
        return parts.length > 1 ? b.bool("fuse", parts[0]!, parts.slice(1)) : parts[0]!;
      })()
    : b.block(0, 0, plan.max[0] - plan.min[0], plan.max[1] - plan.min[1], G.plateRadius, 0, top);

  // One pocket (with its holes), copied into every cell.
  const profile: [number, number][] = G.pocket.map(([z, d]) => [floor + z, d] as [number, number]);
  if (floor <= 0) profile.unshift([-0.5, G.pocket[0]![1]]);
  profile.push([top + 0.5, -0.5]);
  const cellTools: TopoDS_Shape[] = [b.profileSolid(0, 0, G.pitch, G.pitch, G.plateRadius, profile)];
  const holeAt: Vec3[] = [];
  if (f.magnets)
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        cellTools.push(b.cylinderZ(sx * G.holeOffset, sy * G.holeOffset, magnetD / 2, floor - magnetDepth, floor + 0.5));
        holeAt.push([sx * G.holeOffset, sy * G.holeOffset, magnetD / 2]);
      }
  if (f.screws) {
    const k = G.plateScrewHead / 2 - G.plateScrewDiameter / 2;
    cellTools.push(b.cylinderZ(0, 0, G.plateScrewDiameter / 2, -1, floor + 0.5), b.coneZ(0, 0, G.plateScrewDiameter / 2, G.plateScrewHead / 2 + 0.5, floor - k, floor + 0.5));
    holeAt.push([0, 0, G.plateScrewHead / 2]);
  }
  // One cell of the plate: a 42 mm square block with its pocket and holes, copied into every cell
  // (whole cells share their side faces, so gluing them is far faster than cutting pockets).
  const cell = b.bool("cut", b.block(0, 0, G.pitch, G.pitch, 0, 0, top), cellTools);
  const present = new Set(plan.cells.map(([i, j]) => `${i},${j}`));
  const centre = (i: number, j: number): [number, number] => [plan.origin[0] + (i + 0.5) * G.pitch, plan.origin[1] + (j + 0.5) * G.pitch];
  const cellAt = (x: number, y: number) => [Math.floor((x - plan.origin[0]) / G.pitch), Math.floor((y - plan.origin[1]) / G.pitch)] as const;

  const [xs, ys] = plan.cuts;
  const inner = (v: number, cuts: number[]) => cuts.slice(1, -1).some((c) => Math.abs(v - c) < 1e-6);
  const name = (p: string) => [`${f.id}.${p}`];
  const tag = (body: Body) => {
    body.faceTags = body.faces.map((_, i) => {
      const p = body.facePoints[i]!;
      const n = body.faceInfo[i]!.normal;
      const [ci, cj] = cellAt(p[0], p[1]);
      const inCell = present.has(`${ci},${cj}`);
      if (inCell && p[2] < floor - 1e-6) {
        const [cx, cy] = centre(ci, cj);
        if (holeAt.some(([x, y, r]) => Math.hypot(p[0] - cx - x, p[1] - cy - y) < r + 1e-3)) return name("hole");
      }
      if (n && n[2] < -0.99 && Math.abs(p[2]) < 1e-6) return name("bottom");
      if (n && n[2] > 0.99 && Math.abs(p[2] - top) < 1e-6) return name("top");
      if (n && Math.abs(n[2]) < 1e-6 && ((Math.abs(n[0]) > 0.99 && inner(p[0], xs)) || (Math.abs(n[1]) > 0.99 && inner(p[1], ys)))) return name("joint");
      if (n && n[2] > 0.99 && Math.abs(p[2] - floor) < 1e-6 && floor > 0) return name("floor");
      // Pockets (and the walls of their holes) lie inside their cell.
      if (inCell) return name("pocket");
      return name("side");
    });
    return body;
  };

  // Pieces: the tile's cells glued together, and the rest of the tile (the border) joined to them.
  // Rectangles repeat, so a tile equal to an earlier one is that one moved (and meshed only once).
  const cache = new Map<string, { shape: TopoDS_Shape; x0: number; y0: number }>();
  const gx0 = plan.origin[0], gx1 = plan.origin[0] + plan.units[0] * G.pitch;
  const gy0 = plan.origin[1], gy1 = plan.origin[1] + plan.units[1] * G.pitch;
  const rect = outline ? null : { w: plan.max[0] - plan.min[0], d: plan.max[1] - plan.min[1] };
  // A cell whose square reaches past the plate's rounded corners (no border there) is clipped.
  const clipped = (x: number, y: number) =>
    rect !== null && [[x, y], [x + G.pitch, y], [x, y + G.pitch], [x + G.pitch, y + G.pitch]].some(([px, py]) => {
      const qx = Math.abs(px!) - (rect.w / 2 - G.plateRadius), qy = Math.abs(py!) - (rect.d / 2 - G.plateRadius);
      return qx > 1e-6 && qy > 1e-6 && Math.hypot(qx, qy) > G.plateRadius + 1e-6;
    });
  // A piece is its own shape, or (`key`) a copy of an earlier one moved by dx, dy.
  const pieces: { col: number; row: number; shape: TopoDS_Shape; key: string | null; dx: number; dy: number }[] = [];
  for (let c = 0; c < xs.length - 1; c++)
    for (let r = 0; r < ys.length - 1; r++) {
      const x0 = xs[c]!, x1 = xs[c + 1]!, y0 = ys[r]!, y1 = ys[r + 1]!;
      const key = outline
        ? null
        : [x1 - x0, y1 - y0, Math.max(gx0, x0) - x0, Math.min(gx1, x1) - x0, Math.max(gy0, y0) - y0, Math.min(gy1, y1) - y0, c === 0, c === xs.length - 2, r === 0, r === ys.length - 2].map((v) => (typeof v === "number" ? v.toFixed(4) : v)).join("|");
      const hit = key ? cache.get(key) : undefined;
      if (hit) {
        pieces.push({ col: c, row: r, shape: hit.shape, key, dx: x0 - hit.x0, dy: y0 - hit.y0 });
        continue;
      }
      const single = xs.length === 2 && ys.length === 2;
      const region = !whole ? null : single ? whole : b.common(whole, b.block((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 0, -1, top + 1));
      if (region && b.volume(region) < 1e-3) continue;
      const inTile = plan.cells.filter(([i, j]) => {
        const [cx, cy] = centre(i, j);
        return cx > x0 && cx < x1 && cy > y0 && cy < y1;
      });
      const cells = inTile.map(([i, j]) => {
        const [cx, cy] = centre(i, j);
        const copy = b.moved(cell, cx, cy, 0, false);
        return region && clipped(cx - G.pitch / 2, cy - G.pitch / 2) ? b.common(copy, region) : copy;
      });
      // The border: the tile less its cells' squares (row by row, runs of neighbouring cells as one box).
      const boxes: TopoDS_Shape[] = [];
      const rows = new Map<number, number[]>();
      for (const [i, j] of inTile) rows.set(j, [...(rows.get(j) ?? []), i]);
      for (const [j, is] of rows) {
        is.sort((a, z) => a - z);
        for (let k = 0; k < is.length; ) {
          let e = k;
          while (e + 1 < is.length && is[e + 1] === is[e]! + 1) e++;
          const xa = plan.origin[0] + is[k]! * G.pitch, xb = plan.origin[0] + (is[e]! + 1) * G.pitch, ya = plan.origin[1] + j * G.pitch;
          boxes.push(b.block((xa + xb) / 2, ya + G.pitch / 2, xb - xa, G.pitch, 0, -1, top + 1));
          k = e + 1;
        }
      }
      const border = !fill || !region ? null : boxes.length ? b.bool("cut", region, boxes) : region;
      const borderParts = border ? b.solids(border).filter((x) => b.volume(x) > 1e-3) : [];
      let shape: TopoDS_Shape;
      if (!cells.length) {
        if (!border || !borderParts.length) continue;
        shape = border;
      }
      else {
        let grid = cells.length > 1 ? b.glue(cells[0]!, cells.slice(1), "BOPAlgo_GlueFull") : cells[0]!;
        if (borderParts.length) grid = b.glue(grid, borderParts, "BOPAlgo_GlueShift");
        shape = b.unify(grid);
      }
      if (key) cache.set(key, { shape, x0, y0 });
      pieces.push({ col: c, row: r, shape, key, dx: 0, dy: 0 });
    }

  // Parts: one per piece (a piece an outline splits in two gives two). Copies share the tagged
  // local body of the piece they copy and are only placed further along.
  const locals = new Map<string, Body[]>();
  const made: { name: string; local: Body; dx: number; dy: number }[] = [];
  for (const p of pieces) {
    let ls = p.key ? locals.get(p.key) : undefined;
    if (!ls) {
      const solids = outline ? b.solids(p.shape).filter((x) => b.volume(x) > 1e-3) : [p.shape];
      ls = solids.map((x) => tag(new Body(oc, arena, f.id, x)));
      if (p.key) locals.set(p.key, ls);
    }
    ls.forEach((local, k) => made.push({ name: `${pieceName(p.col, p.row)}${k ? `_${k + 1}` : ""}`, local, dx: p.dx, dy: p.dy }));
  }
  if (!made.length) throw new FeatureError("the baseplate has no material left");
  const position: [number, number] = outline ? [0, 0] : f.position;
  const trsf = b.placement(frame, position);
  const bodies = made.map((m) => {
    let t = trsf;
    if (m.dx || m.dy) {
      const shift = arena.track(new oc.gp_Trsf());
      shift.SetTranslation(arena.track(new oc.gp_Vec(m.dx, m.dy, 0)));
      t = arena.track(trsf.Multiplied(shift));
    }
    return b.place(m.local, t, made.length > 1 ? `${f.id}_${m.name}` : f.id, false);
  });
  // Hundreds of pockets: a lighter view (each pocket's rounded corners in fewer steps).
  if (plan.cells.length > 150) for (const body of bodies) body.displayCoarse = 4;
  // Export: 0.02 mm (0.25 rad) is far below what a printer resolves and needs about a third of the
  // usual triangles (a 3 m × 1.5 m floor stays a file a slicer opens).
  for (const body of bodies) body.exportTolerance = { linear: 0.02, angular: 0.25 };
  const plate = [plan.max[0] - plan.min[0], plan.max[1] - plan.min[1]];
  if (f.bed && plan.turned) warnings.push("the pieces fit the print bed turned by 90°");
  const grid: [number, number] = [plan.origin[0] + (plan.units[0] * G.pitch) / 2 + position[0], plan.origin[1] + (plan.units[1] * G.pitch) / 2 + position[1]];
  const info: Record<string, number> = {
    cells: plan.cells.length,
    cellsX: plan.units[0],
    cellsY: plan.units[1],
    pieces: made.length,
    width: round3(plate[0]!),
    depth: round3(plate[1]!),
    largestX: round3(Math.max(...xs.slice(1).map((x, i) => x - xs[i]!))),
    largestY: round3(Math.max(...ys.slice(1).map((y, i) => y - ys[i]!))),
  };
  // The rest beside the cells, filled or left empty.
  if ("rect" in area) {
    info["borderX"] = round3((area.rect[0] - plan.units[0] * G.pitch) / 2);
    info["borderY"] = round3((area.rect[1] - plan.units[1] * G.pitch) / 2);
  }
  return { bodies, record: { frame, position: grid, units: plan.units, floor }, info };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- labels

/**
 * A label: rounded plate, symbol on the left, text in the rest (as large as fits unless sized).
 * Returns the plate (with the marking joined or cut) and, with `separate`, the marking alone.
 */
export function labelBodies(oc: OC, arena: Arena, f: ResolvedLabel, frame: PlaneFrame, warnings: string[]): Body[] {
  const b = new Builder(oc, arena);
  const { width: W, height: H, thickness: T, depth: d } = f;
  if (!(W >= 4 && H >= 4)) throw new FeatureError("a label must be at least 4 × 4 mm");
  if (!(T > 0)) throw new FeatureError("the label's thickness must be greater than zero");
  if (!(d > 0)) throw new FeatureError("the marking's depth must be greater than zero");
  const engraved = f.style === "engraved";
  if (engraved && d >= T - 0.2) throw new FeatureError(`engraving must stay under ${(T - 0.2).toFixed(1)} mm deep (the label is ${T} mm thick)`);
  const margin = Math.min(1.2, H * 0.12);
  const avail: [number, number] = [W - 2 * margin, H - 2 * margin];
  const loops: [number, number][][] = [];
  let x = -W / 2 + margin;
  const symbol = f.symbol && f.symbol !== "none" ? labelSymbol(f.symbol) : null;
  const text = f.text?.trim() ? f.text : "";
  if (symbol) {
    let s = avail[1];
    if (symbol.width * s > (text ? avail[0] * 0.45 : avail[0])) s = (text ? avail[0] * 0.45 : avail[0]) / symbol.width;
    const x0 = text ? x : -(symbol.width * s) / 2;
    for (const l of symbol.loops) loops.push(l.map(([u, v]) => [x0 + u * s, v * s] as [number, number]));
    x = x0 + symbol.width * s + margin;
  }
  if (text) {
    const room: [number, number] = [W / 2 - margin - x, avail[1]];
    const lines = text.split("\n").length;
    // Cap height about 70% of a line's room: measure once, then scale down to fit.
    const first = Math.min(f.size ?? Infinity, (room[1] / lines) * 0.7);
    const measure = (size: number) => {
      const r = textLoops(text, { font: f.font, size });
      const xs = r.loops.flat().map((p) => p[0]), ys = r.loops.flat().map((p) => p[1]);
      return { ...r, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
    };
    let m = measure(first);
    if (!m.loops.length) throw new FeatureError("the text has no letters to draw");
    const scale = Math.min(1, room[0] / (m.max[0]! - m.min[0]!), room[1] / (m.max[1]! - m.min[1]!));
    if (scale < 0.999) {
      if (f.size !== undefined) warnings.push(`the text is smaller than ${f.size} mm so it fits on the label`);
      m = measure(first * scale * 0.995);
    }
    if (m.missing.length) warnings.push(`the font has no ${m.missing.map((c) => `"${c}"`).join(", ")}`);
    const cx = symbol ? x + room[0] / 2 : 0;
    const ox = cx - (m.min[0]! + m.max[0]!) / 2, oy = -(m.min[1]! + m.max[1]!) / 2;
    for (const l of m.loops) loops.push(l.map(([u, v]) => [u + ox, v + oy] as [number, number]));
  }
  if (!loops.length) throw new FeatureError("a label needs a text or a symbol");
  // Clean outlines: no repeated points.
  const clean = loops.map((l) => l.filter((p, i) => Math.hypot(p[0] - l[(i + 1) % l.length]![0], p[1] - l[(i + 1) % l.length]![1]) > 1e-6)).filter((l) => l.length >= 3);
  const z0 = engraved ? T - d : T;
  const marks: TopoDS_Shape[] = [];
  for (const s of nest(clean)) {
    const face = b.polyFace(s.outer, s.holes, z0);
    if (face) marks.push(b.prismZ(face, d));
  }
  if (!marks.length) throw new FeatureError("the label's marking could not be built");
  const plate = b.block(0, 0, W, H, Math.min(f.corner, W / 2 - 0.01, H / 2 - 0.01), 0, T);
  const mark = b.compound(marks);
  let base: TopoDS_Shape;
  if (engraved) {
    // Engraving opens a hair above the top so the cut is clean; the inlay fills it exactly.
    const deeper = marks.map((m) => {
      const t = arena.track(new oc.gp_Trsf());
      t.SetTranslation(arena.track(new oc.gp_Vec(0, 0, 0.01)));
      return arena.track(arena.track(new oc.BRepBuilderAPI_Transform(m, t, true, false)).Shape());
    });
    base = b.bool("cut", plate, [b.compound(marks), b.compound(deeper)]);
  } else base = f.separate ? plate : b.bool("fuse", plate, [mark]);
  const tag = (body: Body, isMark: boolean) => {
    body.faceTags = body.faces.map((_, i) => {
      const p = body.facePoints[i]!;
      const n = body.faceInfo[i]!.normal;
      const id = f.id;
      if (isMark) return [`${id}.mark`];
      if (n && n[2] < -0.99 && Math.abs(p[2]) < 1e-6) return [`${id}.bottom`];
      if (n && n[2] > 0.99 && Math.abs(p[2] - T) < 1e-6) return [`${id}.top`];
      if (p[2] < T + 1e-6 && toOutline(p[0], p[1], W, H, Math.min(f.corner, W / 2 - 0.01, H / 2 - 0.01)) < 1e-3) return [`${id}.side`];
      return [`${id}.mark`];
    });
    return body;
  };
  const trsf = b.placement(frame, f.position, f.angle);
  const out = [b.place(tag(new Body(oc, arena, f.id, b.unify(base)), false), trsf, f.id)];
  if (f.separate) out.push(b.place(tag(new Body(oc, arena, `${f.id}_mark`, b.unify(mark)), true), trsf, `${f.id}_mark`));
  return out;
}
