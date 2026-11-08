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
    await ui.field("Count", 6);
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
};
