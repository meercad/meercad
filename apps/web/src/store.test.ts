/**
 * The app's store with the real kernel (apps/web/test/kernelWorker.ts) and projects kept in memory
 * (apps/web/test/setup.ts): a design is made, changed, undone and saved as in the app, and the
 * volumes the kernel reports are the drawn ones.
 */
import { describe, expect, it } from "vitest";
import type { DocOp, Feature, SketchEntity } from "@meercad/schema";
import { testFiles } from "../test/setup";
import {
  apply,
  currentDoc,
  flushSave,
  goHome,
  newProject,
  openProject,
  rebuildNow,
  redo,
  renameProject,
  undo,
  useApp,
} from "./store";

const rect = (w: number, h: number): SketchEntity[] => [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: w, y: 0 },
  { id: "p3", type: "point", x: w, y: h },
  { id: "p4", type: "point", x: 0, y: h },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const box: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
];
const add: DocOp[] = [
  { type: "set_param", name: "h", expr: "10 mm" },
  { type: "add_features", features: box },
];

describe("the app's store", () => {
  it("makes a design, builds it and saves it", async () => {
    await newProject(undefined, "Box");

    const id = useApp.getState().project!.id;
    expect(useApp.getState().screen).toBe("editor");
    expect(apply(...add)).toBe(true);

    const out = await rebuildNow();
    expect(out.report.bodies.map((b) => b.volume)).toEqual([expect.closeTo(8000, 6)]);
    expect(useApp.getState().output).toBe(out);
    await flushSave();
    expect(testFiles.projects.get(id)!.doc.features.map((f) => f.id)).toEqual(["sk1", "ex1"]);
  });

  it("changes a value, undoes and redoes it, and says what it undid", async () => {
    apply({ type: "set_param", name: "h", expr: "25 mm" });
    expect((await rebuildNow()).report.bodies[0]!.volume).toBeCloseTo(20000, 6);
    undo();
    expect(currentDoc().params["h"]).toBe("10 mm");
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/variables/);
    expect((await rebuildNow()).report.bodies[0]!.volume).toBeCloseTo(8000, 6);
    redo();
    expect(currentDoc().params["h"]).toBe("25 mm");
  });

  it("refuses an op that does not fit and shows why", () => {
    const before = currentDoc();
    expect(apply({ type: "delete_feature", id: "zz" })).toBe(false);
    expect(currentDoc()).toBe(before);
    expect(useApp.getState().toasts.at(-1)!.kind).toBe("error");
  });

  it("renames, leaves and opens the project again", async () => {
    await renameProject("Boxy");

    const id = useApp.getState().project!.id;
    expect(useApp.getState().project!.name).toBe("Boxy");
    goHome();
    expect(useApp.getState().screen).toBe("home");
    await openProject(id);
    expect(useApp.getState().screen).toBe("editor");
    expect(currentDoc().params["h"]).toBe("25 mm");
  });
});
