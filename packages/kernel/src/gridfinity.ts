/**
 * Gridfinity bins and baseplates, and printable labels, built as solids.
 *
 * Everything is built in a local frame (x, y on the plane, z up from it, the footprint centred on
 * the origin), its faces named there by where they lie, and then placed on the feature's plane.
 * Sloped profiles are ruled lofts through rounded rectangles (flat faces with cone corners); a
 * bin's inside is one loft from its floor up through the stacking lip, cut out in one go.
 */

import {
  FeatureError,
  GRIDFINITY as G,
  type AreaPlan,
  type BinPlan,
  GridfinityError,
  areaPlan,
  labelSymbol,
  pieceName,
  type GridArea,
  type ResolvedGridfinity,
  type ResolvedLabel,
} from "@meercad/model";
import { toWorld, type PlaneFrame, type Vec3 } from "@meercad/sketch";
import type { TopoDS_Shape, gp_Trsf } from "replicad-opencascadejs";
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

const inBox = (p: Vec3, b: Box3, eps = 1e-3) =>
  p.every((v, i) => v >= b.min[i]! - eps && v <= b.max[i]! + eps);

/** Distance from a point to a rounded rectangle's outline (centred on the origin), in the plane. */
export function toOutline(x: number, y: number, w: number, h: number, r: number): number {
  const qx = Math.abs(x) - (w / 2 - r),
    qy = Math.abs(y) - (h / 2 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);

  return Math.abs(outside - r);
}

const checked = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    if (error instanceof GridfinityError) throw new FeatureError(error.message);

    throw error;
  }
};

// ---------------------------------------------------------------- bin

export function gridfinityBody(
  oc: OC,
  arena: Arena,
  f: ResolvedGridfinity,
  frame: PlaneFrame,
  plate: GridRecord | undefined,
  warnings: string[],
  pocket?: BinPocket,
): { body: Body; record?: GridRecord } {
  if (f.kind !== "bin") return plateBody(oc, arena, f, frame);
  if (!pocket) return { body: binBody(oc, arena, f, frame, plate, warnings) };

  // A nest for a part: a solid bin of the planned size, the nest cut into its top.
  const plan = pocket.plan;
  const g: ResolvedGridfinity = {
    ...f,
    units: plan.units,
    height: plan.height,
    solid: true,
    dividers: [0, 0],
    position: plan.center,
  };
  delete g.scoop;
  delete g.tab;

  return { body: binBody(oc, arena, g, frame, plate, warnings, pocket) };
}

/** A bin's checked measures in its local frame (the footprint centred on the origin, z up). */
interface BinMeasures {
  units: [number, number];
  width: number;
  depth: number;
  radius: number;
  /** Height of the rim above the plane. */
  height: number;
  lip: boolean;
  wall: number;
  floor: number;
  magnetDiameter: number;
  magnetDepth: number;
  /** Height where the lip's 45° support leaves the wall. */
  lipStart: number;
  /** Top of the block the bin is cut from: the rim, or past the lip's edge with a lip. */
  top: number;
}

/** A box whose faces get the tag (dividers, scoops, tabs). */
interface TaggedBox {
  tag: string;
  box: Box3;
}

/** Shapes to join to the bin and the boxes that name their faces. */
interface BinParts {
  shapes: TopoDS_Shape[];
  regions: TaggedBox[];
}

/** Holes in the feet: where they are and the tools that cut them. */
interface FootHoles {
  centres: Vec3[];
  tools: TopoDS_Shape[];
  screwDepth: number;
}

function binBody(
  oc: OC,
  arena: Arena,
  feature: ResolvedGridfinity,
  frame: PlaneFrame,
  plate: GridRecord | undefined,
  warnings: string[],
  pocket?: BinPocket,
): Body {
  const b = new Builder(oc, arena);
  const bin = binMeasures(feature);
  const cells = cellCentres(bin.units[0], bin.units[1]);
  let shape = binBlock(b, bin, cells);
  const inside = insideCuts(b, feature.solid, bin);
  const holes = footHoles(b, feature, bin, cells);

  if (feature.screws && holes.screwDepth < G.screwDepth) {
    warnings.push(
      `the screw holes are ${holes.screwDepth.toFixed(1)} mm deep: raise the floor for the full ${G.screwDepth} mm`,
    );
  }

  shape = b.bool("cut", shape, [...inside, ...holes.tools, ...nestCuts(b, pocket)]);

  const parts = compartmentParts(b, feature, bin, warnings);
  // A nest's thousands of triangles stay as they are (merging them would take long and gain little).
  shape = parts.shapes.length ? b.bool("fuse", shape, parts.shapes) : shape;
  if (!pocket) shape = b.unify(shape);

  const local = new Body(oc, arena, feature.id, shape);
  const faces: BinFaces = {
    feature,
    bin,
    holes,
    grip: pocket?.plan.grip,
    nest: pocket?.plan.footprint,
    reach: (pocket?.plan.cell ?? 0) * 3 + (feature.pocket?.clearance ?? 0),
    regions: parts.regions,
  };
  local.faceTags = local.faces.map((_, i) => [
    `${feature.id}.${binFaceName(local.facePoints[i]!, local.faceInfo[i]!.normal, faces)}`,
  ]);

  const placed = binPlacement(feature, frame, plate, warnings);
  const angle = pocket && !plate ? (pocket.plan.angle * 180) / Math.PI : 0;

  return b.place(local, b.placement(placed.frame, placed.position, angle), feature.id);
}

/** The bin's measures from its settings, refusing walls, floors and magnets that do not work. */
function binMeasures(feature: ResolvedGridfinity): BinMeasures {
  const [nx, ny] = feature.units;
  const width = nx * G.pitch - G.gap,
    depth = ny * G.pitch - G.gap;
  const height = feature.height * G.unit;
  const lip = feature.lip !== false;
  const wall = feature.wall ?? G.wall;
  if (!(wall >= 0.4 && wall <= 2.5)) throw new FeatureError("the wall must be between 0.4 and 2.5 mm thick");

  const floor = feature.floor ?? (height >= 2 * G.unit ? G.binFloor : G.footHeight + 0.85);

  if (!(floor >= G.footHeight - 1e-9)) {
    throw new FeatureError(`the floor must be at least ${G.footHeight} mm high (the feet)`);
  }

  // A hollow bin needs room above its floor (more with a lip, whose support starts below the rim).
  const highestFloor = height - (lip ? 1 : 0.5);

  if (!feature.solid && floor > highestFloor) {
    throw new FeatureError(
      `a hollow bin ${feature.height} unit${feature.height > 1 ? "s" : ""} high needs a floor below ${highestFloor.toFixed(1)} mm: make it taller or solid`,
    );
  }

  const magnetDiameter = feature.magnetDiameter ?? G.magnetDiameter,
    magnetDepth = feature.magnetDepth ?? G.magnetDepth;

  if (
    feature.magnets &&
    !(magnetDiameter > 0 && magnetDiameter < 12 && magnetDepth > 0 && magnetDepth < G.footHeight)
  ) {
    throw new FeatureError(`magnet holes must be under 12 mm wide and under ${G.footHeight} mm deep`);
  }

  return {
    units: [nx, ny],
    width,
    depth,
    radius: G.binRadius,
    height,
    lip,
    wall,
    floor,
    magnetDiameter,
    magnetDepth,
    lipStart: height - (G.lip[0]![1] - wall),
    top: lip ? height + G.lipHeight + 0.6 : height,
  };
}

/** Centres of a grid of nx × ny cells centred on the origin. */
function cellCentres(nx: number, ny: number): [number, number][] {
  const cells: [number, number][] = [];

  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) cells.push([(i - (nx - 1) / 2) * G.pitch, (j - (ny - 1) / 2) * G.pitch]);
  }

  return cells;
}

/** Feet, one per cell, under a block that rises to the rim (or past the lip's edge, cut later). */
function binBlock(b: Builder, bin: BinMeasures, cells: [number, number][]): TopoDS_Shape {
  const footWidth = G.pitch - G.gap;
  const feet = cells.map(([cx, cy]) => b.profileSolid(cx, cy, footWidth, footWidth, bin.radius, G.foot));

  return b.bool("fuse", b.block(0, 0, bin.width, bin.depth, bin.radius, G.footHeight, bin.top), feet);
}

/** The lip's inner profile (height, inset from the outside) from `from` up, closed above the lip. */
function lipProfile(bin: BinMeasures, from: number): [number, number][] {
  const profile: [number, number][] = G.lip.map(([z, d]) => [bin.height + z, d]);
  profile.push([bin.height + G.lipHeight + 1.2, -1.2]);

  return profile.filter(([z]) => z >= from);
}

/**
 * The inside: from the floor up, then (with a lip) a 45° support out of the wall to the lip. A
 * solid bin only gets its lip.
 */
function insideCuts(b: Builder, solid: boolean | undefined, bin: BinMeasures): TopoDS_Shape[] {
  const { width, depth, radius, wall, floor, lipStart } = bin;

  if (solid) return bin.lip ? [b.profileSolid(0, 0, width, depth, radius, lipProfile(bin, bin.height))] : [];

  if (!bin.lip) {
    return [b.block(0, 0, width - 2 * wall, depth - 2 * wall, radius - wall, floor, bin.height + 1)];
  }

  // A floor above the support's start meets the slope directly.
  const profile: [number, number][] =
    floor < lipStart - 1e-6
      ? [
          [floor, wall],
          [lipStart, wall],
        ]
      : [[floor, wall + (floor - lipStart)]];

  return [b.profileSolid(0, 0, width, depth, radius, [...profile, ...lipProfile(bin, floor + 1e-6)])];
}

/** Holes in the feet: magnets from below, screws (deeper, narrower) in the same places. */
function footHoles(
  b: Builder,
  feature: ResolvedGridfinity,
  bin: BinMeasures,
  cells: [number, number][],
): FootHoles {
  const centres: Vec3[] = [];
  const tools: TopoDS_Shape[] = [];
  const screwDepth = Math.min(G.screwDepth, bin.floor - 0.8);
  if (!feature.magnets && !feature.screws) return { centres, tools, screwDepth };

  for (const [cx, cy] of cells) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const x = cx + sx * G.holeOffset,
          y = cy + sy * G.holeOffset;
        centres.push([x, y, 0]);
        if (feature.magnets) tools.push(b.cylinderZ(x, y, bin.magnetDiameter / 2, -1, bin.magnetDepth));
        if (feature.screws) tools.push(b.cylinderZ(x, y, G.screwDiameter / 2, -1, screwDepth));
      }
    }
  }

  return { centres, tools, screwDepth };
}

/** A part's nest and its finger groove. */
function nestCuts(b: Builder, pocket: BinPocket | undefined): TopoDS_Shape[] {
  if (!pocket) return [];

  const grip = pocket.plan.grip;

  return grip ? [pocket.tool, b.cylinderY(grip.x, grip.z, grip.radius, grip.y0, grip.y1)] : [pocket.tool];
}

// ---------------------------------------------------------------- bin compartments

/** The room inside the walls and how the dividers split it. */
interface Compartments {
  /** Front left corner of the inside. */
  x0: number;
  y0: number;
  innerWidth: number;
  innerDepth: number;
  dividers: [number, number];
  dividerThickness: number;
  /** One compartment's width, depth and height. */
  width: number;
  depth: number;
  height: number;
}

function compartmentsOf(feature: ResolvedGridfinity, bin: BinMeasures): Compartments {
  const [dx, dy] = feature.dividers;
  const dividerThickness = feature.dividerThickness ?? bin.wall;
  const x0 = -bin.width / 2 + bin.wall,
    y0 = -bin.depth / 2 + bin.wall,
    innerWidth = bin.width - 2 * bin.wall,
    innerDepth = bin.depth - 2 * bin.wall;

  return {
    x0,
    y0,
    innerWidth,
    innerDepth,
    dividers: [dx, dy],
    dividerThickness,
    width: (innerWidth - dx * dividerThickness) / (dx + 1),
    depth: (innerDepth - dy * dividerThickness) / (dy + 1),
    height: bin.height - bin.floor,
  };
}

/** Compartments: dividers, scoops at the front, label tabs at the back (none in a solid bin). */
function compartmentParts(
  b: Builder,
  feature: ResolvedGridfinity,
  bin: BinMeasures,
  warnings: string[],
): BinParts {
  const parts: BinParts = { shapes: [], regions: [] };
  if (feature.solid) return parts;

  const room = compartmentsOf(feature, bin);
  const [dx, dy] = room.dividers;
  const thickness = room.dividerThickness;

  if (dx || dy) {
    if (!(thickness >= 0.4 && thickness <= 5)) {
      throw new FeatureError("dividers must be between 0.4 and 5 mm thick");
    }

    if (room.width < 3 || room.depth < 3) {
      throw new FeatureError("too many dividers: the compartments would be under 3 mm");
    }
  }

  addDividers(b, bin, room, parts);

  const rows = Array.from({ length: dy + 1 }, (_, k) => room.y0 + k * (room.depth + thickness));
  const columns = Array.from({ length: dx + 1 }, (_, k) => room.x0 + k * (room.width + thickness));
  addScoops(b, feature, bin, room, rows, parts, warnings);
  if (feature.tab) addTabs(b, feature.tab, bin, room, rows, columns, parts);

  return parts;
}

/** Dividers across x, then across y, reaching into the walls by half their thickness. */
function addDividers(b: Builder, bin: BinMeasures, room: Compartments, parts: BinParts) {
  const [dx, dy] = room.dividers;
  const thickness = room.dividerThickness;
  const embed = bin.wall / 2;

  for (let k = 1; k <= dx; k++) {
    const x = room.x0 + k * room.width + (k - 1) * thickness;
    parts.shapes.push(
      b.block(x + thickness / 2, 0, thickness, room.innerDepth + 2 * embed, 0, bin.floor - 0.01, bin.height),
    );
    parts.regions.push({
      tag: "divider",
      box: { min: [x, -bin.depth / 2, bin.floor], max: [x + thickness, bin.depth / 2, bin.height] },
    });
  }

  for (let k = 1; k <= dy; k++) {
    const y = room.y0 + k * room.depth + (k - 1) * thickness;
    parts.shapes.push(
      b.block(0, y + thickness / 2, room.innerWidth + 2 * embed, thickness, 0, bin.floor - 0.01, bin.height),
    );
    parts.regions.push({
      tag: "divider",
      box: { min: [-bin.width / 2, y, bin.floor], max: [bin.width / 2, y + thickness, bin.height] },
    });
  }
}

/** Scoops along each row's front, as large as asked or as the compartments allow. */
function addScoops(
  b: Builder,
  feature: ResolvedGridfinity,
  bin: BinMeasures,
  room: Compartments,
  rows: number[],
  parts: BinParts,
  warnings: string[],
) {
  const scoop = Math.min(feature.scoop ?? 0, room.depth * 0.8, room.height * 0.9);
  if (!((feature.scoop ?? 0) > 0)) return;
  if (scoop < 1) throw new FeatureError("the compartments are too small for a scoop");

  if (scoop < feature.scoop! - 1e-6) {
    warnings.push(`the scoop is ${scoop.toFixed(1)} mm (as large as the compartments allow)`);
  }

  const floor = bin.floor;

  for (const y0 of rows) {
    // A block in the front corner with a quarter cylinder taken out: the floor curves up into the wall.
    const x0 = room.x0 - 0.05,
      x1 = room.x0 + room.innerWidth + 0.05;
    const shape = b.bool(
      "cut",
      b.prismX(
        [
          [y0 - 0.05, floor - 0.01],
          [y0 + scoop, floor - 0.01],
          [y0 + scoop, floor + scoop],
          [y0 - 0.05, floor + scoop],
        ],
        x0,
        x1,
      ),
      [b.cylinderX(y0 + scoop, floor + scoop, scoop, x0 - 1, x1 + 1)],
    );
    parts.shapes.push(shape);
    parts.regions.push({
      tag: "scoop",
      box: { min: [x0, y0, floor + 1e-3], max: [x1, y0 + scoop, floor + scoop] },
    });
  }
}

/** Label tabs at the back of every compartment: ledges flush with the rim. */
function addTabs(
  b: Builder,
  tab: NonNullable<ResolvedGridfinity["tab"]>,
  bin: BinMeasures,
  room: Compartments,
  rows: number[],
  columns: number[],
  parts: BinParts,
) {
  const tabWidth = tab.width ?? G.tabWidth;
  const angle = tab.angle ?? G.tabAngle;

  if (!(tabWidth >= 3 && tabWidth <= room.depth - 2)) {
    throw new FeatureError(
      `the label tab must be between 3 and ${Math.max(3, room.depth - 2).toFixed(1)} mm wide`,
    );
  }

  if (!(angle >= 0 && angle <= 60)) throw new FeatureError("the tab's angle must be between 0° and 60°");

  // 1 mm thick at its edge, its underside sloping down to the wall.
  const height = bin.height;
  const drop = Math.min(1 + tabWidth * Math.tan((angle * Math.PI) / 180), room.height - 0.5);
  const length = tab.style && tab.style !== "full" ? Math.min(room.width, G.tabLength) : room.width;

  for (let r = 0; r < rows.length; r++) {
    const y1 = rows[r]! + room.depth;

    for (const column of columns) {
      const x0 =
        tab.style === "right"
          ? column + room.width - length
          : tab.style === "center"
            ? column + (room.width - length) / 2
            : column;
      const over = length >= room.width - 1e-6 ? 0.05 : 0;
      parts.shapes.push(
        b.prismX(
          [
            [y1 + 0.1, height],
            [y1 - tabWidth, height],
            [y1 - tabWidth, height - Math.min(1, drop)],
            [y1 + 0.1, height - drop],
          ],
          x0 - over,
          x0 + length + over,
        ),
      );
      parts.regions.push({
        tag: "tab",
        box: { min: [x0, y1 - tabWidth, height - drop], max: [x0 + length, y1, height] },
      });
    }
  }
}

// ---------------------------------------------------------------- bin faces and placement

/** What a bin's faces are named by. */
interface BinFaces {
  feature: ResolvedGridfinity;
  bin: BinMeasures;
  holes: FootHoles;
  grip: BinPlan["grip"] | undefined;
  /** A part's nest: its footprint and how far round it the nest's faces reach. */
  nest: BinPlan["footprint"] | undefined;
  reach: number;
  regions: TaggedBox[];
}

/** A bin face's name from a point on it and its normal (null where it is curved). */
function binFaceName(p: Vec3, normal: Vec3 | null, faces: BinFaces): string {
  const { feature, bin, nest, reach, regions } = faces;
  const { width, depth, radius, height } = bin;
  const up = !!normal && normal[2] > 0.99,
    down = !!normal && normal[2] < -0.99;

  if (
    faces.holes.centres.some(([x, y]) => Math.hypot(p[0] - x, p[1] - y) < bin.magnetDiameter / 2 + 1e-3) &&
    p[2] < Math.max(bin.magnetDepth, faces.holes.screwDepth) + 1e-3
  ) {
    return "hole";
  }

  if (down && Math.abs(p[2]) < 1e-6) return "bottom";

  if (p[2] < G.footHeight + 1e-6 && (down || toOutline(p[0], p[1], width, depth, radius) > 1e-3)) {
    return "foot";
  }

  // The groove is the only curved face below the rim (feet and holes are named above).
  if (faces.grip && !normal && p[2] < height) return "grip";

  if (
    nest &&
    p[2] < height - 1e-6 &&
    p[0] > nest.min[0] - reach &&
    p[0] < nest.max[0] + reach &&
    p[1] > nest.min[1] - reach &&
    p[1] < nest.max[1] + reach
  ) {
    return "nest";
  }

  if (up && Math.abs(p[2] - bin.floor) < 1e-6 && !feature.solid) return "floor";

  // A tab's top runs on over the dividers' tops in one face: tabs first.
  const onTop = up && Math.abs(p[2] - height) < 1e-6;

  if (
    onTop &&
    feature.tab &&
    regions.some(
      (r) =>
        r.tag === "tab" &&
        Math.abs(p[1] - (r.box.min[1] + r.box.max[1]) / 2) < (r.box.max[1] - r.box.min[1]) / 2 + 1e-3,
    )
  ) {
    return "tab";
  }

  for (const r of regions) {
    if (inBox(p, r.box)) return r.tag === "tab" && !onTop ? "tab_under" : r.tag;
  }

  if (toOutline(p[0], p[1], width, depth, radius) < 1e-3) return "wall";
  if (up && Math.abs(p[2] - height) < 1e-6) return "top";
  if (bin.lip && p[2] > bin.lipStart - 1e-3) return "lip";

  return "inner";
}

/** Where a bin goes: free on the plane, or in a baseplate's cell on its pockets' floor. */
function binPlacement(
  feature: ResolvedGridfinity,
  frame: PlaneFrame,
  plate: GridRecord | undefined,
  warnings: string[],
): { frame: PlaneFrame; position: [number, number] } {
  if (!plate) return { frame, position: feature.position };

  const [nx, ny] = feature.units;
  const [px, py] = plate.units;
  const [ci, cj] = feature.cell;
  if (ci + nx > px || cj + ny > py) warnings.push(`the bin reaches past the baseplate (${px}×${py} cells)`);

  return {
    frame: {
      ...plate.frame,
      origin: toWorld(plate.frame, [0, 0]).map((v, k) => v + plate.frame.normal[k]! * plate.floor) as Vec3,
    },
    position: [
      plate.position[0] + (ci + nx / 2 - px / 2) * G.pitch,
      plate.position[1] + (cj + ny / 2 - py / 2) * G.pitch,
    ],
  };
}

// ---------------------------------------------------------------- baseplate

/** A baseplate's floor under the pockets and its magnets, refusing floors too thin for its holes. */
function plateMeasures(feature: ResolvedGridfinity): {
  floor: number;
  magnetDiameter: number;
  magnetDepth: number;
} {
  const holes = !!(feature.magnets || feature.screws);
  const floor = feature.floor ?? (holes ? G.plateFloorWithHoles : 0);
  const magnetDiameter = feature.magnetDiameter ?? G.magnetDiameter,
    magnetDepth = feature.magnetDepth ?? G.magnetDepth;
  if (floor < 0) throw new FeatureError("the floor cannot be negative");

  if (feature.magnets && floor < magnetDepth + 0.4) {
    throw new FeatureError(`magnets need a floor of at least ${(magnetDepth + 0.4).toFixed(1)} mm`);
  }

  if (feature.screws && floor < G.plateScrewHead / 2 - G.plateScrewDiameter / 2 + 0.5) {
    throw new FeatureError("countersunk screws need a floor of at least 2.3 mm");
  }

  return { floor, magnetDiameter, magnetDepth };
}

/** A pocket's profile, its top slope carried on above the plate so neighbours meet in a sharp ridge. */
function pocketProfile(floor: number, top: number): [number, number][] {
  const profile: [number, number][] = G.pocket.map(([z, d]) => [floor + z, d] as [number, number]);
  if (floor <= 0) profile.unshift([-0.5, G.pocket[0]![1]]);

  profile.push([top + 0.5, -0.5]);

  return profile;
}

function plateBody(
  oc: OC,
  arena: Arena,
  f: ResolvedGridfinity,
  frame: PlaneFrame,
): { body: Body; record: GridRecord } {
  const b = new Builder(oc, arena);
  // A plain grid of `units` (drawers, outlines and print beds go to areaPlateBodies).
  const units = f.units;
  const outer: [number, number] = [units[0] * G.pitch, units[1] * G.pitch];
  const [nx, ny] = units;
  const { floor, magnetDiameter: magnetD, magnetDepth } = plateMeasures(f);
  const top = floor + G.pocketHeight;
  let shape = b.block(0, 0, outer[0], outer[1], G.plateRadius, 0, top);
  const cells = cellCentres(nx, ny);
  const profile = pocketProfile(floor, top);
  const cuts = cells.map(([cx, cy]) => b.profileSolid(cx, cy, G.pitch, G.pitch, G.plateRadius, profile));
  const holeAt: Vec3[] = [];

  for (const [cx, cy] of cells) {
    if (f.magnets) {
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          const x = cx + sx * G.holeOffset,
            y = cy + sy * G.holeOffset;
          cuts.push(b.cylinderZ(x, y, magnetD / 2, floor - magnetDepth, floor + 0.5));
          holeAt.push([x, y, magnetD / 2]);
        }
      }
    }

    if (f.screws) {
      const k = G.plateScrewHead / 2 - G.plateScrewDiameter / 2;
      cuts.push(b.cylinderZ(cx, cy, G.plateScrewDiameter / 2, -1, floor + 0.5));
      cuts.push(
        b.coneZ(cx, cy, G.plateScrewDiameter / 2, G.plateScrewHead / 2 + 0.5, floor - k, floor + 0.5),
      );
      holeAt.push([cx, cy, G.plateScrewHead / 2]);
    }
  }

  shape = b.unify(b.bool("cut", shape, cuts));

  const local = new Body(oc, arena, f.id, shape);
  const gx = nx * G.pitch,
    gy = ny * G.pitch;
  const name = (p: string) => [`${f.id}.${p}`];
  local.faceTags = local.faces.map((_, i) => {
    const p = local.facePoints[i]!;
    const n = local.faceInfo[i]!.normal;

    if (holeAt.some(([x, y, r]) => Math.hypot(p[0] - x, p[1] - y) < r + 1e-3 && p[2] < floor - 1e-6)) {
      return name("hole");
    }

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

/** A piece of an area plate: its own shape, or (`key`) a copy of an earlier one moved by dx, dy. */
interface PlatePiece {
  col: number;
  row: number;
  shape: TopoDS_Shape;
  key: string | null;
  dx: number;
  dy: number;
}

/** A part of an area plate: its name, its tagged body in the local frame, and its shift. */
interface PlatePart {
  name: string;
  local: Body;
  dx: number;
  dy: number;
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
  feature: ResolvedGridfinity,
  frame: PlaneFrame,
  outline: OutlineRegion[] | undefined,
  warnings: string[],
): { bodies: Body[]; record: GridRecord; info: Record<string, number> } {
  const b = new Builder(oc, arena);
  const regions = cleanOutline(outline);
  const gap = feature.gap ?? 0.5;
  if (gap < 0 || gap > 20) throw new FeatureError("the gap to the edge must be between 0 and 20 mm");

  const area: GridArea = regions
    ? { loops: regions.flatMap((r) => [r.outer, ...r.holes]), gap }
    : feature.drawer
      ? { rect: [feature.drawer[0] - 2 * gap, feature.drawer[1] - 2 * gap] }
      : { rect: [feature.units[0] * G.pitch, feature.units[1] * G.pitch] };
  const fill = feature.fill !== false;
  const plan = checked(() => areaPlan(area, feature.bed?.usable, fill));
  const { floor, magnetDiameter, magnetDepth } = plateMeasures(feature);
  const top = floor + G.pocketHeight;
  const whole = wholePlate(b, plan, regions, fill, gap, top);
  const pocket = cellPocket(b, feature, floor, top, magnetDiameter, magnetDepth);
  // One cell of the plate: a 42 mm square block with its pocket and holes, copied into every cell
  // (whole cells share their side faces, so gluing them is far faster than cutting pockets).
  const cell = b.bool("cut", b.block(0, 0, G.pitch, G.pitch, 0, 0, top), pocket.tools);
  const faces: PlateFaces = {
    plan,
    present: new Set(plan.cells.map(([i, j]) => `${i},${j}`)),
    holeAt: pocket.holeAt,
    floor,
    top,
  };
  const tiles = new PlateTiles(b, plan, cell, whole, top, fill, !!regions);
  const made = plateParts(oc, arena, b, feature.id, tiles.pieces(), !!regions, faces);
  if (!made.length) throw new FeatureError("the baseplate has no material left");

  const position: [number, number] = regions ? [0, 0] : feature.position;
  const bodies = placeParts(oc, arena, b, feature.id, made, b.placement(frame, position));
  // Hundreds of pockets: a lighter view (each pocket's rounded corners in fewer steps).
  if (plan.cells.length > 150) for (const body of bodies) body.displayCoarse = 4;

  // Export: 0.02 mm (0.25 rad) is far below what a printer resolves and needs about a third of the
  // usual triangles (a 3 m × 1.5 m floor stays a file a slicer opens).
  for (const body of bodies) body.exportTolerance = { linear: 0.02, angular: 0.25 };

  if (feature.bed && plan.turned) warnings.push("the pieces fit the print bed turned by 90°");

  const grid: [number, number] = [
    plan.origin[0] + (plan.units[0] * G.pitch) / 2 + position[0],
    plan.origin[1] + (plan.units[1] * G.pitch) / 2 + position[1],
  ];

  return {
    bodies,
    record: { frame, position: grid, units: plan.units, floor },
    info: areaInfo(plan, area, made.length),
  };
}

/** A loop without repeated points (a closing point equal to the first, short arc steps). */
function withoutRepeats(loop: [number, number][]): [number, number][] {
  return loop.filter(
    (p, i) =>
      Math.hypot(p[0] - loop[(i + 1) % loop.length]![0], p[1] - loop[(i + 1) % loop.length]![1]) > 1e-6,
  );
}

/** The outline's regions without repeated points, and without loops that have no area left. */
function cleanOutline(outline: OutlineRegion[] | undefined): OutlineRegion[] | undefined {
  const regions = outline
    ?.map((r) => ({
      outer: withoutRepeats(r.outer),
      holes: r.holes.map(withoutRepeats).filter((h) => h.length >= 3),
    }))
    .filter((r) => r.outer.length >= 3);
  if (regions && !regions.length) throw new FeatureError("the outline has no closed area");

  return regions;
}

/**
 * The whole plate's outline as one solid, cut into tiles later (without the border: none for an
 * outline, where the plate is just its cells, and the grid's rounded rectangle for a rectangle).
 */
function wholePlate(
  b: Builder,
  plan: AreaPlan,
  regions: OutlineRegion[] | undefined,
  fill: boolean,
  gap: number,
  top: number,
): TopoDS_Shape | null {
  if (!regions) {
    return b.block(0, 0, plan.max[0] - plan.min[0], plan.max[1] - plan.min[1], G.plateRadius, 0, top);
  }

  if (!fill) return null;

  const parts = regions
    .map((r) => b.regionSolid(r.outer, r.holes, gap, 0, top))
    .filter((x) => b.volume(x) > 1e-6);
  if (!parts.length) throw new FeatureError("the outline is too small for the gap");

  return parts.length > 1 ? b.bool("fuse", parts[0]!, parts.slice(1)) : parts[0]!;
}

/** One pocket with its holes, centred on the origin: the tools and where the holes are (x, y, radius). */
function cellPocket(
  b: Builder,
  feature: ResolvedGridfinity,
  floor: number,
  top: number,
  magnetDiameter: number,
  magnetDepth: number,
): { tools: TopoDS_Shape[]; holeAt: Vec3[] } {
  const tools = [b.profileSolid(0, 0, G.pitch, G.pitch, G.plateRadius, pocketProfile(floor, top))];
  const holeAt: Vec3[] = [];

  if (feature.magnets) {
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        tools.push(
          b.cylinderZ(
            sx * G.holeOffset,
            sy * G.holeOffset,
            magnetDiameter / 2,
            floor - magnetDepth,
            floor + 0.5,
          ),
        );
        holeAt.push([sx * G.holeOffset, sy * G.holeOffset, magnetDiameter / 2]);
      }
    }
  }

  if (feature.screws) {
    const k = G.plateScrewHead / 2 - G.plateScrewDiameter / 2;
    tools.push(
      b.cylinderZ(0, 0, G.plateScrewDiameter / 2, -1, floor + 0.5),
      b.coneZ(0, 0, G.plateScrewDiameter / 2, G.plateScrewHead / 2 + 0.5, floor - k, floor + 0.5),
    );
    holeAt.push([0, 0, G.plateScrewHead / 2]);
  }

  return { tools, holeAt };
}

/** Centre of the plan's cell (i, j). */
function cellCentre(plan: AreaPlan, i: number, j: number): [number, number] {
  return [plan.origin[0] + (i + 0.5) * G.pitch, plan.origin[1] + (j + 0.5) * G.pitch];
}

/**
 * Cuts an area plate into tiles along the plan's cuts: each tile's cells glued together, and the
 * rest of the tile (the border) joined to them. Rectangles repeat, so a tile equal to an earlier
 * one is that one moved (and meshed only once).
 */
class PlateTiles {
  private readonly cache = new Map<string, { shape: TopoDS_Shape; x0: number; y0: number }>();
  /** The grid's bounds. */
  private readonly gx0: number;
  private readonly gx1: number;
  private readonly gy0: number;
  private readonly gy1: number;
  /** A rectangle plate's size (null for an outline). */
  private readonly rect: { w: number; d: number } | null;

  constructor(
    private readonly b: Builder,
    private readonly plan: AreaPlan,
    private readonly cell: TopoDS_Shape,
    private readonly whole: TopoDS_Shape | null,
    private readonly top: number,
    private readonly fill: boolean,
    private readonly outline: boolean,
  ) {
    this.gx0 = plan.origin[0];
    this.gx1 = plan.origin[0] + plan.units[0] * G.pitch;
    this.gy0 = plan.origin[1];
    this.gy1 = plan.origin[1] + plan.units[1] * G.pitch;
    this.rect = outline ? null : { w: plan.max[0] - plan.min[0], d: plan.max[1] - plan.min[1] };
  }

  /** The pieces column by column, each column from the front; tiles with no material are left out. */
  pieces(): PlatePiece[] {
    const [xs, ys] = this.plan.cuts;
    const pieces: PlatePiece[] = [];

    for (let c = 0; c < xs.length - 1; c++) {
      for (let r = 0; r < ys.length - 1; r++) {
        const piece = this.piece(c, r);
        if (piece) pieces.push(piece);
      }
    }

    return pieces;
  }

  private piece(c: number, r: number): PlatePiece | null {
    const [xs, ys] = this.plan.cuts;
    const x0 = xs[c]!,
      x1 = xs[c + 1]!,
      y0 = ys[r]!,
      y1 = ys[r + 1]!;
    const key = this.outline ? null : this.keyOf(c, r, x0, x1, y0, y1);
    const hit = key ? this.cache.get(key) : undefined;
    if (hit) return { col: c, row: r, shape: hit.shape, key, dx: x0 - hit.x0, dy: y0 - hit.y0 };

    const region = this.regionOf(x0, x1, y0, y1);
    if (region && this.b.volume(region) < 1e-3) return null;

    const inTile = this.plan.cells.filter(([i, j]) => {
      const [cx, cy] = cellCentre(this.plan, i, j);

      return cx > x0 && cx < x1 && cy > y0 && cy < y1;
    });
    const cells = inTile.map(([i, j]) => this.cellCopy(i, j, region));
    const boxes = this.cellBoxes(inTile);
    const border = !this.fill || !region ? null : boxes.length ? this.b.bool("cut", region, boxes) : region;
    const borderParts = border ? this.b.solids(border).filter((x) => this.b.volume(x) > 1e-3) : [];
    const shape = this.join(cells, border, borderParts);
    if (!shape) return null;

    if (key) this.cache.set(key, { shape, x0, y0 });

    return { col: c, row: r, shape, key, dx: 0, dy: 0 };
  }

  /** What makes two rectangle tiles the same: their size, the grid's part in them and their edges. */
  private keyOf(c: number, r: number, x0: number, x1: number, y0: number, y1: number): string {
    const [xs, ys] = this.plan.cuts;

    return [
      x1 - x0,
      y1 - y0,
      Math.max(this.gx0, x0) - x0,
      Math.min(this.gx1, x1) - x0,
      Math.max(this.gy0, y0) - y0,
      Math.min(this.gy1, y1) - y0,
      c === 0,
      c === xs.length - 2,
      r === 0,
      r === ys.length - 2,
    ]
      .map((v) => (typeof v === "number" ? v.toFixed(4) : v))
      .join("|");
  }

  /** The whole plate's part in the tile (all of it when there is one tile). */
  private regionOf(x0: number, x1: number, y0: number, y1: number): TopoDS_Shape | null {
    const [xs, ys] = this.plan.cuts;
    if (!this.whole) return null;
    if (xs.length === 2 && ys.length === 2) return this.whole;

    return this.b.common(
      this.whole,
      this.b.block((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, 0, -1, this.top + 1),
    );
  }

  /** The cell moved to (i, j), clipped where its square reaches past the plate's rounded corners. */
  private cellCopy(i: number, j: number, region: TopoDS_Shape | null): TopoDS_Shape {
    const [cx, cy] = cellCentre(this.plan, i, j);
    const copy = this.b.moved(this.cell, cx, cy, 0, false);

    return region && this.clipped(cx - G.pitch / 2, cy - G.pitch / 2) ? this.b.common(copy, region) : copy;
  }

  /** Whether the cell square from (x, y) reaches past the rectangle plate's rounded corners. */
  private clipped(x: number, y: number): boolean {
    const rect = this.rect;

    return (
      rect !== null &&
      [
        [x, y],
        [x + G.pitch, y],
        [x, y + G.pitch],
        [x + G.pitch, y + G.pitch],
      ].some(([px, py]) => {
        const qx = Math.abs(px!) - (rect.w / 2 - G.plateRadius),
          qy = Math.abs(py!) - (rect.d / 2 - G.plateRadius);

        return qx > 1e-6 && qy > 1e-6 && Math.hypot(qx, qy) > G.plateRadius + 1e-6;
      })
    );
  }

  /** The cells' squares, row by row, runs of neighbouring cells as one box (the border is the rest). */
  private cellBoxes(inTile: [number, number][]): TopoDS_Shape[] {
    const boxes: TopoDS_Shape[] = [];
    const rows = new Map<number, number[]>();
    for (const [i, j] of inTile) rows.set(j, [...(rows.get(j) ?? []), i]);

    for (const [j, columns] of rows) {
      columns.sort((a, z) => a - z);

      for (let start = 0; start < columns.length;) {
        let end = start;
        while (end + 1 < columns.length && columns[end + 1] === columns[end]! + 1) end++;

        const xa = this.plan.origin[0] + columns[start]! * G.pitch,
          xb = this.plan.origin[0] + (columns[end]! + 1) * G.pitch,
          ya = this.plan.origin[1] + j * G.pitch;
        boxes.push(this.b.block((xa + xb) / 2, ya + G.pitch / 2, xb - xa, G.pitch, 0, -1, this.top + 1));
        start = end + 1;
      }
    }

    return boxes;
  }

  /** The tile's cells glued together with its border, or the border alone; null when nothing is left. */
  private join(
    cells: TopoDS_Shape[],
    border: TopoDS_Shape | null,
    borderParts: TopoDS_Shape[],
  ): TopoDS_Shape | null {
    if (!cells.length) return border && borderParts.length ? border : null;

    let grid = cells.length > 1 ? this.b.glue(cells[0]!, cells.slice(1), "BOPAlgo_GlueFull") : cells[0]!;
    if (borderParts.length) grid = this.b.glue(grid, borderParts, "BOPAlgo_GlueShift");

    return this.b.unify(grid);
  }
}

/** What an area plate's faces are named by. */
interface PlateFaces {
  plan: AreaPlan;
  /** The cells with a pocket, as "i,j". */
  present: Set<string>;
  /** A pocket's holes about its centre: x, y, radius. */
  holeAt: Vec3[];
  floor: number;
  top: number;
}

/** An area plate face's name from a point on it and its normal (null where it is curved). */
function plateFaceName(p: Vec3, normal: Vec3 | null, faces: PlateFaces): string {
  const { plan, floor, top } = faces;
  const [xs, ys] = plan.cuts;
  const ci = Math.floor((p[0] - plan.origin[0]) / G.pitch),
    cj = Math.floor((p[1] - plan.origin[1]) / G.pitch);
  const inCell = faces.present.has(`${ci},${cj}`);

  if (inCell && p[2] < floor - 1e-6) {
    const [cx, cy] = cellCentre(plan, ci, cj);
    if (faces.holeAt.some(([x, y, r]) => Math.hypot(p[0] - cx - x, p[1] - cy - y) < r + 1e-3)) return "hole";
  }

  if (normal && normal[2] < -0.99 && Math.abs(p[2]) < 1e-6) return "bottom";
  if (normal && normal[2] > 0.99 && Math.abs(p[2] - top) < 1e-6) return "top";

  if (
    normal &&
    Math.abs(normal[2]) < 1e-6 &&
    ((Math.abs(normal[0]) > 0.99 && onInnerCut(p[0], xs)) ||
      (Math.abs(normal[1]) > 0.99 && onInnerCut(p[1], ys)))
  ) {
    return "joint";
  }

  if (normal && normal[2] > 0.99 && Math.abs(p[2] - floor) < 1e-6 && floor > 0) return "floor";
  // Pockets (and the walls of their holes) lie inside their cell.
  if (inCell) return "pocket";

  return "side";
}

/** Whether v lies on one of the cuts between pieces (not the plate's ends). */
const onInnerCut = (v: number, cuts: number[]) => cuts.slice(1, -1).some((c) => Math.abs(v - c) < 1e-6);

/**
 * Parts: one per piece (a piece an outline splits in two gives two). Copies share the tagged
 * local body of the piece they copy and are only placed further along.
 */
function plateParts(
  oc: OC,
  arena: Arena,
  b: Builder,
  id: string,
  pieces: PlatePiece[],
  outline: boolean,
  faces: PlateFaces,
): PlatePart[] {
  const locals = new Map<string, Body[]>();
  const made: PlatePart[] = [];

  for (const piece of pieces) {
    let bodies = piece.key ? locals.get(piece.key) : undefined;

    if (!bodies) {
      const solids = outline ? b.solids(piece.shape).filter((x) => b.volume(x) > 1e-3) : [piece.shape];
      bodies = solids.map((solid) => {
        const body = new Body(oc, arena, id, solid);
        body.faceTags = body.faces.map((_, i) => [
          `${id}.${plateFaceName(body.facePoints[i]!, body.faceInfo[i]!.normal, faces)}`,
        ]);

        return body;
      });
      if (piece.key) locals.set(piece.key, bodies);
    }

    bodies.forEach((local, k) =>
      made.push({
        name: `${pieceName(piece.col, piece.row)}${k ? `_${k + 1}` : ""}`,
        local,
        dx: piece.dx,
        dy: piece.dy,
      }),
    );
  }

  return made;
}

/** The parts placed on the plane, copies moved on by their shift; named as areaPlateBodies describes. */
function placeParts(oc: OC, arena: Arena, b: Builder, id: string, made: PlatePart[], trsf: gp_Trsf): Body[] {
  return made.map((part) => {
    let placement = trsf;

    if (part.dx || part.dy) {
      const shift = arena.track(new oc.gp_Trsf());
      shift.SetTranslation(arena.track(new oc.gp_Vec(part.dx, part.dy, 0)));
      placement = arena.track(trsf.Multiplied(shift));
    }

    return b.place(part.local, placement, made.length > 1 ? `${id}_${part.name}` : id, false);
  });
}

/** Sizes for the dialog: cells, pieces, the plate's and the largest piece's size, the border. */
function areaInfo(plan: AreaPlan, area: GridArea, pieces: number): Record<string, number> {
  const [xs, ys] = plan.cuts;
  const plate = [plan.max[0] - plan.min[0], plan.max[1] - plan.min[1]];
  const info: Record<string, number> = {
    cells: plan.cells.length,
    cellsX: plan.units[0],
    cellsY: plan.units[1],
    pieces,
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

  return info;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------- labels

/**
 * A label: rounded plate, symbol on the left, text in the rest (as large as fits unless sized).
 * Returns the plate (with the marking joined or cut) and, with `separate`, the marking alone.
 */
export function labelBodies(
  oc: OC,
  arena: Arena,
  f: ResolvedLabel,
  frame: PlaneFrame,
  warnings: string[],
): Body[] {
  const b = new Builder(oc, arena);
  const { width: W, height: H, thickness: T, depth: d } = f;
  if (!(W >= 4 && H >= 4)) throw new FeatureError("a label must be at least 4 × 4 mm");
  if (!(T > 0)) throw new FeatureError("the label's thickness must be greater than zero");
  if (!(d > 0)) throw new FeatureError("the marking's depth must be greater than zero");

  const engraved = f.style === "engraved";

  if (engraved && d >= T - 0.2) {
    throw new FeatureError(
      `engraving must stay under ${(T - 0.2).toFixed(1)} mm deep (the label is ${T} mm thick)`,
    );
  }

  const margin = Math.min(1.2, H * 0.12);
  const avail: [number, number] = [W - 2 * margin, H - 2 * margin];
  const loops: [number, number][][] = [];
  let x = -W / 2 + margin;
  const symbol = f.symbol && f.symbol !== "none" ? labelSymbol(f.symbol) : null;
  const text = f.text?.trim() ? f.text : "";

  if (symbol) {
    let s = avail[1];

    if (symbol.width * s > (text ? avail[0] * 0.45 : avail[0])) {
      s = (text ? avail[0] * 0.45 : avail[0]) / symbol.width;
    }

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
      const xs = r.loops.flat().map((p) => p[0]),
        ys = r.loops.flat().map((p) => p[1]);

      return { ...r, min: [Math.min(...xs), Math.min(...ys)], max: [Math.max(...xs), Math.max(...ys)] };
    };

    let m = measure(first);
    if (!m.loops.length) throw new FeatureError("the text has no letters to draw");

    const scale = Math.min(1, room[0] / (m.max[0]! - m.min[0]!), room[1] / (m.max[1]! - m.min[1]!));

    if (scale < 0.999) {
      if (f.size !== undefined) {
        warnings.push(`the text is smaller than ${f.size} mm so it fits on the label`);
      }

      m = measure(first * scale * 0.995);
    }

    if (m.missing.length) warnings.push(`the font has no ${m.missing.map((c) => `"${c}"`).join(", ")}`);

    const cx = symbol ? x + room[0] / 2 : 0;
    const ox = cx - (m.min[0]! + m.max[0]!) / 2,
      oy = -(m.min[1]! + m.max[1]!) / 2;
    for (const loop of m.loops) loops.push(loop.map(([u, v]) => [u + ox, v + oy] as [number, number]));
  }

  if (!loops.length) throw new FeatureError("a label needs a text or a symbol");

  // Clean outlines: no repeated points.
  const clean = loops.map(withoutRepeats).filter((l) => l.length >= 3);
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
    const deeper = marks.map((shape) => {
      const t = arena.track(new oc.gp_Trsf());
      t.SetTranslation(arena.track(new oc.gp_Vec(0, 0, 0.01)));

      return arena.track(arena.track(new oc.BRepBuilderAPI_Transform(shape, t, true, false)).Shape());
    });
    base = b.bool("cut", plate, [b.compound(marks), b.compound(deeper)]);
  } else {
    base = f.separate ? plate : b.bool("fuse", plate, [mark]);
  }

  const tag = (body: Body, isMark: boolean) => {
    body.faceTags = body.faces.map((_, i) => {
      const p = body.facePoints[i]!;
      const n = body.faceInfo[i]!.normal;
      const id = f.id;
      if (isMark) return [`${id}.mark`];
      if (n && n[2] < -0.99 && Math.abs(p[2]) < 1e-6) return [`${id}.bottom`];
      if (n && n[2] > 0.99 && Math.abs(p[2] - T) < 1e-6) return [`${id}.top`];

      if (
        p[2] < T + 1e-6 &&
        toOutline(p[0], p[1], W, H, Math.min(f.corner, W / 2 - 0.01, H / 2 - 0.01)) < 1e-3
      ) {
        return [`${id}.side`];
      }

      return [`${id}.mark`];
    });

    return body;
  };

  const trsf = b.placement(frame, f.position, f.angle);
  const out = [b.place(tag(new Body(oc, arena, f.id, b.unify(base)), false), trsf, f.id)];

  if (f.separate) {
    out.push(b.place(tag(new Body(oc, arena, `${f.id}_mark`, b.unify(mark)), true), trsf, `${f.id}_mark`));
  }

  return out;
}
