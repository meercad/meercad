/**
 * More of the app's store (store.ts): Undo with a step's dialog open drops the unsaved change; an
 * edit that does not apply says why; switching a design to inches keeps every size; a new blank
 * design takes the printer's measured fit and the chosen measuring system; a project that cannot
 * be saved says so; a project that is gone says so and loses its tab; an assistant taking a
 * project over saves it and moves the user's view on.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { emptyDocument, type Feature, type SketchEntity } from "@meercad/schema";
import {
  apply,
  applyQuiet,
  cancelDialog,
  currentDoc,
  editFeature,
  flushSave,
  newProject,
  openProject,
  rebuildNow,
  redo,
  releaseProject,
  setDesignUnits,
  undo,
  useApp,
  withPrinterFit,
} from "./store";
import { usePrefs } from "./lib/keymap";
import { testFiles } from "../test/setup";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 40, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const block: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";

beforeAll(async () => {
  await newProject(undefined, "Store 2");
  apply({ type: "add_features", features: block });
  await rebuildNow();
});

describe("undo and edits", () => {
  it("drops a dialog's unsaved change on Undo, and leaves the design as it was", async () => {
    editFeature("ex1");
    expect(useApp.getState().dialog).not.toBeNull();
    undo();
    expect(useApp.getState().dialog).toBeNull();
    expect(lastToast()).toBe("Undone: unsaved change");
    expect(currentDoc().features.map((f) => f.id)).toEqual(["sk1", "ex1"]);
    // Redo does nothing while a dialog is open.
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 12 } });
    undo();
    editFeature("ex1");
    redo();
    expect((currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown }).distance).toBe(10);
    cancelDialog();
  });

  it("says why an edit that cannot apply does not", () => {
    expect(applyQuiet({ type: "edit_feature", id: "nope", patch: {} })).toBe(false);
    expect(lastToast()).toMatch(/nope/);
  });
});

describe("units and the printer's fit", () => {
  it("switches the design to inches without changing any size, and back", async () => {
    setDesignUnits("in");
    expect(currentDoc().units).toBe("in");
    expect(lastToast()).toBe("This design now uses inches");
    expect((await rebuildNow()).report.bodies[0]!.volume).toBeCloseTo(8000, 6);
    setDesignUnits("in");
    setDesignUnits("mm");
    expect(currentDoc().units).toBeUndefined();
    expect(lastToast()).toBe("This design now uses millimetres");
  });

  it("gives a new blank design the printer's fit and the chosen measuring system", async () => {
    const prefs = usePrefs.getState();
    usePrefs.setState({ printerFit: 0.15, units: "imperial" });

    try {
      expect(withPrinterFit(emptyDocument()).fit).toBe("0.15 mm");
      // A design with its own fit keeps it.
      expect(withPrinterFit({ ...emptyDocument(), fit: "0.3 mm" }).fit).toBe("0.3 mm");
      await newProject(undefined, "Imperial");
      expect(currentDoc()).toMatchObject({ units: "in", fit: "0.15 mm" });
      // A file opened keeps what it has.
      await newProject({ ...emptyDocument(), features: block }, "Opened");
      expect(currentDoc().fit).toBeUndefined();
      expect(currentDoc().units).toBeUndefined();
    } finally {
      usePrefs.setState({ printerFit: prefs.printerFit, units: prefs.units });
    }
  });
});

describe("projects that cannot be saved or found", () => {
  it("says when saving fails", async () => {
    const id = useApp.getState().project!.id;
    const kept = testFiles.projects.get(id)!;
    testFiles.projects.delete(id);
    apply({ type: "set_param", name: "x", expr: "1 mm" });
    await flushSave();
    expect(useApp.getState().saveState).toBe("unsaved");
    expect(lastToast()).toMatch(/^Could not save: no project/);
    testFiles.projects.set(id, kept);
    await flushSave();
    expect(useApp.getState().saveState).toBe("saved");
  });

  it("says a project is gone and closes its tab", async () => {
    useApp.setState({ tabs: [...useApp.getState().tabs, { id: "ghost", name: "Ghost" }] });
    await openProject("ghost");
    expect(lastToast()).toBe("Project not found");
    expect(useApp.getState().tabs.some((t) => t.id === "ghost")).toBe(false);
  });

  it("saves a project an assistant takes over and moves on to the next tab", async () => {
    await newProject(undefined, "Mine");

    const mine = useApp.getState().project!.id;
    await newProject(undefined, "Theirs");

    const theirs = useApp.getState().project!.id;
    apply({ type: "set_param", name: "k", expr: "3 mm" });
    await releaseProject(theirs);
    expect(testFiles.projects.get(theirs)!.doc.params["k"]).toBe("3 mm");
    expect(useApp.getState().tabs.some((t) => t.id === theirs)).toBe(false);
    expect(useApp.getState().project?.id).not.toBe(theirs);
    // A tab in the background just goes.
    await releaseProject(mine);
    expect(useApp.getState().tabs.some((t) => t.id === mine)).toBe(false);
  });
});
