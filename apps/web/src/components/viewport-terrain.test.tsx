/**
 * Clicks on a terrain in the 3D view (ViewportView.tsx): the ground's right-click menu (mark a line,
 * an area, a highlight, a note, a stake-out point; measure from here; a sketch on the ground; clean
 * up) each starts what it says at the point clicked; while marking, a click adds a point where the
 * ground is; while a part is set onto the terrain, a click places it there, a click off the terrain
 * says so; moving the mouse over the ground follows it.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, closeSketch, currentDoc, getViewport, newProject, rebuildNow, useApp } from "../store";
import { pickMenu, rebuilt, renderUi, withScreen } from "../../test/ui";
import { glb } from "../../../../tests/glbs";
import { addTerrain, useTerrainPlace } from "../lib/terrain";
import { cancelMarking, useTerrainDraw } from "../lib/terrainDraw";
import { ViewportView } from "./ViewportView";

const settle = (ms = 50) => act(async () => new Promise((r) => setTimeout(r, ms)));
const ground = glb([{ x: 0, y: 0, z: 0, s: 40_000 }]);
let vp: Viewport;
const rect = (w: number): SketchEntity[] => [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: w, y: 0 },
  { id: "p3", type: "point", x: w, y: w },
  { id: "p4", type: "point", x: 0, y: w },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
async function clickAt(w: [number, number, number], button = 0) {
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
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Ground clicks");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(500), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 500, mode: "new_body" },
  ] as Feature[] });
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => addTerrain({ folder: "Yard", photos: 3, size: [40_000, 40_000, 100], measured: false } as never, ground));
  await settle(300);
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
    // Near and far follow the view (the stand-in renderer draws no frames to do it).
    (vp as unknown as { updateClipping(): void }).updateClipping();
  });
});
beforeEach(() => {
  useApp.setState({ selection: [] });
  if (useTerrainDraw.getState().kind) cancelMarking();
});
afterAll(cleanup);

describe("clicks on the ground", () => {
  const SPOT: [number, number, number] = [20_000, 20_000, 0];

  it("starts marking from the ground's menu, and adds points where clicked", async () => {
    for (const [label, kind] of [["Mark a line", "line"], ["Mark an area", "area"], ["Highlighter", "stroke"], ["Pin a note here", "note"], ["Stake-out point here", "point"]] as const) {
      await clickAt(SPOT, 2);
      await pickMenu(label);
      // A note or a stake-out point is one point: it is placed at once (a note then asks for its text).
      if (kind === "note" || kind === "point") {
        await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
        continue;
      }
      expect(useTerrainDraw.getState().kind, label).toBe(kind);
      if (kind === "line") {
        const n = useTerrainDraw.getState().points.length;
        await clickAt([25_000, 22_000, 0]);
        expect(useTerrainDraw.getState().points.length).toBe(n + 1);
        // Moving over the ground shows where the next point goes.
        const [x, y] = vp.worldToScreen([26_000, 22_000, 0])!;
        await act(async () => void fireEvent.pointerMove(vp.canvas, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", buttons: 0 }));
        await settle(60);
        expect(useTerrainDraw.getState().hover).not.toBeNull();
      }
      cancelMarking();
    }
  });

  it("measures from the ground, sketches on it and offers to clean up", async () => {
    await clickAt(SPOT, 2);
    await pickMenu("Measure from here");
    expect(useApp.getState().measure.active).toBe(true);
    useApp.setState({ measure: { active: false, picks: [], result: null } } as never);
    await clickAt(SPOT, 2);
    await pickMenu("New sketch here on the ground");
    expect(useApp.getState().sketchId).not.toBeNull();
    await act(async () => closeSketch());
    await clickAt(SPOT, 2);
    await pickMenu("Clean up…");
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
  });

  it("places a part where the ground is clicked, and says so when off the ground", async () => {
    await act(async () => useTerrainPlace.setState({ body: "ex1", offset: 0, move: null }));
    // Over the ground the part follows the mouse.
    const [hx, hy] = vp.worldToScreen([30_000, 30_000, 0])!;
    await act(async () => void fireEvent.pointerMove(vp.canvas, { clientX: hx, clientY: hy, pointerId: 1, pointerType: "mouse", buttons: 0 }));
    await settle(60);
    await clickAt([30_000, 30_000, 0]);
    await rebuilt();
    const b = (await rebuildNow()).report.bodies.find((x) => x.id === "ex1")!.bbox;
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(30_000, -2);
    expect(b.min[2]).toBeCloseTo(0, 0);
    await act(async () => useTerrainPlace.setState({ body: "ex1", offset: 0, move: null }));
    await clickAt([-80_000, -80_000, 0]);
    expect(toasts()).toMatch(/Click on the terrain/);
    await act(async () => useTerrainPlace.setState({ body: null } as never));
    expect(currentDoc().features.length).toBeGreaterThan(2);
  });
});
