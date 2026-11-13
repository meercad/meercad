/**
 * Clicks in the 3D view (ViewportView.tsx) on the real scene, seen from above: selecting faces,
 * adding with Shift, clearing on empty space; measuring between two faces gives the true distance;
 * the right-click menus on a part and on empty space do what they say.
 * The parts: a 40 × 20 × 10 block at the origin and a 10 × 10 × 25 post at x = 60.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, getViewport, newProject, useApp } from "../store";
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
const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 25, mode: "new_body" },
];
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

async function clickAt(world: [number, number, number], opts: { shiftKey?: boolean; button?: number } = {}) {
  const [x, y] = vp.worldToScreen(world)!;
  const button = opts.button ?? 0;
  const ev = {
    clientX: x,
    clientY: y,
    pointerId: 1,
    pointerType: "mouse",
    button,
    isPrimary: true,
    shiftKey: !!opts.shiftKey,
  };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 << button });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle();
}

const EMPTY: [number, number, number] = [30, 60, 0];

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Clicks");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
beforeEach(() =>
  useApp.setState({
    selection: [],
    selectedFeature: null,
    measure: { active: false, picks: [], result: null },
    hidden: new Set(),
  }),
);
afterAll(cleanup);

describe("clicks in the 3D view", () => {
  it("selects a face, adds one with Shift, takes it off again and clears on empty space", async () => {
    await clickAt([20, 10, 10]);
    expect(useApp.getState().selection).toMatchObject([{ kind: "face", bodyId: "ex1" }]);
    expect(useApp.getState().selectedFeature).toBe("ex1");
    await clickAt([65, 5, 25], { shiftKey: true });
    expect(useApp.getState().selection.map((p) => (p as { bodyId: string }).bodyId)).toEqual(["ex1", "ex2"]);
    // A second click elsewhere on it (the same spot twice would be a double-click: the whole part).
    await clickAt([62, 8, 25], { shiftKey: true });
    expect(useApp.getState().selection).toHaveLength(1);
    await clickAt(EMPTY);
    expect(useApp.getState().selection).toEqual([]);
  });

  it("measures between the block's top and the post's top: 25 mm apart, 20 across and 15 up", async () => {
    useApp.setState({ measure: { active: true, picks: [], result: null } });
    await clickAt([20, 10, 10]);
    await clickAt([65, 5, 25], { shiftKey: true });
    expect(useApp.getState().measure.picks).toHaveLength(2);
    await settle(200);

    const rows = useApp.getState().measure.result?.rows ?? [];
    // The nearest points: the block's top edge at x = 40, z = 10 and the post's at x = 60, z = 25.
    const text = rows.map((r) => r.join(" ")).join("\n");
    expect(text).toMatch(/^Distance 25 mm$/m);
    expect(text).toMatch(/^ΔX \/ ΔY \/ ΔZ 20 \/ 0 \/ 15\b/m);
    // Empty space starts over.
    await clickAt(EMPTY);
    expect(useApp.getState().measure).toMatchObject({ active: true, picks: [] });
  });

  it("offers a part's actions on right-click: hiding hides it", async () => {
    await clickAt([20, 10, 10], { button: 2 });
    expect(useApp.getState().selection).toMatchObject([{ kind: "face", bodyId: "ex1" }]);
    await pickMenu(/^Hide/);
    expect(useApp.getState().hidden.has("ex1")).toBe(true);
  });

  it("offers the view's actions on empty space, and measuring from a part", async () => {
    const was = useApp.getState().showPlanes;
    await clickAt(EMPTY, { button: 2 });
    await pickMenu(was ? "Hide planes" : "Show planes");
    expect(useApp.getState().showPlanes).toBe(!was);
    useApp.setState({ hidden: new Set(["ex2"]) });
    await clickAt(EMPTY, { button: 2 });
    await pickMenu("Show all parts");
    expect(useApp.getState().hidden.size).toBe(0);
    await clickAt([20, 10, 10], { button: 2 });
    await pickMenu("Measure");
    expect(useApp.getState().measure).toMatchObject({
      active: true,
      picks: [{ kind: "face", bodyId: "ex1" }],
    });
  });

  it("starts tools from a face and an edge, duplicates a part with its size and deletes one", async () => {
    await clickAt([20, 10, 10], { button: 2 });
    await pickMenu("Push/pull face");
    expect(useApp.getState().dialog?.feature).toMatchObject({ op: "extrude" });
    await act(async () => useApp.setState({ dialog: null }));
    // An edge of the block: its long top edge at y = 0.
    await clickAt([20, 0, 10], { button: 2 });
    await pickMenu("Fillet");
    expect(useApp.getState().dialog?.feature).toMatchObject({ op: "fillet" });
    await act(async () => useApp.setState({ dialog: null }));

    const volumes = () =>
      useApp
        .getState()
        .output!.report.bodies.map((b) => Math.round(b.volume ?? 0))
        .sort((a, b) => a - b);
    expect(volumes()).toEqual([2500, 8000]);
    await clickAt([65, 5, 25], { button: 2 });
    await pickMenu("Duplicate");
    await rebuilt();
    expect(volumes()).toEqual([2500, 2500, 8000]);
    await clickAt([20, 10, 10], { button: 2 });
    await pickMenu("Delete Extrude 1");
    await rebuilt();
    expect(volumes()).toEqual([2500, 2500]);
  });
});
