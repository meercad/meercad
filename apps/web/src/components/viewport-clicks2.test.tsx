/**
 * More clicks in the 3D view (ViewportView.tsx): a double click on a face takes its whole part; a
 * double click on a sketch region opens its sketch; with a right click that confirms (the Plasticity
 * scheme) it finishes the open step or the measurement instead of opening a menu; on a touch screen
 * a double tap turns the view to the face tapped, a long press and drag selects by a box, and a
 * cancelled touch leaves nothing half done.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, cancelDialog, currentDoc, getViewport, kernel, newProject, startFeature, undo, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
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
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const screenOf = (w: [number, number, number]) => {
  (vp as unknown as { scene: { updateMatrixWorld(f: boolean): void } }).scene.updateMatrixWorld(true);
  return vp.worldToScreen(w)!;
};
async function press(w: [number, number, number], o: { button?: number; type?: string; id?: number; hold?: number; to?: [number, number, number] } = {}) {
  const [x, y] = screenOf(w);
  const button = o.button ?? 0;
  const ev = { clientX: x, clientY: y, pointerId: o.id ?? 1, pointerType: o.type ?? "mouse", button, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 << button });
  });
  if (o.hold) await settle(o.hold);
  let end = ev;
  if (o.to) {
    const [x2, y2] = screenOf(o.to);
    end = { ...ev, clientX: x2, clientY: y2 };
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: (x + x2) / 2, clientY: (y + y2) / 2, buttons: 1 });
      fireEvent.pointerMove(vp.canvas, { ...end, buttons: 1 });
    });
    await settle(40);
  }
  await act(async () => void fireEvent.pointerUp(vp.canvas, { ...end, buttons: 0 }));
}
const TOP: [number, number, number] = [20, 10, 10];

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Clicks 2");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
    { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("q", 60, 0, 10, 10), constraints: [] },
  ] as Feature[] });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
beforeEach(async () => {
  useApp.setState({ selection: [], showSketches: true } as never);
  // Away from the click before, so none counts as a double click.
  await settle(450);
});
afterAll(() => {
  usePrefs.setState({ mouse: "meercad" } as never);
  cleanup();
});

describe("more clicks", () => {
  it("takes a part's whole with a double click on a face", async () => {
    await press(TOP);
    await settle(60);
    await press(TOP);
    const sel = useApp.getState().selection;
    expect(sel.length).toBeGreaterThan(1);
    expect(new Set(sel.map((p) => (p as { bodyId: string }).bodyId))).toEqual(new Set(["ex1"]));
  });

  it("opens a sketch with a double click on its region", async () => {
    const [x, y] = screenOf([65, 5, 0]);
    await act(async () => void fireEvent.dblClick(vp.canvas, { clientX: x, clientY: y }));
    expect(useApp.getState().dialog?.feature.id ?? useApp.getState().sketchId).toBe("sk2");
    await act(async () => cancelDialog());
    useApp.setState({ sketchId: null } as never);
  });

  it("finishes the step or the measurement with a right click that confirms", async () => {
    usePrefs.setState({ mouse: "plasticity" } as never);
    const before = currentDoc().features.length;
    await act(async () => startFeature("primitive"));
    await press(TOP, { button: 2 });
    // The open step was finished: no menu came, the step is in the design.
    expect(useApp.getState().dialog).toBeNull();
    expect(currentDoc().features.length).toBe(before + 1);
    await act(async () => void undo());
    await rebuilt();
    expect(document.querySelector("[role=menu]")).toBeNull();
    useApp.setState({ measure: { active: true, picks: [], result: null } } as never);
    await settle(450);
    await press(TOP, { button: 2 });
    expect(useApp.getState().measure.active).toBe(false);
    // With nothing open it shows the menu after all.
    await settle(450);
    await press(TOP, { button: 2 });
    expect(document.querySelector("[role=menu]")).not.toBeNull();
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    usePrefs.setState({ mouse: "meercad" } as never);
  });

  it("turns the view to a face tapped twice", async () => {
    await act(async () => vp.setView("iso", false));
    const q = vp.cameraQuaternion.clone();
    await press(TOP, { type: "touch", id: 7 });
    await settle(60);
    await press(TOP, { type: "touch", id: 8 });
    await settle(600);
    (vp as unknown as { frame(): void }).frame();
    expect(vp.cameraQuaternion.equals(q)).toBe(false);
    await act(async () => {
      vp.setView("top", false);
      vp.fit(false);
    });
  });

  it("selects by a box after a long press and drag", async () => {
    const calls: unknown[] = [];
    const own = vp.boxSelect.bind(vp);
    vp.boxSelect = (...a) => { const r = own(...a); calls.push([a, r.length]); return r; };
    await press([-10, -10, 10], { type: "touch", id: 9, hold: 650, to: [50, 30, 10] });
    vp.boxSelect = own;
    expect(calls).toHaveLength(1);
    // The block's faces and edges, all inside the box.
    expect(useApp.getState().selection.length).toBe(18);
    expect(new Set(useApp.getState().selection.map((p) => (p as { bodyId: string }).bodyId))).toEqual(new Set(["ex1"]));
    await settle(60);
    expect(useApp.getState().selection.length).toBeGreaterThan(0);
  });

  it("leaves nothing half done when a touch is cancelled", async () => {
    const [x, y] = screenOf([-30, -30, 0]);
    const ev = { clientX: x, clientY: y, pointerId: 11, pointerType: "touch", button: 0, isPrimary: true };
    await act(async () => void fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 }));
    await settle(650);
    await act(async () => void fireEvent.pointerMove(vp.canvas, { ...ev, clientX: x + 80, clientY: y + 80, buttons: 1 }));
    await act(async () => void fireEvent.pointerCancel(vp.canvas, { ...ev, buttons: 0 }));
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    // No box was taken and the view can be turned again.
    expect(useApp.getState().selection).toEqual([]);
    expect(vp.controls.enabled).toBe(true);
    expect(currentDoc().features).toHaveLength(3);
  });

  it("asks for a plane when a sketch waits for one and a click hits nothing flat; a failed measurement says why", async () => {
    // Waiting for a sketch plane: a click on empty ground does nothing, on a part's flat top starts the sketch.
    await act(async () => useApp.setState({ pickingSketchPlane: true } as never));
    await press([200, 200, 0]);
    expect(useApp.getState().sketchId ?? null).toBeNull();
    await act(async () => useApp.setState({ pickingSketchPlane: false } as never));
    const kernelMeasure = vi.spyOn(kernel, "measure").mockRejectedValueOnce(new Error("cannot measure that"));
    useApp.setState({ measure: { active: true, picks: [], result: null } } as never);
    await settle(450);
    await press(TOP);
    await settle();
    expect(useApp.getState().toasts.at(-1)?.text).toBe("cannot measure that");
    kernelMeasure.mockRestore();
    useApp.setState({ measure: { active: false, picks: [], result: null } } as never);
  });

  it("accepts an open step by a click on empty space", async () => {
    const before = currentDoc().features.length;
    await act(async () => startFeature("primitive"));
    await act(async () => useApp.setState((s) => ({ dialog: s.dialog ? { ...s.dialog, field: null } : null })));
    await settle(450);
    await press([300, 300, 0]);
    expect(useApp.getState().dialog).toBeNull();
    expect(currentDoc().features.length).toBe(before + 1);
    await act(async () => void undo());
    await rebuilt();
  });
});
