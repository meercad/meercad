/**
 * Test models from simple to complex. Each one is a real design a person would make, with what it
 * must come out as: the number of parts, its volume (worked out by hand where the shape allows it)
 * and its size. `tests/acceptance/models.test.ts` rebuilds them all; with MEERCAD_MODELS_OUT set it
 * also writes them as .meercad files to look at in the app (docs/TESTING.md).
 */
import { GEAR_DEFAULTS, gearShape, outlineArea, type GearParams } from "@meercad/model";
import type { Feature, GearFeature, MeercadDocument, SketchEntity } from "@meercad/schema";
import { circle, rect, sketch } from "../acceptance/helpers.js";

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
    doc: doc([
      gear("gr1", { name: "Pinion", module: 1.5, teeth: 15, width: 8, bore: { diameter: 5, shape: "d_flat", flat: 4.5, allowance: 0.15 } }),
      gear("gr2", { name: "Gear", teeth: 30, width: 8, meshWith: { gear: "gr1", direction: 30 }, bore: { diameter: 8 } }),
    ]),
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
];
