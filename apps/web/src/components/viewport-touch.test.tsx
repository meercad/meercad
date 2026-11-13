/**
 * Fingers and pen on the 3D view (packages/viewport): a second finger while one drags an arrow calls
 * the drag off and puts the value back (a pinch over a selected face once changed its thickness);
 * a palm resting while the pen is down is ignored, and touches already on the screen when the pen
 * comes down are cancelled; a trackpad swipe orbits the camera.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, getViewport, newProject } from "../store";
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
let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Touch");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ] as Feature[] });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("fingers and pen", () => {
  it("calls an arrow's drag off when a second finger comes, and puts its value back", async () => {
    const values: number[] = [];
    let ended: number | null = null;
    vp.setHandles([{ id: "h", origin: [20, 10, 10], dir: [0, 0, 1], value: 10, onDrag: (v) => void values.push(v), onEnd: (v) => void (ended = v) }]);
    const tip = vp.handleTipScreen("h")!;
    const touch = (id: number, x: number, y: number) => ({ pointerId: id, pointerType: "touch", isPrimary: id === 1, button: 0, clientX: x, clientY: y });
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...touch(1, tip[0], tip[1]), buttons: 1 });
      fireEvent.pointerMove(vp.canvas, { ...touch(1, tip[0], tip[1] - 40), buttons: 1 });
    });
    await settle();
    expect(values.length).toBeGreaterThan(0);
    expect(values.at(-1)).not.toBe(10);
    // A second finger: a pinch, not a drag.
    await act(async () => void fireEvent.pointerDown(vp.canvas, { ...touch(2, tip[0] + 80, tip[1]), buttons: 1 }));
    await settle();
    expect(values.at(-1)).toBe(10);
    expect(ended).toBe(10);
    await act(async () => {
      fireEvent.pointerUp(vp.canvas, { ...touch(1, tip[0], tip[1] - 40), buttons: 0 });
      fireEvent.pointerUp(vp.canvas, { ...touch(2, tip[0] + 80, tip[1]), buttons: 0 });
    });
    vp.setHandles([]);
  });

  it("ignores a palm while the pen is down, and cancels touches already there", async () => {
    const cancels: number[] = [];
    vp.canvas.addEventListener("pointercancel", (e) => cancels.push((e as PointerEvent).pointerId));
    const at = { clientX: 300, clientY: 300 };
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...at, pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
      fireEvent.pointerDown(vp.canvas, { ...at, pointerId: 12, pointerType: "pen", isPrimary: true, button: 0, buttons: 1 });
    });
    // The touch that was there first is called off.
    expect(cancels).toContain(11);
    expect((vp as unknown as { penActive: boolean }).penActive).toBe(true);
    // A palm landing now is never a touch the view follows.
    await act(async () => void fireEvent.pointerDown(vp.canvas, { ...at, pointerId: 13, pointerType: "touch", isPrimary: false, button: 0, buttons: 1 }));
    expect((vp as unknown as { rejected: Set<number> }).rejected.has(13)).toBe(true);
    await act(async () => {
      fireEvent.pointerUp(vp.canvas, { ...at, pointerId: 12, pointerType: "pen", button: 0, buttons: 0 });
      fireEvent.pointerUp(vp.canvas, { ...at, pointerId: 13, pointerType: "touch", button: 0, buttons: 0 });
    });
  });

  it("orbits with a trackpad swipe", async () => {
    vp.setView("iso", false);
    const q = vp.cameraQuaternion.clone();
    await act(async () => void fireEvent.wheel(vp.canvas, { clientX: 400, clientY: 300, deltaX: 40, deltaY: 0, deltaMode: 0 }));
    await act(async () => void fireEvent.wheel(vp.canvas, { clientX: 400, clientY: 300, deltaX: 40, deltaY: 5, deltaMode: 1 }));
    expect(vp.cameraQuaternion.equals(q)).toBe(false);
  });
});
