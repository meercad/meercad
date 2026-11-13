/**
 * The sketch editor's panel and keys (SketchEditor.tsx) with the pointer on the real 3D view: edits
 * that cannot be done say why (a rounding too big for its corner, an offset that would swallow a
 * circle, a row of too many copies), the size field takes a decimal comma, typed values move between
 * their fields by Tab and close by Escape, a right click that confirms steps back one thing at a
 * time, a cancelled touch leaves no half-drawn line, and a dimension's label is picked by a click.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity, SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { apply, closeSketch, currentDoc, editFeature, getViewport, newProject, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setSketchSelection, setTool, useSketchUi } from "./state";

let vp: Viewport;
const sketch = () => currentDoc().features.find((f) => f.id === "sk1") as SketchFeature;
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const toasts = () => useApp.getState().toasts.map((t) => t.text).join(" | ");
const at = (u: number, v: number) => {
  const [x, y] = vp.worldToScreen([u, v, 0])!;
  return { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
};
async function clickAt(u: number, v: number, button = 0) {
  const ev = { ...at(u, v), button };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 << button });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(450);
}
const P = (id: string, x: number, y: number): SketchEntity => ({ id, type: "point", x, y });
const L = (id: string, p1: string, p2: string): SketchEntity => ({ id, type: "line", p1, p2 });
/** A 40 × 20 rectangle and a circle of radius 3 at (60, 10), with the bottom's length dimensioned. */
const entities: SketchEntity[] = [
  P("a", 0, 0), P("b", 40, 0), P("c", 40, 20), P("d", 0, 20),
  L("l1", "a", "b"), L("l2", "b", "c"), L("l3", "c", "d"), L("l4", "d", "a"),
  P("o", 60, 10), { id: "k", type: "circle", center: "o", radius: 3 },
];

beforeEach(async () => {
  withScreen();
  await newProject(undefined, "Sketch keys");
  apply({ type: "add_features", features: [{ id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities, constraints: [{ id: "len", type: "length", line: "l1", value: 40 }] } as Feature] });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => editFeature("sk1"));
  await act(async () => vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(30, 10, 0)));
  await settle(50);
});
afterEach(async () => {
  usePrefs.setState({ mouse: "meercad" } as never);
  if (useApp.getState().sketchId) await act(async () => closeSketch());
  cleanup();
});

describe("the sketch editor's panel and keys", () => {
  it("says why a corner cannot be rounded or a circle offset", async () => {
    await act(async () => useSketchUi.setState({ editSize: 30 }));
    await act(async () => setTool("fillet"));
    await clickAt(40, 20);
    expect(toasts()).toMatch(/Cannot round this corner/);
    await act(async () => useSketchUi.setState({ editSize: -5 }));
    await act(async () => setTool("offset"));
    await clickAt(63, 10);
    expect(toasts()).toMatch(/Cannot offset/);
    expect(sketch().entities).toHaveLength(entities.length);
  });

  it("takes a size with a decimal comma, and shows the size in use when left", async () => {
    await act(async () => setTool("chamfer"));
    const field = document.querySelector<HTMLInputElement>(".sketch-panel input.field, input[inputmode=decimal]")!;
    await act(async () => void fireEvent.change(field, { target: { value: "2,5" } }));
    expect(useSketchUi.getState().editSize).toBe(2.5);
    await act(async () => void fireEvent.change(field, { target: { value: "x" } }));
    expect(useSketchUi.getState().editSize).toBe(2.5);
    await act(async () => void fireEvent.blur(field));
    expect(field.value).toBe("2.5");
  });

  it("repeats a selection by the panel's numbers, and refuses too many", async () => {
    await act(async () => setTool("pattern"));
    await act(async () => setSketchSelection([{ kind: "curve", id: "k" }]));
    const input = (label: string) => screen.getByText(label).parentElement!.querySelector("input")!;
    await act(async () => void fireEvent.change(input("Count"), { target: { value: "3" } }));
    await act(async () => void fireEvent.change(input("Step x"), { target: { value: "10" } }));
    await act(async () => void fireEvent.change(input("Step y"), { target: { value: "0" } }));
    await act(async () => void fireEvent.click(screen.getByText("Repeat selection")));
    expect(sketch().entities.filter((e) => e.type === "circle")).toHaveLength(3);
    await act(async () => setSketchSelection([{ kind: "curve", id: "k" }]));
    await act(async () => void fireEvent.change(input("Count"), { target: { value: "500" } }));
    await act(async () => void fireEvent.click(screen.getByText("Repeat selection")));
    expect(toasts()).toMatch(/Cannot repeat/);
    await act(async () => void fireEvent.click(screen.getByText("Round the origin")));
    await act(async () => void fireEvent.change(input("Angle"), { target: { value: "45" } }));
    expect(useSketchUi.getState().pattern.angle).toBe(45);
  });

  it("moves between typed values by Tab and drops them by Escape", async () => {
    await act(async () => setTool("rect"));
    await clickAt(0, 40);
    await act(async () => void fireEvent.keyDown(window, { key: "5" }));
    await act(async () => void fireEvent.keyDown(window, { key: "Tab" }));
    const inputs = () => [...document.querySelectorAll<HTMLInputElement>(".draw-entry input")];
    expect(inputs()).toHaveLength(2);
    await act(async () => void fireEvent.keyDown(inputs()[0]!, { key: "Tab" }));
    await act(async () => void fireEvent.keyDown(inputs()[1]!, { key: "Tab", shiftKey: true }));
    await act(async () => void fireEvent.keyDown(inputs()[0]!, { key: "Escape" }));
    expect(inputs()).toHaveLength(0);
  });

  it("steps back one thing per right click when a right click confirms", async () => {
    usePrefs.setState({ mouse: "plasticity" } as never);
    await act(async () => setTool("line"));
    await clickAt(0, 40);
    // The line being drawn goes, then the tool, then the sketch closes.
    await clickAt(10, 40, 2);
    expect(useSketchUi.getState().tool).toBe("line");
    await clickAt(10, 40, 2);
    expect(useSketchUi.getState().tool).toBe("select");
    await clickAt(10, 40, 2);
    expect(useApp.getState().sketchId).toBeNull();
    expect(sketch().entities).toHaveLength(entities.length);
  });

  it("leaves no half-drawn line when a touch is cancelled", async () => {
    await act(async () => setTool("line"));
    const ev = { ...at(0, 40), pointerType: "touch", pointerId: 4 };
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
      fireEvent.pointerCancel(vp.canvas, { ...ev, buttons: 0 });
    });
    await settle(50);
    expect(sketch().entities).toHaveLength(entities.length);
  });

  it("picks a dimension by its label, more with Shift", async () => {
    await act(async () => setTool("select"));
    const label = await screen.findByText(/^40/);
    await act(async () => void fireEvent.click(label));
    expect(useSketchUi.getState().selection).toEqual([{ kind: "constraint", id: "len" }]);
    await act(async () => void fireEvent.click(label, { shiftKey: true }));
    expect(useSketchUi.getState().selection).toHaveLength(2);
  });
});
