/**
 * More of the 3D view's right-click menus and clicks (ViewportView.tsx): on a sketch region (extrude
 * it, edit or hide its sketch), on a plane (sketch on it, delete it), on a mesh part (move, mirror,
 * hide, lay down), and a click while a new sketch waits for its plane (a flat face takes it) or a
 * part waits to be laid on a face.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { writeStl } from "@meercad/io";
import type { Viewport } from "@meercad/viewport";
import { prism } from "../../../../tests/acceptance/meshes";
import { testCall } from "../lib/mcpBridge";
import { apply, cancelDialog, closeSketch, currentDoc, getViewport, rebuildNow, useApp } from "../store";
import { usePrintCheck } from "../lib/printability";
import { pickMenu, rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

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
async function clickAt(w: [number, number, number], button = 0) {
  (vp as unknown as { scene: { updateMatrixWorld(f: boolean): void } }).scene.updateMatrixWorld(true);
  const [x, y] = vp.worldToScreen(w)!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 << button });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(350);
}

beforeAll(async () => {
  withScreen();
  await testCall("new_project", { name: "Menus" });
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
    { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("q", 60, 0, 10, 10), constraints: [] },
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
beforeEach(() => useApp.setState({ selection: [], showSketches: true } as never));
afterAll(cleanup);

describe("more right-click menus", () => {
  it("extrudes a sketch region from its menu, and hides its sketch", async () => {
    await clickAt([65, 5, 0], 2);
    await pickMenu("Extrude");
    expect(useApp.getState().dialog?.feature.op).toBe("extrude");
    await act(async () => cancelDialog());
    await clickAt([65, 5, 0], 2);
    await pickMenu("Hide sketch");
    expect(useApp.getState().hidden.has("sk2")).toBe(true);
    useApp.setState({ hidden: new Set() });
    await rebuilt();
    await clickAt([65, 5, 0], 2);
    await pickMenu(/^Edit sketch/);
    expect(useApp.getState().sketchId).toBe("sk2");
    await act(async () => closeSketch());
  });

  it("offers a mesh part's actions: hide it and lay it down", async () => {
    await clickAt([15, 50, 2], 2);
    // A mesh part is selected whole.
    expect(new Set(useApp.getState().selection.map((p) => (p as { bodyId: string }).bodyId))).toEqual(new Set([mesh]));
    await pickMenu(/^Hide/);
    expect(useApp.getState().hidden.has(mesh)).toBe(true);
    useApp.setState({ hidden: new Set() });
    await rebuilt();
    await clickAt([15, 50, 2], 2);
    await pickMenu(/^Move/);
    expect(useApp.getState().dialog?.feature.op).toBe("transform");
    await act(async () => cancelDialog());
  });

  it("sketches on a flat face clicked while a new sketch waits for its plane", async () => {
    await act(async () => useApp.setState({ pickingSketchPlane: true }));
    await clickAt([20, 10, 10]);
    const sk = currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as Extract<Feature, { op: "sketch" }>;
    expect(sk.plane).toMatchObject({ face: expect.anything() });
    await act(async () => closeSketch());
  });

  it("lays a part on the face clicked while waiting for one", async () => {
    await act(async () => usePrintCheck.setState({ picking: true }));
    // Seen from above, the block's top is what is clicked: it goes down, the block stays 10 high on the plate.
    // (Away from the last click, so it is no double-click.)
    await settle(500);
    await clickAt([28, 13, 10]);
    expect(usePrintCheck.getState().picking).toBe(false);
    const box = (await rebuildNow()).report.bodies.find((b) => b.id === "ex1")!.bbox;
    expect(box.min[2]).toBeCloseTo(0, 6);
    expect(box.max[2]! - box.min[2]!).toBeCloseTo(10, 6);
    // A click on nothing ends the waiting.
    await act(async () => usePrintCheck.setState({ picking: true }));
    await clickAt([200, 200, 0]);
    expect(usePrintCheck.getState().picking).toBe(false);
  });
});
