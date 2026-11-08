/**
 * How a person builds each test model in the app, step by step, keyed by the model's file name in
 * tests/models/models.ts. Steps use the visible interface only (see ./ui.ts); numbers are typed
 * the way a maker types them.
 */
import type { Ui } from "./ui.js";

export type Script = (ui: Ui) => Promise<void>;

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
};
