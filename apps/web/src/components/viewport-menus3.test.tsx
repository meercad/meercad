/**
 * Every entry of the 3D view's right-click menus (ViewportView.tsx) does what it says: on a face of a
 * part (sketch on it, push/pull, fillet, chamfer, shell, hole, hide, copy, duplicate, see-through,
 * material, mirror, lay on it, measure, delete the face or the part), on a mesh part (mirror, copy,
 * duplicate, see-through, material, lay down, a Gridfinity bin for it, delete), on a plane (sketch on
 * it, offset it, delete it) and on empty space (select all, paste, fit, planes, show all).
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { writeStl } from "@meercad/io";
import type { Viewport } from "@meercad/viewport";
import { prism } from "../../../../tests/acceptance/meshes";
import { testCall } from "../lib/mcpBridge";
import { apply, cancelDialog, closeSketch, currentDoc, getViewport, rebuildNow, undo, useApp } from "../store";
import { answer, pickMenu, rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";
import { fireEvent } from "@testing-library/react";

const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) => writeStl([{ positions: Float32Array.from(corners), indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i) }]);
let vp: Viewport;
let mesh = "";
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
/** A right-click (or click) at a point in the model, away from the last one so it is no double-click. */
async function clickAt(w: [number, number, number], button = 2) {
  (vp as unknown as { scene: { updateMatrixWorld(f: boolean): void } }).scene.updateMatrixWorld(true);
  const [x, y] = vp.worldToScreen(w)!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 << button });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(450);
}
const TOP: [number, number, number] = [20, 10, 10];
const PLATE: [number, number, number] = [15, 50, 2];
const op = () => useApp.getState().dialog?.feature.op;
const bodies = async () => (await rebuildNow()).report.bodies.map((b) => b.id).sort();
const closeDialog = () => act(async () => cancelDialog());

beforeAll(async () => {
  withScreen();
  await testCall("new_project", { name: "All menus" });
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
    { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: -20 },
  ] as Feature[] });
  mesh = ((await testCall("import_file", { name: "plate.stl", base64: b64(stlOf(prism([[0, 40], [30, 40], [30, 60], [0, 60]], 2))) })) as { added: string[] }).added[0]!;
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
beforeEach(() => useApp.setState({ selection: [], showPlanes: true } as never));
afterAll(cleanup);

describe("a part's face", () => {
  it("starts the face's tools", async () => {
    for (const [label, want] of [["Push/pull face", "extrude"], ["Fillet face edges", "fillet"], ["Chamfer face edges", "chamfer"], [/^Shell/, "shell"], ["Mirror part", "mirror"], ["Hole here", "hole"]] as const) {
      await clickAt(TOP);
      await pickMenu(label);
      expect(op(), String(label)).toBe(want);
      await closeDialog();
    }
  });

  it("sketches on it", async () => {
    await clickAt(TOP);
    await pickMenu("New sketch on face");
    expect(useApp.getState().sketchId).not.toBeNull();
    await act(async () => closeSketch());
    // Nothing drawn: the empty sketch goes again.
    await act(async () => void undo());
  });

  it("hides, shows see-through and back, and measures from it", async () => {
    await clickAt(TOP);
    await pickMenu("Show see-through");
    expect(currentDoc().seeThrough).toContain("ex1");
    await clickAt(TOP);
    await pickMenu("Show solid");
    expect(currentDoc().seeThrough ?? []).not.toContain("ex1");
    await clickAt(TOP);
    await pickMenu("Measure");
    expect(useApp.getState().measure.active).toBe(true);
    expect(useApp.getState().measure.picks).toHaveLength(1);
    useApp.setState({ measure: { active: false, picks: [], result: null } } as never);
    await clickAt(TOP);
    await pickMenu(/^Hide/);
    expect(useApp.getState().hidden.has("ex1")).toBe(true);
    useApp.setState({ hidden: new Set() });
    await rebuilt();
  });

  it("opens the material picker for the part", async () => {
    const asked: unknown[] = [];
    const on = (e: Event) => void asked.push((e as CustomEvent).detail);
    window.addEventListener("meercad:materials", on);
    await clickAt(TOP);
    await pickMenu("Material…");
    window.removeEventListener("meercad:materials", on);
    expect(asked).toEqual([["ex1"]]);
  });

  it("copies and duplicates the part: a second one beside it", async () => {
    await clickAt(TOP);
    await pickMenu("Duplicate");
    await rebuilt();
    expect((await bodies()).length).toBe(3);
    await act(async () => void undo());
    await rebuilt();
    expect((await bodies()).length).toBe(2);
    await clickAt(TOP);
    await pickMenu("Copy");
  });

  it("lays the part on the face, and deletes the face's step or the part", async () => {
    await clickAt([20, 0.01, 5]);
    await clickAt(TOP);
    await pickMenu("Lay on this face");
    await rebuilt();
    const box = (await rebuildNow()).report.bodies.find((b) => b.id === "ex1")!.bbox;
    // Its top now lies down: the part stands upside down, still 10 high.
    expect(box.max[2]! - box.min[2]!).toBeCloseTo(10, 6);
    await act(async () => void undo());
    await rebuilt();
    await clickAt(TOP);
    await pickMenu(/^Delete ex1|^Delete Extrude/);
    await rebuilt();
    expect(await bodies()).not.toContain("ex1");
    await act(async () => void undo());
    await rebuilt();
    expect(await bodies()).toContain("ex1");
  });
});

describe("a mesh part", () => {
  it("mirrors, makes a bin for it, shows it see-through, copies it", async () => {
    await clickAt(PLATE);
    await pickMenu("Mirror part");
    expect(op()).toBe("mirror");
    await closeDialog();
    await clickAt(PLATE);
    await pickMenu("Gridfinity bin for this part");
    expect(op()).toBe("gridfinity");
    await closeDialog();
    await clickAt(PLATE);
    await pickMenu("Show see-through");
    expect(currentDoc().seeThrough).toContain(mesh);
    await clickAt(PLATE);
    await pickMenu("Show solid");
    await clickAt(PLATE);
    await pickMenu("Copy");
  });

  it("duplicates, lays down and deletes it", async () => {
    await clickAt(PLATE);
    await pickMenu("Duplicate");
    await rebuilt();
    expect((await bodies()).length).toBe(3);
    await act(async () => void undo());
    await rebuilt();
    await clickAt(PLATE);
    await pickMenu("Lay on this face");
    await rebuilt();
    await act(async () => void undo());
    await rebuilt();
    await clickAt(PLATE);
    await pickMenu(/^Delete /);
    await rebuilt();
    expect(await bodies()).not.toContain(mesh);
    await act(async () => void undo());
    await rebuilt();
  });
});

describe("a plane and empty space", () => {
  it("sketches on a plane, offsets it, deletes it", async () => {
    // Seen from below, the plane 20 mm under the parts is the first thing there.
    await act(async () => vp.setView("bottom", false));
    await clickAt([36, 30, -20]);
    await pickMenu(/^New sketch on/);
    expect(useApp.getState().sketchId).not.toBeNull();
    await act(async () => closeSketch());
    await act(async () => void undo());
    await clickAt([36, 30, -20]);
    await pickMenu("Offset plane");
    expect(op()).toBe("plane");
    await closeDialog();
    await clickAt([36, 30, -20]);
    await pickMenu("Delete plane");
    await act(async () => void answer().catch(() => undefined));
    await rebuilt();
    expect(currentDoc().features.some((f) => f.id === "pl1")).toBe(false);
    await act(async () => vp.setView("top", false));
  });

  it("selects all, pastes, fits, hides planes and shows everything", async () => {
    await clickAt([200, 200, 0]);
    await pickMenu("Select all parts");
    expect(useApp.getState().selection.length).toBeGreaterThan(0);
    useApp.setState({ selection: [] });
    await clickAt([200, 210, 0]);
    await pickMenu("Paste");
    await rebuilt();
    expect((await bodies()).length).toBeGreaterThan(2);
    await clickAt([210, 200, 0]);
    await pickMenu("Fit view");
    await clickAt([200, 190, 0]);
    await pickMenu("Hide planes");
    expect(useApp.getState().showPlanes).toBe(false);
    useApp.setState({ hidden: new Set(["ex1"]) });
    await clickAt([190, 200, 0]);
    await pickMenu("Show all parts");
    expect(useApp.getState().hidden.size).toBe(0);
  });
});
