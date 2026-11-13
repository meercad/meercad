/**
 * Taking geometry from the model into a sketch, in the real 3D view from above: the section tool
 * traces where the sketch plane cuts a mesh part (a 30 × 20 mm box cut halfway up: a 30 × 20
 * outline of 600 mm²), by a click on the orange line or all at once; the project tool brings a
 * clicked model edge in as a projection. Clicks beside them say what to click.
 */
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity, SketchFeature } from "@meercad/schema";
import { writeStl } from "@meercad/io";
import { THREE, type Viewport } from "@meercad/viewport";
import { prism } from "../../../../tests/acceptance/meshes";
import { testCall } from "../lib/mcpBridge";
import { apply, closeSketch, currentDoc, getViewport, rebuildNow, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool } from "./state";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 100, y: 0 },
  { id: "p2", type: "point", x: 140, y: 0 },
  { id: "p3", type: "point", x: 140, y: 20 },
  { id: "p4", type: "point", x: 100, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) =>
  writeStl([
    {
      positions: Float32Array.from(corners),
      indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i),
    },
  ]);
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";

async function clickAt(w: [number, number, number]) {
  (vp as unknown as { scene: THREE.Scene }).scene.updateMatrixWorld(true);

  const [x, y] = vp.worldToScreen(w)!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(400);
}

async function sketchAtHalfHeight() {
  await act(async () => startSketch({ ref: "pl5" }));
  await act(async () =>
    vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(60, 10, 5)),
  );
  await settle(60);
}

beforeAll(async () => {
  withScreen();
  await testCall("new_project", { name: "Tracing" });
  await testCall("import_file", {
    name: "box.stl",
    base64: b64(
      stlOf(
        prism(
          [
            [0, 0],
            [30, 0],
            [30, 20],
            [0, 20],
          ],
          10,
        ),
      ),
    ),
  });
  apply({
    type: "add_features",
    features: [
      { id: "pl5", op: "plane", base: { ref: "origin.XY" }, offset: 5 },
      { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 10,
        mode: "new_body",
      },
    ] as Feature[],
  });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
});
afterEach(async () => {
  await act(async () => closeSketch());
});

describe("geometry from the model", () => {
  it("traces where the sketch cuts the mesh: a 30 × 20 outline of 600 mm²", async () => {
    await sketchAtHalfHeight();
    await act(async () => setTool("section"));
    await settle();
    // Beside the line: it says what to click.
    await clickAt([15, 10, 5]);
    expect(lastToast()).toMatch(/Click the orange section line of the mesh/);
    await clickAt([15, 0, 5]);
    expect(lastToast()).toMatch(/Traced \d+ curves?/);

    const out = await rebuildNow();
    const regions = out.report.sketches.find((s) => s.id === sketch().id)!.regions;
    expect(regions[0]!.area).toBeCloseTo(600, 3);
  });

  it("traces every section at once from the panel", async () => {
    await sketchAtHalfHeight();
    await act(async () => setTool("section"));
    await settle();
    await act(async () => void fireEvent.click(screen.getByText(/^Trace all \(1\)$/)));

    const out = await rebuildNow();
    expect(out.report.sketches.find((s) => s.id === sketch().id)!.regions[0]!.area).toBeCloseTo(600, 3);
  });

  it("projects a clicked model edge, and says to click an edge elsewhere", async () => {
    await sketchAtHalfHeight();
    await act(async () => setTool("project"));
    await clickAt([200, 200, 5]);
    expect(lastToast()).toBe("Click a model edge to project it into the sketch");
    // The block's top edge along y = 0, from x 100 to 140.
    await clickAt([120, 0, 10]);

    const pr = sketch().entities.find((e) => e.type === "projection");
    expect(pr).toBeDefined();

    const out = await rebuildNow();
    const curve = out.report.sketches
      .find((s) => s.id === sketch().id)!
      .curves.find((c) => c.kind === "line") as { a: [number, number]; b: [number, number] } | undefined;
    expect(curve).toBeDefined();
    expect(Math.hypot(curve!.b[0] - curve!.a[0], curve!.b[1] - curve!.a[1])).toBeCloseTo(40, 6);
  });
});
