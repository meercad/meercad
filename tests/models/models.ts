/**
 * Test models from simple to complex. Each one is a real design a person would make, with what it
 * must come out as: the number of parts, its volume (worked out by hand where the shape allows it)
 * and its size. `tests/acceptance/models.test.ts` rebuilds them all; with MEERCAD_MODELS_OUT set it
 * also writes them as .meercad files to look at in the app (docs/TESTING.md).
 */
import { GEAR_DEFAULTS, gearShape, outlineArea, type GearParams } from "@meercad/model";
import type { Feature, GearFeature, MeercadDocument, SketchEntity } from "@meercad/schema";
import { circle, rect, sketch } from "../acceptance/helpers.js";
import { cornerEdit, offsetCurves, splinePoints, type SketchData, type Vec2 } from "@meercad/sketch";
import { readFileSync } from "node:fs";

export interface Expectation {
  bodies: number;
  /** Volume in mm³: exact (checked to 0.5 %) or a range. */
  volume?: number | [number, number];
  /** Size of the model's bounding box in mm (checked to 0.05 mm). */
  size?: [number, number, number];
}

export interface TestModel {
  file: string;
  name: string;
  /** What a person checks when looking at it. */
  look: string;
  doc: MeercadDocument;
  expect: Expectation;
  /** Parameter changes the model must survive, each with its own expectation. */
  variants?: { params: Record<string, string | number>; expect: Expectation }[];
}

const PI = Math.PI;
const gear = (id: string, g: Partial<GearFeature>): GearFeature => ({ id, op: "gear", kind: "spur", teeth: 20, width: 10, mode: "new_body", ...g });
/** Area of a gear's cross-section (outline minus a ring gear's toothed hole). */
const gearArea = (g: Partial<GearParams>, rim?: number) => {
  const shape = gearShape({ kind: "spur", module: 1, teeth: 20, herringbone: false, ...GEAR_DEFAULTS, ...g }, rim === undefined ? {} : { rim });
  // A ring gear's outside is a true circle.
  return shape.inner ? PI * (rim! / 2) ** 2 - outlineArea(shape.inner) : outlineArea(shape.outer);
};
const doc = (features: Feature[], params: Record<string, string | number> = {}): MeercadDocument => ({ format: "meercad/1", params, features, rollback: null });

/** A regular polygon with a corner on +X. */
function polygon(prefix: string, cx: number, cy: number, r: number, n: number): SketchEntity[] {
  const pts: SketchEntity[] = [];
  const lines: SketchEntity[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * PI * i) / n;
    pts.push({ id: `${prefix}p${i}`, type: "point", x: +(cx + r * Math.cos(a)).toFixed(6), y: +(cy + r * Math.sin(a)).toFixed(6) });
    lines.push({ id: `${prefix}${i}`, type: "line", p1: `${prefix}p${i}`, p2: `${prefix}p${(i + 1) % n}` });
  }
  return [...pts, ...lines];
}
/** A flat link from p to q: a bar `w` wide with round ends and a hole of radius `r` at each end. */
function link(prefix: string, p: [number, number], q: [number, number], w: number, r: number): SketchEntity[] {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const l = Math.hypot(dx, dy);
  const [nx, ny] = [(-dy / l) * (w / 2), (dx / l) * (w / 2)];
  const round = (v: number) => +v.toFixed(6);
  return [
    { id: `${prefix}p1`, type: "point", x: round(p[0] + nx), y: round(p[1] + ny) },
    { id: `${prefix}p2`, type: "point", x: round(q[0] + nx), y: round(q[1] + ny) },
    { id: `${prefix}p3`, type: "point", x: round(q[0] - nx), y: round(q[1] - ny) },
    { id: `${prefix}p4`, type: "point", x: round(p[0] - nx), y: round(p[1] - ny) },
    { id: `${prefix}cp`, type: "point", x: round(p[0]), y: round(p[1]) },
    { id: `${prefix}cq`, type: "point", x: round(q[0]), y: round(q[1]) },
    { id: `${prefix}l1`, type: "line", p1: `${prefix}p1`, p2: `${prefix}p2` },
    { id: `${prefix}a1`, type: "arc", center: `${prefix}cq`, start: `${prefix}p3`, end: `${prefix}p2` },
    { id: `${prefix}l2`, type: "line", p1: `${prefix}p3`, p2: `${prefix}p4` },
    { id: `${prefix}a2`, type: "arc", center: `${prefix}cp`, start: `${prefix}p1`, end: `${prefix}p4` },
    { id: `${prefix}h1`, type: "circle", center: `${prefix}cp`, radius: r },
    { id: `${prefix}h2`, type: "circle", center: `${prefix}cq`, radius: r },
  ];
}
/** A closed polyline through the points. */
function polyline(prefix: string, points: [number, number][]): SketchEntity[] {
  return [
    ...points.map(([x, y], i): SketchEntity => ({ id: `${prefix}p${i}`, type: "point", x, y })),
    ...points.map((_, i): SketchEntity => ({ id: `${prefix}${i}`, type: "line", p1: `${prefix}p${i}`, p2: `${prefix}p${(i + 1) % points.length}` })),
  ];
}
const hexArea = (r: number) => ((3 * Math.sqrt(3)) / 2) * r * r;
/** Circumradius of a hexagon from its width across flats. */
const acrossFlats = (s: number) => s / Math.sqrt(3);
const edge = (a: string, b: string) => ({ edge: [a, b] as [string, string] });

/** Model 24's mounting plate with standard holes (used again by model 32). */
const HOLE_PLATE: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 80, 40)),
  { id: "ex1", op: "extrude", name: "Plate", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "ho1", op: "hole", name: "Cap screws", plane: { face: { face: "ex1.end_cap" } }, points: [[10, 10], [10, 30]], kind: "counterbore", size: "M4" },
  { id: "ho2", op: "hole", name: "Flat head", plane: { face: { face: "ex1.end_cap" } }, points: [[35, 20]], kind: "countersink", size: "M3" },
  { id: "ho3", op: "hole", name: "Inserts", plane: { face: { face: "ex1.end_cap" } }, points: [[55, 10], [55, 30]], kind: "insert", size: "M3" },
  { id: "ho4", op: "hole", name: "Tapped", plane: { face: { face: "ex1.end_cap" } }, points: [[70, 20]], kind: "tapped", size: "M5", depth: 8 },
];
/** Plate minus the holes worked out by hand; the tapped hole lies between its tap drill and nominal size. */
const HOLE_PLATE_VOLUME = ((): [number, number] => {
  const cb = 2 * PI * (4 ** 2 * 4.4 + 2.25 ** 2 * 5.6);
  const R = 7.12 / 2;
  const h = R - 1.7;
  const cs = (PI * h * (R * R + R * 1.7 + 1.7 * 1.7)) / 3 + PI * 1.7 ** 2 * (10 - h);
  const ins = 2 * PI * 2 ** 2 * 6.7;
  const rest = 80 * 40 * 10 - cb - cs - ins;
  return [rest - PI * 2.5 ** 2 * 8, rest - PI * 2.1 ** 2 * 8];
})();

export const MODELS: TestModel[] = [
  {
    file: "01 Wuerfel",
    name: "Cube",
    look: "A 20 mm cube standing on the grid at the origin, six flat faces.",
    doc: doc([sketch("sk1", { ref: "origin.XY" }, rect("l", -10, -10, 20, 20)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" }]),
    expect: { bodies: 1, volume: 8000, size: [20, 20, 20] },
  },
  {
    file: "02 Lochplatte",
    name: "Plate with four holes",
    look: "60 × 40 × 5 plate, four round through holes 8 mm in from the corners.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 60, 40), ...circle("h1", 8, 8, 2.5), ...circle("h2", 52, 8, 2.5), ...circle("h3", 8, 32, 2.5), ...circle("h4", 52, 32, 2.5)]),
      { id: "ex1", op: "extrude", name: "Plate", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
    ]),
    expect: { bodies: 1, volume: 60 * 40 * 5 - 4 * PI * 2.5 ** 2 * 5, size: [60, 40, 5] },
  },
  {
    file: "03 Zylinder gefast",
    name: "Chamfered cylinder",
    look: "Ø30 × 20 cylinder with a 2 mm 45° chamfer around the top edge only; round, no facets.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, circle("c1", 0, 0, 15)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
      { id: "ch1", op: "chamfer", edges: edge("ex1.end_cap", "ex1.side[sk1.c1]"), distance: 2 },
    ]),
    // The chamfer removes a triangle (area 2) swept around at its centroid radius 15 − 2/3.
    expect: { bodies: 1, volume: PI * 225 * 20 - 2 * PI * (15 - 2 / 3) * 2, size: [30, 30, 20] },
  },
  {
    file: "04 Block abgerundet",
    name: "Rounded block",
    look: "40 × 30 × 10 block, the four vertical edges rounded with r 5; top and bottom edges sharp.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
      {
        id: "fi1",
        op: "fillet",
        name: "Round corners",
        edges: [edge("ex1.side[sk1.l1]", "ex1.side[sk1.l2]"), edge("ex1.side[sk1.l2]", "ex1.side[sk1.l3]"), edge("ex1.side[sk1.l3]", "ex1.side[sk1.l4]"), edge("ex1.side[sk1.l4]", "ex1.side[sk1.l1]")],
        radius: 5,
      },
    ]),
    expect: { bodies: 1, volume: 40 * 30 * 10 - 4 * 10 * (25 - (25 * PI) / 4), size: [40, 30, 10] },
  },
  {
    file: "05 Schale offen",
    name: "Open tray",
    look: "50 × 40 × 30 box hollowed with 2 mm walls, open at the top, closed floor.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 50, 40)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
      { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 },
    ]),
    expect: { bodies: 1, volume: 50 * 40 * 30 - 46 * 36 * 28, size: [50, 40, 30] },
  },
  {
    file: "06 Rohr gedreht",
    name: "Revolved tube",
    look: "Tube Ø30 outside, Ø20 inside, 20 tall, made by revolving a rectangle around Z; perfectly round.",
    doc: doc([
      sketch("sk1", { ref: "origin.XZ" }, [...rect("l", 10, 0, 5, 20), { id: "a1", type: "point", x: 0, y: 0 }, { id: "a2", type: "point", x: 0, y: 10 }, { id: "ax", type: "line", p1: "a1", p2: "a2", construction: true }]),
      { id: "rv1", op: "revolve", profile: { sketch: "sk1" }, axis: { line: "sk1.ax" }, angle: 360, mode: "new_body" },
    ]),
    expect: { bodies: 1, volume: PI * (225 - 100) * 20, size: [30, 30, 20] },
  },
  {
    file: "07 Flansch Lochkreis",
    name: "Flange with bolt circle",
    look: "Ø60 × 6 disc, Ø20 bore, six Ø5 holes evenly on a Ø44 circle, all through.",
    doc: doc(
      [
        sketch("sk1", { ref: "origin.XY" }, [{ id: "o", type: "point", x: 0, y: 0 }, { id: "c1", type: "circle", center: "o", radius: 30 }, { id: "c2", type: "circle", center: "o", radius: 10 }]),
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 6, mode: "new_body" },
        sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("h", 22, 0, 2.5)),
        { id: "ex2", op: "extrude", name: "Bolt hole", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, flip: true, mode: "cut" },
        { id: "cp1", op: "circular_pattern", source: { features: ["ex2"] }, axis: { ref: "origin.Z" }, count: "holes" },
      ],
      { holes: 6 },
    ),
    expect: { bodies: 1, volume: PI * (900 - 100) * 6 - 6 * PI * 6.25 * 6, size: [60, 60, 6] },
    variants: [{ params: { holes: 8 }, expect: { bodies: 1, volume: PI * (900 - 100) * 6 - 8 * PI * 6.25 * 6 } }],
  },
  {
    file: "08 Stiftleiste",
    name: "Pin strip",
    look: "100 × 20 × 3 strip with five Ø4 pins, 6 tall, 20 mm apart along X.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 100, 20)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 3, mode: "new_body" },
      sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c", 10, 10, 2)),
      { id: "ex2", op: "extrude", name: "Pin", profile: { sketch: "sk2" }, extent: "blind", distance: 6, mode: "join" },
      { id: "lp1", op: "linear_pattern", source: { features: ["ex2"] }, direction: { ref: "origin.X" }, count: 5, spacing: 20 },
    ]),
    expect: { bodies: 1, volume: 100 * 20 * 3 + 5 * PI * 4 * 6, size: [100, 20, 9] },
  },
  {
    file: "09 T-Profil gespiegelt",
    name: "Mirrored T profile",
    look: "An L angle mirrored across the YZ plane and joined into one T: 80 wide, 30 tall, 30 deep, no seam.",
    doc: doc([
      sketch("sk1", { ref: "origin.XZ" }, polyline("l", [[0, 0], [40, 0], [40, 4], [4, 4], [4, 30], [0, 30]])),
      { id: "ex1", op: "extrude", name: "Angle", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
      { id: "mi1", op: "mirror", source: { bodies: ["ex1"] }, plane: { ref: "origin.YZ" } },
      { id: "bo1", op: "boolean", operation: "union", target: "ex1", tools: ["mi1_1"] },
    ]),
    expect: { bodies: 1, volume: 2 * (40 * 4 + 4 * 26) * 30, size: [80, 30, 30] },
  },
  {
    file: "10 Schraube M8",
    name: "M8 bolt",
    look: "Hex head (13 across flats, 5.5 tall) under the grid, M8 shaft 20 long with a real 16 mm thread.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, circle("c1", 0, 0, 4)),
      { id: "ex1", op: "extrude", name: "Shaft", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
      sketch("sk2", { ref: "origin.XY" }, polygon("h", 0, 0, acrossFlats(13), 6)),
      { id: "ex2", op: "extrude", name: "Head", profile: { sketch: "sk2" }, extent: "blind", distance: 5.5, flip: true, mode: "join" },
      { id: "th1", op: "thread", face: { face: "ex1.side[sk1.c1]" }, length: 16 },
    ]),
    expect: { bodies: 1, volume: [hexArea(acrossFlats(13)) * 5.5 + PI * 16 * 4, hexArea(acrossFlats(13)) * 5.5 + PI * 16 * 20], size: [acrossFlats(13) * 2, 13, 25.5] },
  },
  {
    file: "11 Mutter M8",
    name: "M8 nut",
    look: "Hex nut 13 across flats, 6.5 tall, with a real M8 internal thread through it.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...polygon("h", 0, 0, acrossFlats(13), 6), ...circle("b", 0, 0, 4)]),
      { id: "ex1", op: "extrude", name: "Nut", profile: { sketch: "sk1" }, extent: "blind", distance: 6.5, mode: "new_body" },
      { id: "th1", op: "thread", face: { face: "ex1.side[sk1.b]" } },
    ]),
    // The thread fills the Ø8 bore back towards the Ø6.647 minor diameter.
    expect: { bodies: 1, volume: [(hexArea(acrossFlats(13)) - PI * 16) * 6.5, (hexArea(acrossFlats(13)) - PI * (6.647 / 2) ** 2) * 6.5], size: [acrossFlats(13) * 2, 13, 6.5] },
  },
  {
    file: "12 Boolesch und Kopie",
    name: "Boolean and copy",
    look: "Two 30 mm cubes side by side: the left one has a Ø16 hole straight through, the copy on the right is solid.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", -15, -15, 30, 30)),
      { id: "ex1", op: "extrude", name: "Cube", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
      { id: "pl1", op: "plane", name: "Below", base: { ref: "origin.XY" }, offset: -10 },
      sketch("sk2", { ref: "pl1" }, circle("c", 0, 0, 8)),
      { id: "ex2", op: "extrude", name: "Pin", profile: { sketch: "sk2" }, extent: "blind", distance: 50, mode: "new_body" },
      { id: "mv1", op: "transform", bodies: ["ex1"], translate: [45, 0, 0], copy: true },
      { id: "bo1", op: "boolean", operation: "subtract", target: "ex1", tools: ["ex2"] },
    ]),
    expect: { bodies: 2, volume: 2 * 27000 - PI * 64 * 30, size: [75, 30, 30] },
  },
  {
    file: "13 Abstandshalter symmetrisch",
    name: "Symmetric spacer",
    look: "Hex spacer, 12 across corners, Ø5 bore, 20 long, centred on the XY plane (10 above, 10 below).",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...polygon("h", 0, 0, 6, 6), ...circle("b", 0, 0, 2.5)]),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "symmetric", distance: 20, mode: "new_body" },
    ]),
    expect: { bodies: 1, volume: (hexArea(6) - PI * 6.25) * 20, size: [12, 6 * Math.sqrt(3), 20] },
  },
  {
    file: "14 Block mit Tasche",
    name: "Block with pocket",
    look: "60 × 40 × 15 block, 1 mm chamfer around the top, a 30 × 20 pocket 5 deep centred in the top.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 60, 40)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 15, mode: "new_body" },
      { id: "ch1", op: "chamfer", edges: { select: "edges", of: "ex1", where: { face: "end_cap" } }, distance: 1 },
      sketch("sk2", { face: { face: "ex1.end_cap" } }, rect("p", 15, 10, 30, 20)),
      { id: "ex2", op: "extrude", name: "Pocket", profile: { sketch: "sk2" }, extent: "blind", distance: 5, flip: true, mode: "cut" },
    ]),
    // Chamfer: a 0.5 mm² triangle along the 200 mm top edge (the corners cancel out exactly).
    expect: { bodies: 1, volume: 60 * 40 * 15 - 0.5 * 200 - 30 * 20 * 5, size: [60, 40, 15] },
  },
  {
    file: "15 Zahnrad parametrisch",
    name: "Parametric toothed wheel",
    look: "Ø40 × 6 wheel with an Ø8 bore and 12 square teeth around it; set teeth to 8 in Variables and it updates.",
    doc: doc(
      [
        sketch("sk1", { ref: "origin.XY" }, [{ id: "o", type: "point", x: 0, y: 0 }, { id: "c1", type: "circle", center: "o", radius: 20 }, { id: "c2", type: "circle", center: "o", radius: 4 }]),
        { id: "ex1", op: "extrude", name: "Wheel", profile: { sketch: "sk1" }, extent: "blind", distance: "thickness", mode: "new_body" },
        sketch("sk2", { ref: "origin.XY" }, rect("t", 19, -2, 5, 4)),
        { id: "ex2", op: "extrude", name: "Tooth", profile: { sketch: "sk2" }, extent: "blind", distance: "thickness", mode: "join" },
        { id: "cp1", op: "circular_pattern", source: { features: ["ex2"] }, axis: { ref: "origin.Z" }, count: "teeth" },
      ],
      { teeth: 12, thickness: "6 mm" },
    ),
    expect: { bodies: 1, volume: [PI * (400 - 16) * 6 + 12 * 4 * 4 * 6, PI * (400 - 16) * 6 + 12 * 5 * 4 * 6], size: [48, 48, 6] },
    variants: [
      { params: { teeth: 8 }, expect: { bodies: 1, volume: [PI * (400 - 16) * 6 + 8 * 4 * 4 * 6, PI * (400 - 16) * 6 + 8 * 5 * 4 * 6] } },
      { params: { thickness: "10 mm" }, expect: { bodies: 1, size: [48, 48, 10] } },
    ],
  },
  {
    file: "16 Gehaeuse mit Deckel",
    name: "Enclosure with lid",
    look: "Rounded 80 × 50 × 30 box, 2 mm walls, open top, four screw bosses inside; a matching rounded 2 mm lid floats 10 mm above.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", -40, -25, 80, 50)),
      { id: "ex1", op: "extrude", name: "Box", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
      {
        id: "fi1",
        op: "fillet",
        name: "Round corners",
        edges: [edge("ex1.side[sk1.l1]", "ex1.side[sk1.l2]"), edge("ex1.side[sk1.l2]", "ex1.side[sk1.l3]"), edge("ex1.side[sk1.l3]", "ex1.side[sk1.l4]"), edge("ex1.side[sk1.l4]", "ex1.side[sk1.l1]")],
        radius: 5,
      },
      { id: "sh1", op: "shell", name: "Hollow", faces: [{ face: "ex1.end_cap" }], thickness: 2 },
      { id: "pl1", op: "plane", name: "Floor", base: { ref: "origin.XY" }, offset: 2 },
      sketch("sk2", { ref: "pl1" }, [...circle("b1", -32, -17, 3), ...circle("i1", -32, -17, 1.25)]),
      { id: "ex2", op: "extrude", name: "Boss", profile: { sketch: "sk2" }, extent: "blind", distance: 26, mode: "join" },
      { id: "lp1", op: "linear_pattern", name: "Bosses", source: { features: ["ex2"] }, direction: { ref: "origin.X" }, count: 2, spacing: 64, direction2: { ref: "origin.Y" }, count2: 2, spacing2: 34 },
      { id: "pl2", op: "plane", name: "Lid plane", base: { ref: "origin.XY" }, offset: 40 },
      sketch("sk3", { ref: "pl2" }, rect("m", -40, -25, 80, 50)),
      { id: "ex3", op: "extrude", name: "Lid", profile: { sketch: "sk3" }, extent: "blind", distance: 2, mode: "new_body" },
      {
        id: "fi2",
        op: "fillet",
        name: "Round lid",
        edges: [edge("ex3.side[sk3.m1]", "ex3.side[sk3.m2]"), edge("ex3.side[sk3.m2]", "ex3.side[sk3.m3]"), edge("ex3.side[sk3.m3]", "ex3.side[sk3.m4]"), edge("ex3.side[sk3.m4]", "ex3.side[sk3.m1]")],
        radius: 5,
      },
    ]),
    expect: { bodies: 2, size: [80, 50, 42] },
  },
  {
    file: "17 Stirnrad",
    name: "Spur gear with bore",
    look: "Involute spur gear, 20 teeth, module 2 (44 mm across the tips), 10 mm wide, Ø8 bore. Smooth curved flanks, flat tips, rounded-off roots.",
    doc: doc([gear("gr1", { module: "m", teeth: "z", width: 10, bore: { diameter: 8 } })], { m: 2, z: 20 }),
    expect: { bodies: 1, volume: (gearArea({ module: 2, teeth: 20 }) - PI * 16) * 10, size: [44, 44, 10] },
    variants: [
      { params: { z: 21 }, expect: { bodies: 1, volume: (gearArea({ module: 2, teeth: 21 }) - PI * 16) * 10 } },
      { params: { m: "1.5 mm" }, expect: { bodies: 1, volume: (gearArea({ module: 1.5, teeth: 20 }) - PI * 16) * 10 } },
    ],
  },
  {
    file: "18 Zahnradpaar",
    name: "Gear pair 1:2",
    look: "A 15-tooth pinion and a 30-tooth gear (module 1.5, 8 mm wide) 33.75 mm apart, 30° round from the pinion. Teeth sit in gaps with a hair of play; nothing touches.",
    doc: {
      ...doc([
        gear("gr1", { name: "Pinion", module: 1.5, teeth: 15, width: 8, bore: { diameter: 5, shape: "d_flat", flat: 4.5, allowance: 0.15 } }),
        gear("gr2", { name: "Gear", teeth: 30, width: 8, meshWith: { gear: "gr1", direction: 30 }, bore: { diameter: 8 } }),
      ]),
      mechanism: {
        joints: [
          { id: "j1", name: "Pinion", type: "revolute", a: "gr1", b: "ground", anchor: { gear: "gr1" } },
          { id: "j2", name: "Gear", type: "revolute", a: "gr2", b: "ground", anchor: { gear: "gr2" } },
        ],
        couplings: [{ id: "c1", driver: "j1", driven: "j2", ratio: -0.5 }],
      },
    },
    expect: { bodies: 2, volume: [(gearArea({ module: 1.5, teeth: 15 }) - PI * 2.65 ** 2 + gearArea({ module: 1.5, teeth: 30 }) - PI * 16) * 8, (gearArea({ module: 1.5, teeth: 15 }) - PI * 2.5 ** 2 + gearArea({ module: 1.5, teeth: 30 }) - PI * 16) * 8 + 1] },
  },
  {
    file: "19 Pfeilradpaar",
    name: "Herringbone pair with chamfered teeth",
    look: "Two herringbone gears (20 and 13 teeth, module 2, 30°, 12 mm wide): the teeth form a V that points the same way on both, and the tooth tips are chamfered 0.6 mm at both faces.",
    doc: doc([
      gear("gr1", { module: 2, teeth: 20, width: 12, helix: 30, herringbone: true, chamfer: 0.6 }),
      gear("gr2", { teeth: 13, width: 12, meshWith: { gear: "gr1" }, chamfer: 0.6 }),
    ]),
    expect: {
      bodies: 2,
      volume: [(gearArea({ module: 2, teeth: 20, helix: 30 }) + gearArea({ module: 2, teeth: 13, helix: -30 })) * 12 * 0.97, (gearArea({ module: 2, teeth: 20, helix: 30 }) + gearArea({ module: 2, teeth: 13, helix: -30 })) * 12],
    },
  },
  {
    file: "20 Planetengetriebe",
    name: "Planetary gear set",
    look: "Ring gear (60 teeth, module 1, Ø70) with three 18-tooth planets at 0°, 120° and 240° and a 24-tooth sun in the middle; every pair meshes, nothing overlaps.",
    doc: doc([
      gear("gr1", { name: "Ring", kind: "internal", module: 1, teeth: 60, width: 6, rim: 70 }),
      gear("gr2", { name: "Planet 1", teeth: 18, width: 6, meshWith: { gear: "gr1", direction: 0 } }),
      gear("gr3", { name: "Planet 2", teeth: 18, width: 6, meshWith: { gear: "gr1", direction: 120 } }),
      gear("gr4", { name: "Planet 3", teeth: 18, width: 6, meshWith: { gear: "gr1", direction: 240 } }),
      gear("gr5", { name: "Sun", teeth: 24, width: 6, meshWith: { gear: "gr2", direction: 180 }, bore: { diameter: 5 } }),
    ]),
    expect: {
      bodies: 5,
      volume: (gearArea({ kind: "internal", teeth: 60 }, 70) + 3 * gearArea({ teeth: 18 }) + gearArea({ teeth: 24 }) - PI * 6.25) * 6,
      size: [70, 70, 6],
    },
  },
  {
    file: "21 Zahnstange mit Ritzel",
    name: "Rack and pinion",
    look: "A 94.2 mm rack (20 teeth, module 1.5, 6 mm back) with a 16-tooth pinion sitting on its middle; the pinion's teeth reach into the rack's gaps.",
    doc: doc([
      gear("gr1", { name: "Rack", kind: "rack", module: 1.5, teeth: 20, width: 8, rim: 6 }),
      gear("gr2", { name: "Pinion", teeth: 16, width: 8, meshWith: { gear: "gr1" }, bore: { diameter: 5 } }),
    ]),
    expect: { bodies: 2, volume: (gearArea({ kind: "rack", module: 1.5, teeth: 20 }, 6) + gearArea({ module: 1.5, teeth: 16 }) - PI * 6.25) * 8 },
  },
  {
    file: "22 Scharnier",
    name: "Hinged lid",
    look: "A 60 × 40 × 20 box and a 60 × 40 × 3 lid on top, joined by a Ø5 pin along the back edge. Joints panel: dragging the lid swings it up about the pin, from 0° to 110°, and no further.",
    doc: {
      ...doc([
        sketch("sk1", { ref: "origin.XY" }, rect("l", -30, -20, 60, 40)),
        { id: "ex1", op: "extrude", name: "Box", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
        { id: "pl1", op: "plane", name: "Lid plane", base: { ref: "origin.XY" }, offset: 20 },
        sketch("sk2", { ref: "pl1" }, rect("m", -30, -20, 60, 40)),
        { id: "ex2", op: "extrude", name: "Lid", profile: { sketch: "sk2" }, extent: "blind", distance: 3, mode: "new_body" },
        { id: "pl2", op: "plane", name: "Pin plane", base: { ref: "origin.YZ" }, offset: -30 },
        sketch("sk3", { ref: "pl2" }, circle("c1", 20, 20, 2.5)),
        { id: "ex3", op: "extrude", name: "Pin", profile: { sketch: "sk3" }, extent: "blind", distance: 60, mode: "new_body" },
      ]),
      mechanism: {
        joints: [
          { id: "j1", name: "Pin", type: "fixed", a: "ex3", b: "ex1", anchor: { axisOf: { face: "ex3.side[sk3.c1]" } } },
          { id: "j2", name: "Lid", type: "revolute", a: "ex2", b: "ex1", anchor: { axisOf: { face: "ex3.side[sk3.c1]" } }, limits: [0, 110] },
        ],
      },
    },
    expect: { bodies: 3, volume: 60 * 40 * 20 + 60 * 40 * 3 + PI * 6.25 * 60, size: [60, 42.5, 23] },
  },
  {
    file: "23 Viergelenk",
    name: "Four-bar linkage",
    look: "Four flat links with round ends on pins: a 100 mm ground bar, a 30 mm crank standing up at its left end, a 90 mm coupler and a 70 mm rocker. Joints panel: playing the crank turns it round and round while the rocker swings back and forth; dragging the coupler moves the whole linkage.",
    doc: {
      ...doc([
        sketch("sk1", { ref: "origin.XY" }, link("g", [0, 0], [100, 0], 10, 2.2)),
        { id: "ex1", op: "extrude", name: "Ground", profile: { sketch: "sk1" }, extent: "blind", distance: 3, mode: "new_body" },
        { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 3 },
        sketch("sk2", { ref: "pl1" }, link("c", [0, 0], [0, 30], 8, 2.2)),
        { id: "ex2", op: "extrude", name: "Crank", profile: { sketch: "sk2" }, extent: "blind", distance: 3, mode: "new_body" },
        sketch("sk3", { ref: "pl1" }, link("r", [100, 0], [81.775827, 67.58609], 8, 2.2)),
        { id: "ex3", op: "extrude", name: "Rocker", profile: { sketch: "sk3" }, extent: "blind", distance: 3, mode: "new_body" },
        { id: "pl2", op: "plane", base: { ref: "origin.XY" }, offset: 6 },
        sketch("sk4", { ref: "pl2" }, link("k", [0, 30], [81.775827, 67.58609], 8, 2.2)),
        { id: "ex4", op: "extrude", name: "Coupler", profile: { sketch: "sk4" }, extent: "blind", distance: 3, mode: "new_body" },
      ]),
      mechanism: {
        joints: [
          { id: "j1", name: "Crank", type: "revolute", a: "ex2", b: "ex1", anchor: { axisOf: { face: "ex2.side[sk2.ch1]" } } },
          { id: "j2", name: "Coupler on crank", type: "revolute", a: "ex4", b: "ex2", anchor: { axisOf: { face: "ex4.side[sk4.kh1]" } } },
          { id: "j3", name: "Rocker", type: "revolute", a: "ex3", b: "ex1", anchor: { axisOf: { face: "ex3.side[sk3.rh1]" } } },
          { id: "j4", name: "Coupler on rocker", type: "revolute", a: "ex4", b: "ex3", anchor: { axisOf: { face: "ex4.side[sk4.kh2]" } } },
        ],
      },
    },
    // Each link: bar plus round ends minus two holes, 3 mm thick.
    expect: { bodies: 4, volume: [[100, 10], [30, 8], [70, 8], [90, 8]].reduce((v, [l, w]) => v + (l! * w! + PI * (w! / 2) ** 2 - 2 * PI * 2.2 ** 2) * 3, 0) },
  },
  {
    file: "24 Lochplatte mit Normbohrungen",
    name: "Mounting plate with standard holes",
    look: "80 × 40 × 10 plate: two M4 counterbores for cap screws on the left, an M3 countersink in the middle, two M3 heat-set insert holes (Ø4, 6.7 deep) and an M5 tapped hole with a real thread on the right.",
    doc: doc(HOLE_PLATE),
    expect: { bodies: 1, volume: HOLE_PLATE_VOLUME, size: [80, 40, 10] },
  },
  {
    file: "25 Trichter und Rohrbogen",
    name: "Funnel adapter and pipe bend",
    look: "Left: a hollow funnel 30 high that goes from a 40 mm square at the bottom to a Ø24 circle at the top, with a round hole through it (Ø30 below, Ø20 above). Right: a pipe (Ø12 outside, Ø8 inside) that rises 30, bends a quarter turn with radius 20 and runs 20 along x.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...rect("a", -20, -20, 40, 40), ...circle("h1", 0, 0, 15)]),
      { id: "pl1", op: "plane", name: "Funnel top", base: { ref: "origin.XY" }, offset: 30 },
      sketch("sk2", { ref: "pl1" }, [...circle("c1", 0, 0, 12), ...circle("h2", 0, 0, 10)]),
      { id: "lo1", op: "loft", name: "Funnel", profiles: [{ sketch: "sk1" }, { sketch: "sk2" }], mode: "new_body" },
      sketch("sk3", { ref: "origin.XY" }, [...circle("p1", 70, 0, 6), ...circle("p2", 70, 0, 4)]),
      sketch("sk4", { ref: "origin.XZ" }, [
        { id: "q0", type: "point", x: 70, y: 0 },
        { id: "q1", type: "point", x: 70, y: 30 },
        { id: "q2", type: "point", x: 90, y: 50 },
        { id: "q3", type: "point", x: 110, y: 50 },
        { id: "qc", type: "point", x: 90, y: 30 },
        { id: "l1", type: "line", p1: "q0", p2: "q1" },
        { id: "a1", type: "arc", center: "qc", start: "q2", end: "q1" },
        { id: "l2", type: "line", p1: "q2", p2: "q3" },
      ]),
      { id: "sw1", op: "sweep", name: "Pipe", profile: { sketch: "sk3" }, path: { sketch: "sk4" }, mode: "new_body" },
    ]),
    // Pipe: ring area times path length. Funnel: between a Ø24 cylinder and the 40 mm prism, minus the coned hole.
    expect: (() => {
      const pipe = PI * (36 - 16) * (30 + (PI / 2) * 20 + 20);
      const hole = (PI * 30 * (15 ** 2 + 15 * 10 + 10 ** 2)) / 3;
      return { bodies: 2, volume: [pipe + PI * 144 * 30 - hole, pipe + 1600 * 30 - hole] as [number, number] };
    })(),
  },
  {
    file: "26 Geteilter Balken",
    name: "Bar split for the printer",
    look: "A 300 × 40 × 20 bar with three Ø10 holes, split at x = 150 into two parts of 150 mm each (one fits a 256 mm printer bed). The right piece keeps the name, the left one is a new part.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 300, 40), ...circle("h1", 50, 20, 5), ...circle("h2", 150 - 40, 20, 5), ...circle("h3", 250, 20, 5)]),
      { id: "ex1", op: "extrude", name: "Bar", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
      { id: "pl1", op: "plane", name: "Middle", base: { ref: "origin.YZ" }, offset: 150 },
      { id: "sp1", op: "split", name: "Split for printing", plane: { ref: "pl1" }, bodies: ["ex1"] },
    ]),
    expect: { bodies: 2, volume: 300 * 40 * 20 - 3 * PI * 25 * 20, size: [300, 40, 20] },
  },
  {
    file: "27 Winkel mit Rippen",
    name: "Angle bracket with ribs",
    look: "An L-bracket (60 × 40 base, 5 thick; 40 high wall at the back) with two 4 mm triangular ribs in the corner, at y = 8 and y = 32, each running 25 up the wall and 30 along the base.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("b", 0, 0, 60, 40)),
      { id: "ex1", op: "extrude", name: "Base", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
      sketch("sk2", { ref: "origin.XY" }, rect("w", 0, 0, 5, 40)),
      { id: "ex2", op: "extrude", name: "Wall", profile: { sketch: "sk2" }, extent: "blind", distance: 40, mode: "join" },
      ...[8, 32].flatMap((y, k): Feature[] => [
        { id: `pl${k + 1}`, op: "plane", name: `Rib plane ${k + 1}`, base: { ref: "origin.XZ" }, offset: -y },
        sketch(`sk${k + 3}`, { ref: `pl${k + 1}` }, [
          { id: `r${k}a`, type: "point", x: 5, y: 30 },
          { id: `r${k}b`, type: "point", x: 35, y: 5 },
          { id: `r${k}`, type: "line", p1: `r${k}a`, p2: `r${k}b` },
        ]),
        { id: `rb${k + 1}`, op: "rib", name: `Rib ${k + 1}`, sketch: `sk${k + 3}`, thickness: 4 },
      ]),
    ]),
    expect: { bodies: 1, volume: 60 * 40 * 5 + 5 * 40 * 35 + 2 * 0.5 * 25 * 30 * 4, size: [60, 40, 40] },
  },
  {
    file: "28 Gussform-Deckel mit Schräge",
    name: "Moulded cap with draft",
    look: "A 50 × 30 × 15 cap with 3° draft on all four sides: the bottom stays 50 × 30, the top is about 1.6 mm smaller on each side; the top edges are rounded with 2 mm.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", -25, -15, 50, 30)),
      { id: "ex1", op: "extrude", name: "Cap", profile: { sketch: "sk1" }, extent: "blind", distance: 15, mode: "new_body" },
      { id: "dr1", op: "draft", name: "Draft", faces: ["l1", "l2", "l3", "l4"].map((l) => ({ face: `ex1.side[sk1.${l}]` })), angle: 3, neutral: { ref: "origin.XY" } },
      { id: "fi1", op: "fillet", name: "Top edges", edges: { select: "edges", of: "ex1", where: { face: "ex1.end_cap" } }, radius: 2 },
    ]),
    // Frustum of the draft minus a little for the rounds (checked as a range).
    expect: (() => {
      const d = 15 * Math.tan((3 * PI) / 180);
      const top = (50 - 2 * d) * (30 - 2 * d);
      const v = (15 / 3) * (1500 + top + Math.sqrt(1500 * top));
      return { bodies: 1, volume: [v - 2 * (50 + 30) * 4 * (1 - PI / 4) - 50, v - 2 * (50 + 30) * 4 * (1 - PI / 4) + 50] as [number, number], size: [50, 30, 15] as [number, number, number] };
    })(),
  },
  {
    file: "29 Namensschild",
    name: "Name plate with text",
    look: "An 80 × 30 × 4 plate with rounded corners: \"meerCAD\" raised 1 mm in bold 8 mm letters, centred on the top; \"Testmodell 29\" engraved 0.6 mm deep in 4 mm letters below it.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", -40, -15, 80, 30)),
      { id: "ex1", op: "extrude", name: "Plate", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" },
      { id: "fi1", op: "fillet", name: "Corners", edges: ["l1|l2", "l2|l3", "l3|l4", "l4|l1"].map((p) => { const [a, b] = p.split("|"); return { edge: [`ex1.side[sk1.${a}]`, `ex1.side[sk1.${b}]`] as [string, string] }; }), radius: 4 },
      { id: "tx1", op: "text", name: "Name", plane: { face: { face: "ex1.end_cap" } }, text: "meerCAD", font: "sans-bold", align: "center", position: [0, 0], size: 8, depth: 1, mode: "join" },
      { id: "tx2", op: "text", name: "Label", plane: { face: { face: "ex1.end_cap" } }, text: "Testmodell 29", align: "center", position: [0, -10], size: 4, depth: 0.6, mode: "cut" },
    ]),
    // The plate with its rounded corners; the raised letters add more than the engraving takes away.
    expect: { bodies: 1, volume: [80 * 30 * 4 - 4 * 16 * (1 - PI / 4) * 4, 80 * 30 * 4 - 4 * 16 * (1 - PI / 4) * 4 + 400] as [number, number], size: [80, 30, 5] },
  },
  {
    file: "30 Schale mit Skizzen-Werkzeugen",
    name: "Tray from sketch tools",
    look: "A 60 × 40 × 5 plate whose corners are rounded with R5 in the sketch, with a 2 mm deep pocket inset 3 mm all round (its corners R2): the outline was offset inwards by the sketch's offset tool. One corner of a 20 × 10 tab on the side is bevelled 3 mm.",
    doc: (() => {
      const pts = (d: SketchData) => new Map(d.entities.flatMap((e) => (e.type === "point" ? [[e.id, [e.x, e.y] as Vec2]] : [])));
      let outline: SketchData = { entities: rect("l", 0, 0, 60, 40), constraints: [] };
      for (const corner of ["lp1", "lp2", "lp3", "lp4"]) outline = cornerEdit(outline, pts(outline), corner, 5, "fillet");
      const curves = outline.entities.filter((e) => e.type === "line" || e.type === "arc").map((e) => e.id);
      const both = offsetCurves(outline, pts(outline), curves, -3);
      // The pocket's sketch keeps only the offset curves and their points.
      const fresh = both.entities.filter((e) => !outline.entities.some((o) => o.id === e.id));
      const keep = new Set([...fresh.map((e) => e.id), ...fresh.flatMap((e) => (e.type === "arc" ? [e.center] : []))]);
      const pocket = both.entities.filter((e) => keep.has(e.id));
      let tab: SketchData = { entities: rect("t", 60, 15, 20, 10), constraints: [] };
      tab = cornerEdit(tab, pts(tab), "tp2", 3, "chamfer");
      return doc([
        sketch("sk1", { ref: "origin.XY" }, outline.entities, outline.constraints),
        { id: "ex1", op: "extrude", name: "Plate", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
        sketch("sk2", { face: { face: "ex1.end_cap" } }, pocket),
        { id: "ex2", op: "extrude", name: "Pocket", profile: { sketch: "sk2" }, extent: "blind", distance: 2, flip: true, mode: "cut" },
        sketch("sk3", { ref: "origin.XY" }, tab.entities, tab.constraints),
        { id: "ex3", op: "extrude", name: "Tab", profile: { sketch: "sk3" }, extent: "blind", distance: 5, mode: "join" },
      ]);
    })(),
    // Rounded rectangles: w · h − (4 − π) r²; the tab loses a 3 × 3 triangle.
    expect: { bodies: 1, volume: (60 * 40 - (4 - PI) * 25) * 5 - (54 * 34 - (4 - PI) * 4) * 2 + (200 - 4.5) * 5, size: [80, 40, 5] },
  },
  {
    file: "31 Griff mit Splines",
    name: "Handle from splines",
    look: "A flat 8 mm thick handle with a smooth, organic outline (a closed spline through six points, about 90 × 30) and a hanging hole; beside it a Ø6 rod that leaves the floor straight up and curves away along a spline.",
    doc: (() => {
      const outline: [number, number][] = [[0, 0], [40, -6], [90, 0], [92, 22], [45, 26], [2, 20]];
      const path: [number, number][] = [[120, 0], [120, 20], [135, 40], [160, 45]];
      const pts = (ps: [number, number][], p: string): SketchEntity[] => ps.map(([x, y], i) => ({ id: `${p}${i}`, type: "point", x, y }));
      return doc([
        sketch("sk1", { ref: "origin.XY" }, [...pts(outline, "o"), { id: "s1", type: "spline", points: outline.map((_, i) => `o${i}`), closed: true }, ...circle("h1", 80, 12, 4)]),
        { id: "ex1", op: "extrude", name: "Handle", profile: { sketch: "sk1" }, extent: "blind", distance: 8, mode: "new_body" },
        sketch("sk2", { ref: "origin.XY" }, circle("r", 120, 0, 3)),
        sketch("sk3", { ref: "origin.XZ" }, [...pts(path, "p"), { id: "s2", type: "spline", points: path.map((_, i) => `p${i}`) }]),
        { id: "sw1", op: "sweep", name: "Rod", profile: { sketch: "sk2" }, path: { sketch: "sk3" }, mode: "new_body" },
      ]);
    })(),
    // The handle: the area inside the spline (from its samples) minus the hole, 8 thick; the rod: its
    // cross-section times the path's length. Within 1 %.
    expect: (() => {
      const loop = splinePoints([[0, 0], [40, -6], [90, 0], [92, 22], [45, 26], [2, 20]], true);
      const area = Math.abs(loop.reduce((a, p, i) => a + p[0] * loop[(i + 1) % loop.length]![1] - loop[(i + 1) % loop.length]![0] * p[1], 0)) / 2;
      const rod = splinePoints([[120, 0], [120, 20], [135, 40], [160, 45]]);
      const length = rod.slice(1).reduce((l, p, k) => l + Math.hypot(p[0] - rod[k]![0], p[1] - rod[k]![1]), 0);
      const v = (area - PI * 16) * 8 + PI * 9 * length;
      return { bodies: 2, volume: [v * 0.99, v * 1.01] as [number, number] };
    })(),
  },
  {
    file: "32 Platte mit Normteilen",
    name: "Plate with standard parts",
    look: "The 80 × 40 × 10 mounting plate of model 24 with two M4×12 socket head cap screws sitting in its counterbores (heads 4.4 mm deep, flush below the top), and a 608 ball bearing standing on the top face at the right.",
    doc: doc([
      ...HOLE_PLATE,
      { id: "pl1", op: "plane", name: "Counterbore seats", base: { ref: "origin.XY" }, offset: 10 - 4.4 },
      { id: "np1", op: "standard_part", kind: "socket_screw", size: "M4", length: 12, plane: { ref: "pl1" }, points: [[10, 10], [10, 30]] },
      { id: "np2", op: "standard_part", kind: "bearing", size: "608", plane: { face: { face: "ex1.end_cap" } }, points: [[100, 20]] },
    ]),
    // The plate as in model 24; two screws (head Ø7 × 4 with a 3 mm socket 2 deep, shank Ø4 × 12); the bearing ring.
    expect: (() => {
      const plate = HOLE_PLATE_VOLUME;
      const screw = PI * 3.5 ** 2 * 4 - (Math.sqrt(3) / 2) * 9 * 2 + PI * 4 * 12;
      const bearing = PI * (11 ** 2 - 4 ** 2) * 7;
      return { bodies: 4, volume: [plate[0] + 2 * screw + bearing, plate[1] + 2 * screw + bearing] as [number, number] };
    })(),
  },
  {
    file: "33 Zusammenbau mit Ausrichten",
    name: "Assembly by aligning",
    look: "A 40 × 40 × 10 base with a Ø8 hole, a Ø8 × 30 pin standing in the hole (its end flush with the base's bottom, 20 mm sticking out) and a 10 × 10 × 5 block lying on the base's top, turned 45°. All three were modelled lying around and moved into place by align steps.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...rect("b", 0, 0, 40, 40), ...circle("h", 20, 20, 4)]),
      { id: "ex1", op: "extrude", name: "Base", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
      sketch("sk2", { ref: "origin.XY" }, rect("k", 60, 0, 10, 10)),
      { id: "ex2", op: "extrude", name: "Block", profile: { sketch: "sk2" }, extent: "blind", distance: 5, mode: "new_body" },
      { id: "pl1", op: "plane", name: "Pin plane", base: { ref: "origin.YZ" }, offset: 60 },
      sketch("sk3", { ref: "pl1" }, circle("p", -30, 4, 4)),
      { id: "ex3", op: "extrude", name: "Pin", profile: { sketch: "sk3" }, extent: "blind", distance: 30, mode: "new_body" },
      { id: "al1", op: "align", name: "Pin into hole", from: { axisOf: { face: "ex3.side[sk3.p]" } }, to: { axisOf: { face: "ex1.side[sk1.h]" } } },
      { id: "al2", op: "align", name: "Pin end flush", from: { face: { face: "ex3.start_cap" } }, to: { face: { face: "ex1.start_cap" } }, flip: true },
      { id: "al3", op: "align", name: "Block on top", from: { face: { face: "ex2.start_cap" } }, to: { face: { face: "ex1.end_cap" } }, angle: 45 },
    ]),
    expect: { bodies: 3, volume: 40 * 40 * 10 - PI * 16 * 10 + PI * 16 * 30 + 500 },
  },
  {
    file: "34 Auf Maß skaliert",
    name: "Scaled to a measured size",
    look: "A block drawn 20.4 × 10.2 × 5.1 (as a scan might come out) scaled by 20 / 20.4 about its centre, so it measures exactly 20 × 10 × 5, with its Ø4.08 hole now Ø4.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 20.4, 10.2), ...circle("h", 10.2, 5.1, 2.04)]),
      { id: "ex1", op: "extrude", name: "Scan", profile: { sketch: "sk1" }, extent: "blind", distance: 5.1, mode: "new_body" },
      { id: "sc1", op: "scale", name: "To measured size", bodies: ["ex1"], factor: "20 / 20.4" },
    ]),
    expect: { bodies: 1, volume: (200 - PI * 4) * 5, size: [20, 10, 5] },
  },
  {
    file: "35 Halter mit versetzten Flächen",
    name: "Holder with moved faces",
    look: "A 40 × 20 block with a hole for an 8 mm pin. Drawn 10 high, its top was moved up 4 mm to 14; the hole wall moved in by 0.1 mm (Ø7.8 for a press fit); the right end moved out up to a plane at x = 50, so the block is 50 long.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 40, 20), ...circle("h", 10, 10, 4)]),
      { id: "ex1", op: "extrude", name: "Holder", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
      { id: "of1", op: "offset_face", name: "Taller", faces: [{ face: "ex1.end_cap" }], distance: 4 },
      { id: "of2", op: "offset_face", name: "Press fit", faces: [{ face: "ex1.side[sk1.h]" }], distance: 0.1 },
      { id: "pl1", op: "plane", name: "End stop", base: { ref: "origin.YZ" }, offset: 50 },
      { id: "of3", op: "offset_face", name: "Longer", faces: [{ face: "ex1.side[sk1.l2]" }], distance: 0, upTo: { ref: "pl1" } },
    ]),
    expect: { bodies: 1, volume: 50 * 20 * 14 - PI * 3.9 ** 2 * 14, size: [50, 20, 14] },
  },
  {
    file: "36 Gerippte Box",
    name: "Ribbed storage box (surface texture)",
    look: "An open 80 × 60 × 50 box, 2 mm walls, round upright corners (r 8), with round vertical ribs 0.8 mm high every 4 mm on its walls and corners. The ribs are a finish: the volume is the smooth box's.",
    doc: doc(
      [
        sketch("sk1", { ref: "origin.XY" }, rect("l", -40, -30, 80, 60)),
        { id: "ex1", op: "extrude", name: "Box", profile: { sketch: "sk1" }, extent: "blind", distance: 50, mode: "new_body" },
        { id: "fi1", op: "fillet", name: "Round corners", edges: ["l1|l2", "l2|l3", "l3|l4", "l4|l1"].map((p) => ({ edge: p.split("|").map((c) => `ex1.side[sk1.${c}]`) as [string, string] })), radius: 8 },
        { id: "sh1", op: "shell", name: "Hollow", faces: [{ face: "ex1.end_cap" }], thickness: 2 },
        { id: "st1", op: "texture", name: "Ribs", faces: [{ face: "ex1.side[*]" }, { face: "fi1.round[*]" }], pattern: "ribs", depth: 0.8, pitch: 4 },
      ],
    ),
    // Outside minus inside: rounded rectangles (corner r 8 outside, 6 inside), floor 2 mm.
    expect: { bodies: 1, volume: (80 * 60 - (4 - PI) * 64) * 50 - (76 * 56 - (4 - PI) * 36) * 48, size: [80, 60, 50] },
  },
  {
    file: "37 Gebogener Streifen",
    name: "Strip bent through 90°",
    look: "A 100 × 10 × 2 strip bent round the Y axis through 90°: one leg flat, the bend round, the far end pointing up. Bending keeps its volume.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, -5, 100, 10)),
      { id: "ex1", op: "extrude", name: "Strip", profile: { sketch: "sk1" }, extent: "blind", distance: 2, mode: "new_body" },
      { id: "bd1", op: "bend", name: "Bend", bodies: ["ex1"], mode: "bend", axis: { ref: "origin.Y" }, angle: 90 },
    ]),
    expect: { bodies: 1, volume: [100 * 10 * 2 * 0.99, 100 * 10 * 2 * 1.01] },
  },
  {
    file: "38 Gridfinity-Box mit Etikett",
    name: "Gridfinity bin with a label",
    look: "A 2 × 1 Gridfinity bin, 3 units (21 mm) plus lip, with a divider, a finger scoop and a label tab; on the tab a raised label with a screw symbol and M3×10. The bin is 83.5 × 41.5 mm.",
    doc: doc([
      { id: "gf1", op: "gridfinity", name: "Bin", kind: "bin", units: [2, 1], height: 3, dividers: [1, 0], scoop: 6, tab: {} },
      { id: "lb1", op: "label", name: "Label", plane: { face: { face: "gf1.tab" } }, position: [-20.8, -8.6], text: "M3×10", symbol: "screw_socket" },
    ]),
    // The label is a part of its own (printed on the tab, or in another colour).
    expect: { bodies: 2, size: [83.5, 41.5, 25.4] },
  },
  {
    file: "39 Stapelbox",
    name: "Stackable box",
    look: "A box like a shop storage box, sized for A5 paper: rim bead on top, smooth plinth band at the bottom, smooth walls without handles; it prints upright without supports. Outside 234.4 × 160.7 × 100; A5 paper lies inside with play. Its solid foot fits into the box below with 0.4 mm play and a 45° slope; a groove across the middle of its underside (7.6 mm wide in the foot, 18.8 mm wide 1.5 mm above it, with a rib over it on the floor inside) takes the two touching rims and their rounded corners when it stands on two boxes of the next smaller size, so it sits as deep there as on one box of its own size. A6, A5 and A4 as variants, two of the next smaller size fit exactly on top of one.",
    // Without its sizes as variants, so the plain parameter changes below take effect.
    doc: { ...(JSON.parse(readFileSync(new URL("../../apps/web/src/examples/40-stackable-ribbed-box.meercad", import.meta.url), "utf8")) as MeercadDocument), variants: undefined, variant: undefined },
    // Volume measured once (walls, bead, plinth, frames), kept as a check that nothing moves.
    expect: { bodies: 1, volume: 429311, size: [234.38, 160.73, 100] },
    variants: [
      { params: { din: "6", height: "70 mm" }, expect: { bodies: 1, size: [160.73, 117.19, 70] } },
      { params: { din: "4", height: "140 mm" }, expect: { bodies: 1, size: [321.46, 234.38, 140] } },
    ],
  },
  {
    file: "40 Linearachse",
    name: "Linear axis with rail, lead screw and aluminium profiles",
    look: "A 300 × 80 plate with an MGN12 rail and its carriage, a Tr8×8 lead screw lying along it with its flanged nut, two 2020 posts and two corner brackets against them. The carriage slides 0–205.3 mm; turning the screw 360° moves the nut 8 mm.",
    doc: JSON.parse(readFileSync(new URL("../../apps/web/src/examples/41-linear-axis.meercad", import.meta.url), "utf8")) as MeercadDocument,
    expect: { bodies: 9, size: [300, 80, 68] },
    variants: [{ params: { travel: "200 mm" }, expect: { bodies: 9 } }],
  },
  {
    file: "41 Box mit Schnappdeckel",
    name: "Box with a snap lid",
    look: "An 80 × 60 × 40 box with 2 mm walls and rounded corners, a groove round the inside 3 mm below the rim and a finger-nail notch in the front rim. Beside it, 10 mm to the right, its lid lies upside down: a plate as large as the box with a lip that has a bead round it.",
    doc: doc([{ id: "bx1", op: "box", name: "Box", lid: "snap", width: 80, depth: 60, height: 40 }]),
    expect: { bodies: 2, size: [170, 60, 40] },
  },
  {
    file: "42 Schraubdose",
    name: "Jar with a screw lid",
    look: "A round jar ⌀70 × 70 with a narrower threaded neck on top (coarse 4 mm thread, 45° flanks); beside it its cap lies upside down, as wide as the jar, with the inner thread in its skirt.",
    doc: doc([{ id: "bx1", op: "box", name: "Jar", lid: "screw", width: 70, height: 70 }]),
    expect: { bodies: 2, size: [150, 70, 70] },
  },
  {
    file: "43 Boxen und Schnapphaken",
    name: "Boxes and snap hooks",
    look: "Three things: a box with a snap lid (lid beside it), a jar with a screw cap (cap beside it) and a 60 × 40 × 25 case whose separate lid has two snap hooks on its underside; their barbs sit in windows cut through the case's long walls.",
    doc: JSON.parse(readFileSync(new URL("../../apps/web/src/examples/42-boxes-and-snap-hooks.meercad", import.meta.url), "utf8")) as MeercadDocument,
    expect: { bodies: 6 },
  },
  {
    file: "44 Geteilter Balken mit Stiften",
    name: "Bar split with pins",
    look: "A 300 × 40 × 20 bar split at x = 150. Two Ø5 pins, 8 long, stand out of the right piece's cut face (at y = 10 and y = 30, mid height); the left piece has Ø5.4 holes 8.2 deep in the same places, so the pieces plug together.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 300, 40)),
      { id: "ex1", op: "extrude", name: "Bar", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
      { id: "pl1", op: "plane", name: "Middle", base: { ref: "origin.YZ" }, offset: 150 },
      { id: "sp1", op: "split", name: "Split for printing", plane: { ref: "pl1" }, bodies: ["ex1"], connectors: { kind: "pins", size: 5, depth: 8, points: [[10, 10], [30, 10]] } },
    ]),
    expect: { bodies: 2, volume: 300 * 40 * 20 + 2 * PI * 6.25 * 8 - 2 * PI * 2.7 ** 2 * 8.2, size: [300, 40, 20] },
  },
  {
    file: "45 Brett mit Schwalbenschwanz",
    name: "Board split with a dovetail",
    look: "A 400 × 120 × 18 board split at x = 200 into two pieces that fit a 256 mm bed. The right piece has a dovetail tongue running across the whole 120 mm cut (7 wide at the cut, 4 deep, widening 15° to each side); the left piece has the matching slot 0.2 mm larger all round, open at both long edges, so it slides on from the side.",
    doc: doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 400, 120)),
      { id: "ex1", op: "extrude", name: "Board", profile: { sketch: "sk1" }, extent: "blind", distance: 18, mode: "new_body" },
      { id: "pl1", op: "plane", name: "Middle", base: { ref: "origin.YZ" }, offset: 200 },
      { id: "sp1", op: "split", name: "Split for printing", plane: { ref: "pl1" }, bodies: ["ex1"], connectors: { kind: "dovetail" } },
    ]),
    // The slot is 0.2 larger all round than the tongue: about 0.2 × 17.5 (its outline in the cut) × 120 less.
    expect: { bodies: 2, volume: [400 * 120 * 18 - 0.2 * 17.5 * 120 * 1.1, 400 * 120 * 18 - 0.2 * 17.5 * 120 * 0.9] as [number, number], size: [400, 120, 18] },
  },
];
