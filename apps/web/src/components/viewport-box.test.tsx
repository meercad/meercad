/**
 * Selecting in the 3D view (ViewportView.tsx) by dragging a box from empty space, seen from above:
 * dragged left to right it takes what lies wholly inside, F while dragging takes faces only, E edges
 * only, Shift adds to what was selected; a double-click selects the whole part; a finger tap selects,
 * a finger double tap turns the view to the face, a finger held opens the menu, two fingers tapped
 * undo and three redo.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, useApp } from "../store";
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
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const at = (w: [number, number, number]) => {
  const [x, y] = vp.worldToScreen(w)!;
  return { clientX: x, clientY: y };
};
const sel = () => useApp.getState().selection;

/** Drags a box with the mouse from `a` to `b` (world points), pressing `keys` on the way. */
async function box(a: [number, number, number], b: [number, number, number], opts: { keys?: string[]; shiftKey?: boolean } = {}) {
  const ev = { pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
  await act(async () => {
    fireEvent.pointerDown(vp.canvas, { ...ev, ...at(a), buttons: 1 });
    for (let i = 1; i <= 3; i++) {
      const pa = at(a), pb = at(b);
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: pa.clientX + ((pb.clientX - pa.clientX) * i) / 3, clientY: pa.clientY + ((pb.clientY - pa.clientY) * i) / 3, buttons: 1 });
    }
  });
  await settle();
  for (const k of opts.keys ?? []) await act(async () => void fireEvent.keyDown(window, { key: k }));
  await act(async () => void fireEvent.pointerUp(vp.canvas, { ...ev, ...at(b), buttons: 0, shiftKey: !!opts.shiftKey }));
  await settle();
}
const touch = (id: number, w: [number, number, number]) => ({ pointerId: id, pointerType: "touch", button: 0, isPrimary: id === 1, ...at(w) });

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Box select");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
beforeEach(() => useApp.setState({ selection: [], selectedFeature: null }));
afterAll(cleanup);

describe("box selection", () => {
  it("takes what lies wholly inside a box dragged left to right: the small part, not the big one", async () => {
    await box([55, -5, 10], [75, 15, 10]);
    const bodies = new Set(sel().map((p) => (p as { bodyId: string }).bodyId));
    expect([...bodies]).toEqual(["ex2"]);
    expect(sel().some((p) => p.kind === "edge")).toBe(true);
  });

  it("takes faces only with F and edges only with E, and adds with Shift", async () => {
    await box([55, -5, 10], [75, 15, 10], { keys: ["f"] });
    expect(sel().length).toBeGreaterThan(0);
    expect(sel().every((p) => p.kind === "face")).toBe(true);
    const faces = sel().length;
    await box([55, -5, 10], [75, 15, 10], { keys: ["e"], shiftKey: true });
    expect(sel().length).toBeGreaterThan(faces);
    expect(sel().some((p) => p.kind === "edge")).toBe(true);
    await box([55, -5, 10], [75, 15, 10], { keys: ["Tab", "Tab"] });
    expect(sel().every((p) => p.kind === "edge")).toBe(true);
  });

  it("selects the whole part with a double-click", async () => {
    await act(async () => void fireEvent.dblClick(vp.canvas, at([20, 10, 10])));
    const faces = useApp.getState().output!.meshes.find((m) => m.bodyId === "ex1")!.faceTags.length;
    expect(sel().filter((p) => p.kind === "face" && p.bodyId === "ex1")).toHaveLength(faces);
  });
});

describe("fingers", () => {
  it("selects with a tap, opens the menu when held, and undoes and redoes with two and three fingers", async () => {
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...touch(1, [20, 10, 10]), buttons: 1 });
      fireEvent.pointerUp(vp.canvas, { ...touch(1, [20, 10, 10]), buttons: 0 });
    });
    await settle(400);
    expect(sel()).toMatchObject([{ kind: "face", bodyId: "ex1" }]);
    // Held: the menu.
    await act(async () => void fireEvent.pointerDown(vp.canvas, { ...touch(1, [65, 5, 10]), buttons: 1 }));
    await settle(700);
    await act(async () => void fireEvent.pointerUp(vp.canvas, { ...touch(1, [65, 5, 10]), buttons: 0 }));
    expect(document.querySelector("[role=menu]")).not.toBeNull();
    await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
    // Two fingers tapped: undo; three: redo.
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 12 } });
    const distance = () => (currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown }).distance;
    const tapWith = async (n: number) => {
      await act(async () => {
        for (let i = 1; i <= n; i++) fireEvent.pointerDown(vp.canvas, { ...touch(i, [10 + i * 5, 10, 10]), buttons: 1 });
        for (let i = 1; i <= n; i++) fireEvent.pointerUp(vp.canvas, { ...touch(i, [10 + i * 5, 10, 10]), buttons: 0 });
      });
      await settle(100);
    };
    await tapWith(2);
    expect(distance()).toBe(10);
    await tapWith(3);
    expect(distance()).toBe(12);
  });
});
