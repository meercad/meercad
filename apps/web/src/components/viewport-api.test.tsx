/**
 * The 3D view's own settings and overlays (packages/viewport) with the real scene: display modes,
 * colours, looks, heat maps, see-through and ghost parts, joint symbols, handles, the camera's
 * moves and projections, navigation, pictures, and the wheel and buttons of a mouse. Each is set and
 * the view stays consistent: picking still finds the part drawn there.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { apply, getViewport, newProject, rebuildNow, useApp } from "../store";
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
];
let vp: Viewport;
const FACE = new Set(["face"] as const);

/** The part under the model's top centre still picks. */
const picksTop = () => {
  const at = vp.worldToScreen([20, 10, 10])!;

  return vp.pick(at[0], at[1], FACE)?.kind === "face";
};

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "View API");
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

describe("the 3D view's settings", () => {
  it("draws in every display mode, dark and light", () => {
    for (const mode of ["shaded", "wireframe", "xray", "hidden_line", "rendered", "shaded_edges"] as const) {
      vp.setDisplayMode(mode);
      expect(vp.mode).toBe(mode);
    }

    vp.setDark(true);
    vp.setDark(false);
    vp.setGridVisible(false);
    vp.setGridVisible(true);
    vp.setPlaneEmphasis(true);
    vp.setPlaneEmphasis(false);
    expect(picksTop()).toBe(true);
  });

  it("paints colours, looks, heat maps and textures on the parts", () => {
    vp.setBodyColors(new Map([["ex1", "#ff0000"]]));
    vp.setBodyLooks(new Map([["ex1", { color: "#00ff00", roughness: 0.2, metalness: 1 }]]));
    vp.setBodyHeat(
      new Map([
        [
          "ex1",
          {
            positions: new Float32Array([0, 0, 10, 40, 0, 10, 40, 20, 10]),
            colors: new Float32Array(9).fill(1),
          },
        ],
      ]),
    );
    vp.setBodyHeat(new Map());

    const look = { roughness: 0.4, metalness: 0 };
    expect(
      vp.swatches([
        { color: "#ff0000", look },
        { color: "#0000ff", look: { roughness: 0.2, metalness: 1 } },
      ] as never).length,
    ).toBe(2);
    vp.setTurntable(true);
    expect(vp.turntable).toBe(true);
    vp.setTurntable(false);
    expect(picksTop()).toBe(true);
  });

  it("shows a ghost of an extrusion, handles and joint symbols", () => {
    vp.setGhost({
      triangles: new Float32Array([0, 0, 10, 10, 0, 10, 0, 10, 10]),
      normal: [0, 0, 1],
      distance: 5,
    });
    vp.setGhost({
      triangles: new Float32Array([0, 0, 10, 10, 0, 10, 0, 10, 10]),
      normal: [0, 0, 1],
      distance: -5,
    });
    vp.setGhost(null);
    vp.setHandles([
      {
        id: "h",
        origin: [20, 10, 10],
        dir: [0, 0, 1],
        value: 5,
        onDrag: () => undefined,
        onEnd: () => undefined,
      },
    ]);
    expect(vp.handleTipScreen("h")).not.toBeNull();
    expect(vp.handleTipScreen("zz")).toBeNull();
    vp.setHandles([]);
    vp.setJointGlyphs([
      { id: "j1", origin: [0, 0, 0], axis: [0, 0, 1], kind: "revolute", active: true } as never,
    ]);
    vp.setJointGlyphs([]);
    expect(picksTop()).toBe(true);
  });

  it("moves the camera, frames parts and switches projection", () => {
    for (const v of ["front", "back", "left", "right", "top", "bottom", "iso"] as const) vp.setView(v, false);
    vp.orbit(0.3, 0.2);
    vp.viewFrom([1, 1, 1], false);
    vp.lookAtFace([20, 10, 10], [0, 0, 1]);
    vp.alignToFrame({ origin: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] } as never, false);
    vp.resetFraming();
    vp.setBottomInset(100);
    vp.setBottomInset(0);
    vp.setProjection("orthographic");
    vp.fit(false);
    vp.setProjection("perspective");
    vp.setView("top", false);
    vp.fit(false);

    const box = vp.modelBox(["ex1"])!;
    expect(box.max[0] - box.min[0]).toBeCloseTo(40, 3);
    expect(vp.cameraQuaternion).toBeInstanceOf(THREE.Quaternion);
    expect(picksTop()).toBe(true);
  });

  it("makes pictures", () => {
    expect(vp.snapshot(120, 90)).toMatch(/^data:image\/png/);
    expect(vp.snapshot(120, 90, true)).toMatch(/^data:image\/png/);
    expect(vp.renderImage(64, 48, { transparent: true }).width).toBe(64);
  });

  it("takes the mouse: wheel, buttons and modifier keys by the chosen navigation", async () => {
    vp.setNavigation(
      {
        orbit: [{ button: "right" }],
        pan: [{ button: "middle" }],
        zoom: [{ button: "right", mod: "shift" }],
      } as never,
      true,
      false,
    );

    const at = { clientX: 400, clientY: 300 };
    await act(async () => {
      fireEvent.wheel(vp.canvas, { ...at, deltaY: 40 });
      fireEvent.wheel(vp.canvas, { ...at, deltaX: 30, deltaY: 2, deltaMode: 0 });
      fireEvent.wheel(vp.canvas, { ...at, deltaY: 3, ctrlKey: true });

      for (const [button, extra] of [
        [1, {}],
        [2, {}],
        [2, { shiftKey: true }],
        [1, { altKey: true }],
        [2, { metaKey: true }],
      ] as const) {
        fireEvent.pointerDown(vp.canvas, {
          ...at,
          ...extra,
          button,
          buttons: 1 << button,
          pointerId: 3,
          pointerType: "mouse",
        });
        fireEvent.pointerMove(vp.canvas, {
          ...at,
          clientX: 420,
          button,
          buttons: 1 << button,
          pointerId: 3,
          pointerType: "mouse",
        });
        fireEvent.pointerUp(vp.canvas, { ...at, button, buttons: 0, pointerId: 3, pointerType: "mouse" });
      }
    });
    vp.setNavigation({ orbit: [{ button: "middle" }], pan: [{ button: "right" }], zoom: [] } as never);
    await act(async () => void (await rebuildNow()));
    expect(useApp.getState().output!.report.bodies).toHaveLength(1);
  });
});
