/**
 * How a person builds each test model in the app, step by step, keyed by the model's file name in
 * tests/models/models.ts. Steps use the visible interface only (see ./ui.ts); numbers are typed
 * the way a maker types them.
 */
import type { Ui } from "./ui.js";

export type Script = (ui: Ui) => Promise<void>;

// Which edge or face to click, as tests that run in the page (see Ui.spotOf).
/** A flat edge all at height z (the rim round a top face). */
const TOP_RING = (z: number) => `(e) => e.min[2] > ${z} - 0.01 && e.max[2] < ${z} + 0.01`;
/** The flat face on top at height z. */
const TOP_FACE = (z: number) => `(f) => f.normal[2] > 0.99 && Math.abs(f.center[2] - ${z}) < 0.01`;
/** The upright edge standing at (x, y). */
const VERTICAL_AT = (x: number, y: number) => `(e) => e.max[2] - e.min[2] > 1 && Math.abs(e.min[0] - ${x}) < 0.01 && Math.abs(e.max[0] - ${x}) < 0.01 && Math.abs(e.min[1] - ${y}) < 0.01 && Math.abs(e.max[1] - ${y}) < 0.01`;

/**
 * A regular hexagon round the origin with flat top and bottom, `flats` across them: the polygon
 * tool, the top side set horizontal, and a dimension from a corner to the opposite side. Clicks
 * keep clear of the sides' middles, where the constraint symbols sit.
 */
async function hexagon(ui: Ui, flats: number | string) {
  // Drawn large so the clicks land clear of each other at the default zoom; the dimension shrinks it.
  const r = 25, h = r * 0.866;
  await ui.zoomSketch(2 * r);
  await ui.polygon([0, 0], [r, 0]);
  await ui.constrain("Horiz./Vert.", [[r / 5, h]]);
  await ui.dimension([[r - 0.25 * (r / 2), 0.25 * h], [-r + 0.25 * (r / 2), -0.25 * h]], [0, -h - 8], flats);
}

export const SCRIPTS: Record<string, Script> = {
  "01 Wuerfel": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([-10, -10], 20, 20);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 20);
    await ui.accept();
  },

  "02 Lochplatte": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([0, 0], 60, 40);
    for (const c of [[8, 8], [52, 8], [8, 32], [52, 32]] as [number, number][]) await ui.circle(c, 5);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 5);
    await ui.accept();
  },

  "03 Zylinder gefast": async (ui) => {
    await ui.sketchOn("Top");
    await ui.circle([0, 0], 30);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 20);
    await ui.accept();
    await ui.feature("Modify", "Chamfer");
    await ui.clickEdge(TOP_RING(20));
    await ui.field("Distance", 2);
    await ui.accept();
  },

  "04 Block abgerundet": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([0, 0], 40, 30);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 10);
    await ui.accept();
    await ui.feature("Modify", "Fillet");
    for (const [x, y] of [[0, 0], [40, 0], [40, 30], [0, 30]]) await ui.clickEdge(VERTICAL_AT(x!, y!));
    await ui.field("Radius", 5);
    await ui.accept();
  },

  "05 Schale offen": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([0, 0], 50, 40);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 30);
    await ui.accept();
    await ui.feature("Modify", "Shell");
    await ui.clickFace(TOP_FACE(30));
    await ui.field("Thickness", 2);
    await ui.accept();
  },

  "06 Rohr gedreht": async (ui) => {
    await ui.sketchOn("Front");
    await ui.rect([10, 0], 5, 20);
    await ui.finishSketch();
    await ui.feature("Create", "Revolve");
    await ui.option("Z");
    await ui.field("Angle", 360);
    await ui.accept();
  },

  "07 Flansch Lochkreis": async (ui) => {
    await ui.addVariable("holes", 6);
    await ui.sketchOn("Top");
    await ui.circle([0, 0], 60);
    await ui.circle([0, 0], 20);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 6);
    await ui.accept();
    await ui.sketchOnFace(TOP_FACE(6));
    await ui.circle([22, 0], 5);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.option("Remove");
    await ui.choose("End", "Through all");
    await ui.accept();
    await ui.feature("Transform", "Circular pattern");
    await ui.check("Extrude 2");
    await ui.option("Z");
    await ui.field("Count", "holes");
    await ui.accept();
  },

  "08 Stiftleiste": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([0, 0], 100, 20);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 3);
    await ui.accept();
    await ui.sketchOnFace(TOP_FACE(3));
    await ui.circle([10, 10], 4);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.option("Add");
    await ui.field("Distance", 6);
    await ui.accept();
    await ui.feature("Transform", "Linear pattern");
    await ui.check("Extrude 2");
    await ui.option("X");
    await ui.field("Count", 5);
    await ui.field("Spacing", 20);
    await ui.accept();
  },

  "09 T-Profil gespiegelt": async (ui) => {
    await ui.sketchOn("Front");
    // The last corner is clicked, not typed: its length follows from the others.
    await ui.polyline([0, 0], [[40, 0], [4, 90], [36, 180], [26, 90]], false);
    await ui.clickSketch([0, 30]);
    await ui.clickSketch([0, 0]);
    await ui.key("Escape");
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 30);
    await ui.accept();
    await ui.feature("Transform", "Mirror");
    await ui.option("Parts");
    await ui.clickBody("ex1");
    await ui.option("Right");
    await ui.accept();
    await ui.feature("Modify", "Boolean");
    await ui.option("Union");
    await ui.clickBody("ex1");
    await ui.clickBody("mi1_1");
    await ui.accept();
  },

  "10 Schraube M8": async (ui) => {
    await ui.sketchOn("Top");
    await ui.circle([0, 0], 8);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 20);
    await ui.accept();
    await ui.sketchOn("Top");
    await hexagon(ui, 13);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.option("Add");
    await ui.press("Flip direction", ".dialog button");
    await ui.field("Distance", 5.5);
    await ui.accept();
    await ui.feature("Modify", "Thread");
    await ui.clickFace(`(f) => f.body === "ex1" && Math.abs(f.normal[2]) < 0.01 && f.center[2] > 5`);
    await ui.accept();
  },

  "11 Mutter M8": async (ui) => {
    await ui.sketchOn("Top");
    await hexagon(ui, 13);
    await ui.circle([0, 0], 8);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 6.5);
    await ui.accept();
    await ui.feature("Modify", "Thread");
    await ui.clickFace(`(f) => Math.abs(f.normal[2]) < 0.01 && Math.hypot(f.center[0], f.center[1]) < 4.5`);
    await ui.accept();
  },

  "12 Boolesch und Kopie": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([-15, -15], 30, 30);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 30);
    await ui.accept();
    await ui.feature("Create", "Plane");
    await ui.option("Top");
    await ui.field("Offset", -10);
    await ui.accept();
    // The tag shows the plane by its id.
    await ui.sketchOn("pl1");
    await ui.circle([0, 0], 16);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.option("New");
    await ui.field("Distance", 50);
    await ui.accept();
    await ui.feature("Transform", "Move");
    await ui.clickBody("ex1");
    await ui.fieldN("Move by (X / Y / Z)", 0, 45);
    await ui.check("Keep original (copy)");
    await ui.accept();
    await ui.feature("Modify", "Boolean");
    await ui.option("Subtract");
    await ui.clickBody("ex1");
    await ui.clickBody("ex2");
    await ui.accept();
  },

  "13 Abstandshalter symmetrisch": async (ui) => {
    await ui.sketchOn("Top");
    // 12 across the corners.
    await hexagon(ui, "6 * sqrt(3)");
    await ui.circle([0, 0], 5);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.choose("End", "Symmetric");
    await ui.field("Distance", 20);
    await ui.accept();
  },

  "14 Block mit Tasche": async (ui) => {
    await ui.sketchOn("Top");
    await ui.rect([0, 0], 60, 40);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.field("Distance", 15);
    await ui.accept();
    await ui.feature("Modify", "Chamfer");
    await ui.clickFace(TOP_FACE(15));
    await ui.field("Distance", 1);
    await ui.accept();
    await ui.sketchOnFace(TOP_FACE(15));
    await ui.rect([15, 10], 30, 20);
    await ui.finishSketch();
    await ui.feature("Create", "Extrude");
    await ui.option("Remove");
    // The cut starts out of the face, away from the block (see the preview): flip it in.
    await ui.press("Flip direction", ".dialog button");
    await ui.field("Distance", 5);
    await ui.accept();
  },

  "17 Stirnrad": async (ui) => {
    await ui.addVariable("m", 2);
    await ui.addVariable("z", 20);
    await ui.feature("Create", "Gear");
    await ui.field("Module", "m");
    await ui.field("Teeth", "z");
    await ui.field("Width", 10);
    await ui.check("Bore");
    await ui.field("Diameter", 8);
    await ui.field("Allowance", 0);
    await ui.accept();
  },

  "18 Zahnradpaar": async (ui) => {
    await ui.feature("Create", "Gear");
    await ui.field("Module", 1.5);
    await ui.field("Teeth", 15);
    await ui.field("Width", 8);
    await ui.check("Bore");
    await ui.field("Diameter", 5);
    await ui.field("Allowance", 0.15);
    // The mating gear opens in its own dialog, meshing with the first.
    await ui.press("Add mating gear", ".dialog button");
    await ui.until("the mating gear", `s.dialog?.feature.id === "gr2"`);
    await ui.field("Teeth", 30);
    await ui.field("Direction from the partner", 30);
    await ui.check("Bore");
    await ui.field("Diameter", 8);
    await ui.field("Allowance", 0);
    await ui.accept();
  },

  "19 Pfeilradpaar": async (ui) => {
    await ui.feature("Create", "Gear");
    await ui.field("Module", 2);
    await ui.field("Teeth", 20);
    await ui.field("Width", 12);
    await ui.field("Helix angle", 30);
    await ui.check("Herringbone (both hands, no side thrust)");
    await ui.check("Chamfer tooth ends");
    await ui.field("Chamfer (45°)", 0.6);
    await ui.press("Add mating gear", ".dialog button");
    await ui.until("the mating gear", `s.dialog?.feature.id === "gr2"`);
    await ui.field("Teeth", 13);
    await ui.check("Chamfer tooth ends");
    await ui.field("Chamfer (45°)", 0.6);
    await ui.accept();
  },

  "20 Planetengetriebe": async (ui) => {
    await ui.feature("Create", "Gear");
    await ui.option("Ring gear");
    await ui.field("Module", 1);
    await ui.field("Teeth", 60);
    await ui.field("Width", 6);
    await ui.field("Outside diameter", 70);
    await ui.press("Add mating gear", ".dialog button");
    await ui.until("planet 1", `s.dialog?.feature.id === "gr2"`);
    await ui.field("Teeth", 18);
    await ui.field("Direction from the partner", 0);
    await ui.accept();
    // Planets 2 and 3: new gears meshing with the ring, a third of a turn apart.
    for (const [id, dir] of [["gr3", 120], ["gr4", 240]] as const) {
      await ui.feature("Create", "Gear");
      await ui.until(id, `s.dialog?.feature.id === "${id}"`);
      await ui.choose("Meshes with", "Gear 1");
      await ui.field("Teeth", 18);
      await ui.field("Width", 6);
      await ui.field("Direction from the partner", dir);
      await ui.accept();
    }
    await ui.feature("Create", "Gear");
    await ui.choose("Meshes with", "Gear 2");
    await ui.field("Teeth", 24);
    await ui.field("Width", 6);
    await ui.field("Direction from the partner", 180);
    await ui.check("Bore");
    await ui.field("Diameter", 5);
    await ui.field("Allowance", 0);
    await ui.accept();
  },

  "21 Zahnstange mit Ritzel": async (ui) => {
    await ui.feature("Create", "Gear");
    await ui.option("Rack");
    await ui.field("Module", 1.5);
    await ui.field("Teeth", 20);
    await ui.field("Width", 8);
    await ui.field("Back below the teeth", 6);
    await ui.press("Add mating gear", ".dialog button");
    await ui.until("the pinion", `s.dialog?.feature.id === "gr2"`);
    await ui.field("Teeth", 16);
    await ui.check("Bore");
    await ui.field("Diameter", 5);
    await ui.field("Allowance", 0);
    await ui.accept();
  },
};
