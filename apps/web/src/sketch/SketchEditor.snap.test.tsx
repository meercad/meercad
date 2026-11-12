/**
 * Snapping in the sketch editor, on the real 3D view from above: a click near a line's middle lands
 * exactly on it, near where two lines cross exactly at the crossing, near a line on the line; on a
 * part's face, near the hole's centre exactly on the centre and near a corner on the corner. Alt
 * turns snapping off. Positions are checked in the model's coordinates.
 */
import { act, fireEvent } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { apply, closeSketch, currentDoc, getViewport, newProject, rebuildNow, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool } from "./state";

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
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "c", type: "point", x: 20, y: 10 }, { id: "k", type: "circle", center: "c", radius: 4 }], constraints: [] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 40, mode: "cut" },
];
let vp: Viewport;
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;
/** A click at the model point (x, y, z). */
async function clickAt(w: [number, number, number], opts: { altKey?: boolean } = {}) {
  const [x, y] = vp.worldToScreen(w)!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true, ...opts };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle();
}
/** The open sketch's points in model coordinates. */
async function worldPoints(): Promise<Map<string, [number, number, number]>> {
  const out = await rebuildNow();
  const view = out.report.sketches.find((s) => s.id === sketch().id)!;
  const { origin: o, u, v } = view.frame;
  return new Map((view.points as unknown as [string, number, number][]).map(([id, x, y]) => [id, [0, 1, 2].map((k) => o[k]! + u[k]! * x + v[k]! * y) as [number, number, number]]));
}
const near = (pts: Map<string, number[]>, p: number[], tol = 1e-6) => [...pts.values()].some((q) => Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!) < tol);

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Snapping");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 10)));
});
afterEach(async () => {
  await act(async () => closeSketch());
});

describe("snapping in a sketch", () => {
  it("lands on a line's middle, a crossing and a line itself", async () => {
    await act(async () => startSketch({ ref: "origin.XY" }));
    await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 0)));
    await settle(50);
    await act(async () => setTool("line"));
    await clickAt([50, 0, 0]);
    await clickAt([70, 0, 0]);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await clickAt([60, -10, 0]);
    await clickAt([60, 10, 0]);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await act(async () => setTool("point"));
    // Near the first line's middle (60, 0): also where the lines cross; the crossing wins there.
    await clickAt([60.3, 0.2, 0]);
    // Near the second line, away from both ends and the middle.
    await clickAt([60.2, 6, 0]);
    // With Alt, exactly where clicked.
    await clickAt([52.37, 3.11, 0], { altKey: true });
    const pts = await worldPoints();
    expect(near(pts, [60, 0, 0])).toBe(true);
    // On the line x = 60 exactly, about where clicked along it.
    expect([...pts.values()].some((q) => Math.abs(q[0]! - 60) < 1e-6 && Math.abs(q[1]! - 6) < 0.5)).toBe(true);
    expect(near(pts, [52.37, 3.11, 0], 0.05)).toBe(true);
  });

  it("lands on the hole's centre and the face's corner, sketching on the part's top", async () => {
    await act(async () => startSketch({ face: { face: "ex1.end_cap" } }));
    await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 10)));
    await settle(50);
    await act(async () => setTool("point"));
    await clickAt([20.4, 10.3, 10]);
    await clickAt([39.6, 19.7, 10]);
    const pts = await worldPoints();
    expect(near(pts, [20, 10, 10])).toBe(true);
    expect(near(pts, [40, 20, 10])).toBe(true);
  });
});
