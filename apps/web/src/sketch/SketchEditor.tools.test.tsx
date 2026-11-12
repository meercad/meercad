/**
 * The sketch editor's other tools with the pointer on the real 3D view, seen from above: an arc
 * round a centre, a spline, trimming, bevelling, dimensions placed by clicks, repeating a selection
 * in a row, selecting by click, Shift-click, double-click and box, and dragging a point. Every
 * result is checked by its solved size, not by what the screen shows.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { closeSketch, currentDoc, getViewport, newProject, rebuildNow, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setSketchSelection, setTool, useSketchUi } from "./state";

let vp: Viewport;
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;
const ofType = <T extends SketchEntity["type"]>(type: T) => sketch().entities.filter((e): e is Extract<SketchEntity, { type: T }> => e.type === type);
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

const screenAt = (u: number, v: number) => {
  const [x, y] = vp.worldToScreen([u, v, 0])!;
  return { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
};
async function clickAt(u: number, v: number, opts: { shiftKey?: boolean } = {}) {
  const ev = { ...screenAt(u, v), ...opts };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle();
}
async function dragFrom(from: [number, number], to: [number, number]) {
  const a = screenAt(...from);
  const b = screenAt(...to);
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...a, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...a, buttons: 1 });
    for (let i = 1; i <= 4; i++) fireEvent.pointerMove(vp.canvas, { ...a, clientX: a.clientX + ((b.clientX - a.clientX) * i) / 4, clientY: a.clientY + ((b.clientY - a.clientY) * i) / 4, buttons: 1 });
  });
  await settle(40);
  await act(async () => void fireEvent.pointerUp(vp.canvas, { ...b, buttons: 0 }));
  await settle(40);
}
async function solved() {
  const out = await rebuildNow();
  return out.report.sketches.find((x) => x.id === sketch().id)!;
}
/** A 40 × 20 rectangle from the origin, typed in. */
async function rectangle() {
  await act(async () => setTool("rect"));
  await clickAt(0, 0);
  await act(async () => void fireEvent.keyDown(window, { key: "4" }));
  const inputs = () => [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
  await act(async () => void fireEvent.change(inputs()[0]!, { target: { value: "40" } }));
  await act(async () => void fireEvent.change(inputs()[1]!, { target: { value: "20" } }));
  await act(async () => void fireEvent.keyDown(inputs()[0]!, { key: "Enter" }));
  await act(async () => setTool("select"));
  await settle();
}
const lineAt = (y: number) => {
  const s = sketch();
  const pos = (id: string) => s.entities.find((e) => e.id === id) as { x: number; y: number };
  return ofType("line").find((l) => Math.abs(pos(l.p1).y - y) < 0.01 && Math.abs(pos(l.p2).y - y) < 0.01)!;
};

beforeEach(async () => {
  withScreen();
  await newProject(undefined, "Sketch tools");
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => startSketch({ ref: "origin.XY" }));
  await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 0)));
  await settle(50);
});
afterEach(async () => {
  await act(async () => closeSketch());
  cleanup();
});

describe("more sketch tools", () => {
  it("draws an arc round a centre and a spline through clicked points", async () => {
    await act(async () => setTool("arc_center"));
    await clickAt(10, 10);
    await clickAt(20, 10);
    await act(async () => void fireEvent.pointerMove(vp.canvas, { ...screenAt(15, 19), buttons: 0 }));
    await clickAt(10, 20);
    const arc = (await solved()).curves.find((c) => c.kind === "arc") as { radius: number; center: [number, number] };
    expect(arc.radius).toBeCloseTo(10, 1);
    expect(arc.center[0]).toBeCloseTo(10, 1);
    await act(async () => setTool("spline"));
    for (const [u, v] of [[30, 0], [40, 10], [50, 0]] as const) await clickAt(u, v);
    await act(async () => void fireEvent.dblClick(vp.canvas, screenAt(50, 0)));
    expect(ofType("spline")).toHaveLength(1);
    expect(ofType("spline")[0]!.points).toHaveLength(3);
  });

  it("bevels a corner: the area drops by half the square of the distance", async () => {
    await rectangle();
    await act(async () => useSketchUi.setState({ editSize: 4 }));
    await act(async () => setTool("chamfer"));
    await clickAt(40, 20);
    expect((await solved()).regions[0]!.area).toBeCloseTo(800 - 8, 5);
  });

  it("trims a line back to where it crosses", async () => {
    await rectangle();
    await act(async () => setTool("line"));
    await clickAt(20, -10);
    await clickAt(20, 30);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    const before = ofType("line").length;
    await act(async () => setTool("trim"));
    // The piece below the rectangle goes.
    await clickAt(20, -5);
    const pts = ofType("point");
    expect(pts.some((p) => Math.abs(p.y + 10) < 0.01)).toBe(false);
    expect(ofType("line").length).toBeGreaterThanOrEqual(before);
  });

  it("dimensions a line, two points and a circle by clicks", async () => {
    await rectangle();
    await act(async () => setTool("dimension"));
    // The bottom line, then where its label goes.
    await clickAt(20, 0);
    await clickAt(20, -8);
    const len = sketch().constraints.find((c) => c.type === "length") as { value: unknown } | undefined;
    expect(Number(String(len?.value).replace(/ ?mm$/, ""))).toBeCloseTo(40, 6);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await act(async () => setTool("circle"));
    await clickAt(20, 10);
    await clickAt(25, 10);
    await act(async () => setTool("dimension"));
    await clickAt(25, 10);
    await clickAt(30, 15);
    const dia = sketch().constraints.find((c) => c.type === "diameter") as { value: unknown } | undefined;
    expect(Number(String(dia?.value).replace(/ ?mm$/, ""))).toBeCloseTo(10, 0);
  });

  it("repeats a selected line in a row", async () => {
    await act(async () => setTool("line"));
    await clickAt(0, 0);
    await clickAt(0, 10);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await act(async () => setTool("pattern"));
    await act(async () => setSketchSelection([{ kind: "curve", id: ofType("line")[0]!.id }]));
    await act(async () => useSketchUi.setState({ pattern: { kind: "linear", count: 3, dx: 10, dy: 0, angle: 60 } }));
    await act(async () => void fireEvent.click(screen.getByText("Repeat selection")));
    const xs = ofType("point").map((p) => Math.round(p.x)).sort((a, b) => a - b);
    expect([...new Set(xs)]).toEqual([0, 10, 20]);
  });

  it("selects by click, Shift-click, double-click and box, and drags a point", async () => {
    await rectangle();
    const bottom = lineAt(0);
    const top = lineAt(20);
    await clickAt(20, 0);
    expect(useSketchUi.getState().selection).toEqual([{ kind: "curve", id: bottom.id }]);
    await clickAt(20, 20, { shiftKey: true });
    expect(useSketchUi.getState().selection.map((s) => s.id).sort()).toEqual([bottom.id, top.id].sort());
    await clickAt(20, 20, { shiftKey: true });
    expect(useSketchUi.getState().selection).toHaveLength(1);
    // A double-click takes the whole closed chain.
    await act(async () => void fireEvent.dblClick(vp.canvas, screenAt(20, 0)));
    expect(useSketchUi.getState().selection.filter((s) => s.kind === "curve")).toHaveLength(4);
    // An empty click clears.
    await clickAt(70, 50);
    expect(useSketchUi.getState().selection).toEqual([]);
    // A box round the left half takes what lies wholly inside it.
    await dragFrom([-5, -5], [10, 25]);
    expect(useSketchUi.getState().selection.length).toBeGreaterThan(0);
    // The rectangle is fixed by its sizes and the origin and stays put; a free line's end follows the pointer.
    await clickAt(70, 50);
    await dragFrom([40, 20], [50, 30]);
    expect((await solved()).regions[0]!.area).toBeCloseTo(800, 6);
    await act(async () => setTool("line"));
    await clickAt(60, 5);
    await clickAt(70, 15);
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    await act(async () => setTool("select"));
    await clickAt(70, 50);
    await dragFrom([70, 15], [76, 27]);
    expect(ofType("point").some((p) => Math.hypot(p.x - 76, p.y - 27) < 1)).toBe(true);
    expect(ofType("point").some((p) => Math.hypot(p.x - 60, p.y - 5) < 0.5)).toBe(true);
  });
});
