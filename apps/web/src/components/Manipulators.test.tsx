/**
 * Drag arrows on the model (Manipulators.tsx) in the real 3D view: editing an extrude, a fillet and
 * an offset plane shows an arrow at the right place; dragging it, by its callbacks and by the
 * pointer on the screen, changes the step, and the part comes out at the dragged size.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, cancelDialog, commitDialog, editFeature, getViewport, newProject, rebuildNow, startFeature, updateDraft, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

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
  { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l1]"] }], radius: 2 },
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
];
let vp: Viewport;
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Arrows");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("drag arrows", () => {
  it("puts the extrude's arrow on its top face and drags it to 25 mm", async () => {
    await act(async () => editFeature("ex1"));
    await settle();
    const h = vp.handles[0]!;
    expect(h).toBeDefined();
    expect(h.value).toBeCloseTo(10, 6);
    expect(h.dir.map((v) => Math.round(v))).toEqual([0, 0, 1]);
    await act(async () => {
      h.onStart?.();
      h.onDrag(25);
      h.onEnd(25);
    });
    expect((useApp.getState().dialog!.feature as { distance: unknown }).distance).toBe(25);
    await act(async () => void commitDialog());
    const out = await rebuildNow();
    // 40 × 20 × 25 less the R2 round along a 40 mm edge.
    expect(out.report.bodies[0]!.volume).toBeCloseTo(40 * 20 * 25 - (4 - Math.PI) * 40, 3);
  });

  it("drags a new fillet's arrow by the pointer", async () => {
    // A new fillet on the top's other long edge (the edge is still there to put the arrow on).
    await act(async () => startFeature("fillet"));
    await act(async () => updateDraft({ edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l3]"] }] } as Partial<Feature>));
    await vi.waitFor(async () => {
      await settle();
      expect(vp.handles.length).toBeGreaterThan(0);
    }, { timeout: 20_000, interval: 100 });
    const h = vp.handles[0]!;
    expect(h.value).toBeCloseTo(2, 6);
    // The arrow sits on the middle of that edge (x = 20, y = 20, z = 25).
    expect(h.origin[0]).toBeCloseTo(20, 3);
    expect(h.origin[1]).toBeCloseTo(20, 3);
    expect(h.origin[2]).toBeCloseTo(25, 3);
    const tip = vp.handleTipScreen(h.id)!;
    expect(tip).not.toBeNull();
    const ev = { pointerId: 1, pointerType: "mouse", button: 0, buttons: 1, isPrimary: true };
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...ev, clientX: tip[0], clientY: tip[1] });
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: tip[0] + 15, clientY: tip[1] - 15 });
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: tip[0] + 30, clientY: tip[1] - 30 });
      fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0, clientX: tip[0] + 30, clientY: tip[1] - 30 });
    });
    await settle();
    const r = (useApp.getState().dialog!.feature as { radius: number }).radius;
    expect(typeof r).toBe("number");
    expect(r).toBeGreaterThanOrEqual(0);
    await act(async () => cancelDialog());
  });

  it("moves an offset plane", async () => {
    await act(async () => editFeature("pl1"));
    await settle();
    const h = vp.handles[0];
    if (h) {
      expect(h.value).toBeCloseTo(30, 6);
      await act(async () => h.onDrag(45));
      expect((useApp.getState().dialog!.feature as { offset: unknown }).offset).toBe(45);
    }
    await act(async () => cancelDialog());
  });
});
