/**
 * More picking for a step in the real 3D view (FeatureDialog.tsx): a part picked to move takes the
 * parts joined to it along; for a copy only the part itself; the first part picked for a bend
 * sets the bend from its shape; a tapped
 * edge puts a hole beside it, as far in as the wall needs. The parts: a 40 × 20 × 10 block and a
 * 10 × 10 × 25 post, a hinge joining the post to the block.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DocOp, Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, cancelDialog, getViewport, newProject, setDialogField, startFeature, updateDraft, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";
import { FeatureDialog } from "./FeatureDialog";

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
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 25, mode: "new_body" },
];
let vp: Viewport;
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const draft = <T,>() => useApp.getState().dialog!.feature as T;
async function clickAt(world: [number, number, number]) {
  const [x, y] = vp.worldToScreen(world)!;
  const ev = { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle(450);
}
async function start(op: Parameters<typeof startFeature>[0], field: string, patch?: Record<string, unknown>) {
  await act(async () => startFeature(op));
  if (patch) await act(async () => updateDraft(patch as never));
  await act(async () => setDialogField(field as never));
  await settle();
}

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Dialog picks 3");
  apply({ type: "add_features", features: design }, { type: "set_joint", joint: { id: "j1", type: "revolute", a: "ex2", b: "ex1", anchor: { axis: { ref: "origin.Z" } } } } as DocOp);
  renderUi(
    <>
      <ViewportView />
      <FeatureDialog />
    </>,
  );
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
beforeEach(() => useApp.setState({ selection: [] }));
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("more picking for a step", () => {
  it("moves a part with the parts joined to it; a copy toggles just the part", async () => {
    await start("transform", "bodies");
    await clickAt([20, 10, 10]);
    expect(draft<{ bodies: string[] }>().bodies.sort()).toEqual(["ex1", "ex2"]);
    await act(async () => cancelDialog());
    await start("transform", "bodies", { copy: true });
    await clickAt([20, 10, 10]);
    expect(draft<{ bodies: string[] }>().bodies).toEqual(["ex1"]);
    await act(async () => cancelDialog());
  });

  it("sets a bend from the first part picked", async () => {
    await start("bend", "bodies");
    await clickAt([20, 10, 10]);
    const b = draft<{ bodies: string[]; axis?: unknown; angle?: unknown; radius?: unknown }>();
    expect(b.bodies).toEqual(["ex1"]);
    // The 40 mm long block bends about its width.
    expect(b.axis ?? b.angle ?? b.radius).toBeDefined();
    await act(async () => cancelDialog());
  });

  it("puts a hole beside a tapped edge", async () => {
    await start("hole", "points", { kind: "simple", diameter: 4, depth: 5, plane: { face: { face: "ex1.end_cap" } }, points: [] });
    // The block's top edge along y = 0.
    await clickAt([20, 0, 10]);
    const pts = draft<{ points: [number, number][] }>().points;
    expect(pts).toHaveLength(1);
    // Beside the edge, inside the face: at x = 20, a few mm in from y = 0.
    expect(pts[0]![0]).toBeCloseTo(20, 0);
    expect(pts[0]![1]).toBeGreaterThan(2);
    expect(pts[0]![1]).toBeLessThan(10);
    await act(async () => cancelDialog());
  });
});
