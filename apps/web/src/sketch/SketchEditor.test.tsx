/**
 * Drawing in the sketch editor (SketchEditor.tsx) with the pointer on the real 3D view, seen from
 * above on an 800 × 600 screen: lines, rectangles and circles land at the sketch coordinates
 * pointed at, typed sizes are exact, and the sketch's closed region has the drawn area.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { closeSketch, currentDoc, getViewport, newProject, rebuildNow, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool, useSketchUi } from "./state";

let vp: Viewport;
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;
const points = () => sketch().entities.filter((e): e is Extract<SketchEntity, { type: "point" }> => e.type === "point");

/** A click (press and release) at sketch coordinates (u, v) on XY. */
async function clickAt(u: number, v: number, opts: { shiftKey?: boolean } = {}) {
  const [x, y] = vp.worldToScreen([u, v, 0])!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true, ...opts };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, ev);
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await act(async () => new Promise((r) => setTimeout(r, 20)));
}

beforeEach(async () => {
  withScreen();
  await newProject(undefined, "Sketching");
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => startSketch({ ref: "origin.XY" }));
  // From above, looking at (20, 10): the points drawn here are all on the screen.
  await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 0)));
  expect(useApp.getState().sketchId).not.toBeNull();
  // The editor settles (it starts with the line tool) before a test picks its tool.
  await act(async () => new Promise((r) => setTimeout(r, 50)));
});
afterEach(async () => {
  await act(async () => closeSketch());
  cleanup();
});

describe("drawing in a sketch", () => {
  it("draws a line from point to point", async () => {
    await act(async () => setTool("line"));
    await clickAt(0, 0);
    await clickAt(30, 0);
    const pts = points().map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
    expect(pts).toContainEqual([0, 0]);
    expect(pts).toContainEqual([30, 0]);
    expect(sketch().entities.filter((e) => e.type === "line")).toHaveLength(1);
  });

  it("draws a rectangle whose region has its area", async () => {
    await act(async () => setTool("rect"));
    await clickAt(0, 0);
    await clickAt(40, 20);
    expect(sketch().entities.filter((e) => e.type === "line")).toHaveLength(4);
    const out = await rebuildNow();
    const sk = out.report.sketches.find((s) => s.id === sketch().id)!;
    expect(sk.regions).toHaveLength(1);
    expect(sk.regions[0]!.area).toBeCloseTo(800, 0);
  });

  it("draws a circle round a centre", async () => {
    await act(async () => setTool("circle"));
    await clickAt(10, 10);
    await clickAt(15, 10);
    const c = sketch().entities.find((e) => e.type === "circle") as Extract<SketchEntity, { type: "circle" }>;
    expect(c).toBeDefined();
    expect(c.radius).toBeCloseTo(5, 0);
    const out = await rebuildNow();
    expect(out.report.sketches.find((s) => s.id === sketch().id)!.regions[0]!.area).toBeCloseTo(Math.PI * c.radius ** 2, 1);
  });

  /** Types into the open size fields at the cursor: the first value, Tab, the next, Enter. */
  async function typeSizes(...values: string[]) {
    for (const [i, v] of values.entries()) {
      if (i === 0) await act(async () => void fireEvent.keyDown(window, { key: v[0]! }));
      const inputs = [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
      expect(inputs.length).toBeGreaterThan(i);
      await act(async () => void fireEvent.change(inputs[i]!, { target: { value: v } }));
    }
    const inputs = [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
    await act(async () => void fireEvent.keyDown(inputs[0]!, { key: "Enter" }));
  }

  it("draws a rectangle of typed size from its corner", async () => {
    await act(async () => setTool("rect"));
    await clickAt(5, 5);
    await typeSizes("50", "30");
    const out = await rebuildNow();
    const sk = out.report.sketches.find((s) => s.id === sketch().id)!;
    expect(sk.regions[0]!.area).toBeCloseTo(1500, 6);
  });

  it("draws a circle of typed diameter", async () => {
    await act(async () => setTool("circle"));
    await clickAt(20, 10);
    await typeSizes("12");
    const c = sketch().entities.find((e) => e.type === "circle") as Extract<SketchEntity, { type: "circle" }>;
    expect(c.radius).toBeCloseTo(6, 9);
  });

  it("draws a line of typed length and angle", async () => {
    await act(async () => setTool("line"));
    await clickAt(0, 0);
    await typeSizes("25", "90");
    const out = await rebuildNow();
    const line = out.report.sketches.find((s) => s.id === sketch().id)!.curves.find((c) => c.kind === "line") as { a: [number, number]; b: [number, number] };
    expect(Math.hypot(line.b[0] - line.a[0], line.b[1] - line.a[1])).toBeCloseTo(25, 6);
    expect(Math.abs(line.b[0] - line.a[0])).toBeCloseTo(0, 6);
  });

  it("goes back to selecting with Escape and leaves the sketch", async () => {
    await act(async () => setTool("line"));
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(useSketchUi.getState().tool).toBe("select");
  });
});
