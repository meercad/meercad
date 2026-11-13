/**
 * The 3D view (packages/viewport) between pictures: frames drawn one after another finish a camera
 * move and lay the grid under the view; the pointer's ray points where the camera looks; a plane is
 * picked where it is clicked; a joint's symbol is grabbed before the part under it and a part is
 * dragged by the pointer; a picture on a part appears once it has loaded.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { apply, getViewport, newProject, useApp } from "../store";
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
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
];
let vp: Viewport;
const frame = () => (vp as unknown as { frame(): void }).frame();

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Frames");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("top", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("the 3D view between pictures", () => {
  it("finishes an animated camera move over the frames that follow", () => {
    const now = vi.spyOn(performance, "now");

    try {
      const t0 = performance.now();
      now.mockReturnValue(t0);
      vp.setView("front", true);
      frame();
      now.mockReturnValue(t0 + 175);
      frame();

      const mid = vp.cameraQuaternion.clone();
      now.mockReturnValue(t0 + 1000);
      frame();
      frame();

      // Done: looking along +Y at the part from the front.
      const look = new THREE.Vector3(0, 0, -1).applyQuaternion(vp.cameraQuaternion);
      expect(look.y).toBeCloseTo(1, 6);
      expect(vp.cameraQuaternion.equals(mid)).toBe(false);
    } finally {
      now.mockRestore();
    }

    vp.setView("top", false);
    vp.fit(false);
    frame();
  });

  it("casts the pointer's ray where the camera looks: straight down from above", () => {
    const at = vp.worldToScreen([20, 10, 10])!;
    const r = vp.ray(at[0], at[1]);
    const d = Math.hypot(...r.dir);
    expect(r.dir[2] / d).toBeLessThan(-0.99);

    // The ray passes the point it was cast through.
    const t = (10 - r.origin[2]) / r.dir[2];
    expect(r.origin[0] + r.dir[0] * t).toBeCloseTo(20, 3);
    expect(r.origin[1] + r.dir[1] * t).toBeCloseTo(10, 3);
  });

  it("picks the offset plane where it is clicked, at its height", async () => {
    await act(async () => useApp.setState({ showPlanes: true }));
    await rebuilt();

    // Over the part: the plane 30 mm up lies in front of it.
    const at = vp.worldToScreen([20, 10, 30])!;
    // The renderer places the plane when it draws (the test's draws nothing): place it as a frame would.
    (vp as unknown as { scene: THREE.Scene }).scene.updateMatrixWorld(true);

    const p = vp.pick(at[0], at[1], new Set(["plane"]));
    expect(p?.kind).toBe("plane");

    if (p?.kind === "plane") {
      expect(p.point[2]).toBeCloseTo(30, 3);
      expect(p.planeId).toBe("pl1");
    }

    await act(async () => useApp.setState({ showPlanes: false }));
  });

  it("grabs a joint by its symbol before the part under it, and drags a part by the pointer", async () => {
    const calls: string[] = [];
    vp.partDrag = {
      start: (pick) => (calls.push(`part ${pick.bodyId}`), true),
      startJoint: (id) => (calls.push(`joint ${id}`), true),
      move: () => void calls.push("move"),
      end: () => void calls.push("end"),
    };
    vp.setJointGlyphs([
      { id: "j1", origin: [20, 10, 10], axis: [0, 0, 1], type: "slider", active: false } as never,
    ]);

    const ev = { pointerId: 7, pointerType: "mouse", button: 0, isPrimary: true };
    // On the slider's knob, in the middle of its axis.
    const knob = vp.worldToScreen([20, 10, 10])!;
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: knob[0], clientY: knob[1], buttons: 0 });
      fireEvent.pointerDown(vp.canvas, { ...ev, clientX: knob[0], clientY: knob[1], buttons: 1 });
    });
    expect(vp.draggingPart).toBe(true);
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, { ...ev, clientX: knob[0] + 20, clientY: knob[1], buttons: 1 });
      await new Promise((r) => setTimeout(r, 40));
      fireEvent.pointerUp(vp.canvas, { ...ev, clientX: knob[0] + 20, clientY: knob[1], buttons: 0 });
    });
    expect(vp.draggingPart).toBe(false);
    expect(calls[0]).toBe("joint j1");
    expect(calls).toContain("end");
    // Away from the symbol, the part under the pointer.
    vp.setJointGlyphs([]);
    calls.length = 0;

    const part = vp.worldToScreen([5, 5, 10])!;
    await act(async () => {
      fireEvent.pointerDown(vp.canvas, { ...ev, clientX: part[0], clientY: part[1], buttons: 1 });
      fireEvent.pointerUp(vp.canvas, { ...ev, clientX: part[0], clientY: part[1], buttons: 0 });
    });
    expect(calls[0]).toBe("part ex1");
    vp.partDrag = null;
  });

  it("shows a picture on a part once it has loaded, and plain again without it", async () => {
    const was = (globalThis as { createImageBitmap?: unknown }).createImageBitmap;
    (globalThis as { createImageBitmap?: unknown }).createImageBitmap = async () => ({
      width: 2,
      height: 2,
      close() {},
    });

    try {
      const mesh = useApp.getState().output!.meshes.find((m) => m.bodyId === "ex1")!;
      const uvs = new Float32Array((mesh.positions.length / 3) * 2);
      vp.setBodyTextures([{ bodyId: "ex1", uvs, image: new Blob(), key: "pic" }]);
      await act(async () => new Promise((r) => setTimeout(r, 20)));
      // A second call while it is loaded keeps it; a picture of the wrong size is left off.
      vp.setBodyTextures([{ bodyId: "ex1", uvs, image: new Blob(), key: "pic" }]);
      vp.setBodyTextures([{ bodyId: "ex1", uvs: new Float32Array(2), image: new Blob(), key: "small" }]);
      vp.setBodyTextures([]);

      const at = vp.worldToScreen([20, 10, 10])!;
      expect(vp.pick(at[0], at[1], new Set(["face"]))?.kind).toBe("face");
    } finally {
      (globalThis as { createImageBitmap?: unknown }).createImageBitmap = was;
    }
  });
});
