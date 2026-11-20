/**
 * Tangent knobs of a selected spline in the sketch editor (pointer.ts, scene.ts, handles.ts), in the
 * real 3D view: hovering a knob tells what it does, dragging it gives its point its own tangent (one
 * undo step, the curve bends towards it), a double-click makes the tangent automatic again.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SketchEntity, SketchFeature } from "@meercad/schema";
import { splineArms, type Vec2 } from "@meercad/sketch";
import { THREE, type Viewport } from "@meercad/viewport";
import { apply, closeSketch, currentDoc, getViewport, newProject, startSketch, undo, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { MIN_ARM_PIXELS } from "./editor/handles";
import { setSketchSelection, setTool } from "./state";

type Spline = Extract<SketchEntity, { type: "spline" }>;

let vp: Viewport;
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;
const spline = () => sketch().entities.find((e) => e.id === "sp") as Spline;
const through: Vec2[] = [
  [0, 0],
  [20, 20],
  [40, 0],
];
const wait = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));

const screen = ([u, v]: Vec2) => vp.worldToScreen([u, v, 0])!;

const ev = (at: Vec2, buttons: number) => {
  const [x, y] = screen(at);

  return { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, buttons, isPrimary: true };
};

/** Where the knob of point 1 towards point 2 is drawn (its arm, at least MIN_ARM_PIXELS long). */
function knob(tangent?: Vec2): Vec2 {
  const arm = tangent ?? splineArms(through)[1]!.ahead;
  const px = vp.pixelSize([0, 0, 0]);
  const k = Math.max(1, (MIN_ARM_PIXELS * px) / Math.hypot(arm[0], arm[1]));

  return [20 + arm[0] * k, 20 + arm[1] * k];
}

beforeEach(async () => {
  withScreen();
  await newProject(undefined, "Spline tangents");
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => startSketch({ ref: "origin.XY" }));
  await act(async () =>
    vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 0)),
  );

  const id = useApp.getState().sketchId!;
  const entities: SketchEntity[] = [
    ...through.map((p, i): SketchEntity => ({ id: `s${i}`, type: "point", x: p[0], y: p[1] })),
    { id: "sp", type: "spline", points: ["s0", "s1", "s2"] },
  ];
  await act(async () => void apply({ type: "edit_feature", id, patch: { entities, constraints: [] } }));
  await wait(50);
  await act(async () => setTool("select"));
  await act(async () => setSketchSelection([{ kind: "curve", id: "sp" }]));
  await wait(50);
});
afterEach(async () => {
  await act(async () => closeSketch());
  cleanup();
});

describe("spline tangent knobs", () => {
  it("hovering a knob says what it does", async () => {
    await act(async () => void fireEvent.pointerMove(vp.canvas, ev(knob(), 0)));
    await wait();
    expect(document.querySelector(".cursor-tip")?.textContent).toBe("Drag to bend · double-click: automatic");

    // Away from it the tip goes.
    await act(async () => void fireEvent.pointerMove(vp.canvas, ev([20, -15], 0)));
    await wait();
    expect(document.querySelector(".cursor-tip")?.textContent ?? "").not.toContain("Drag to bend");
  });

  it("dragging a knob gives its point its own tangent; a double-click makes it automatic again", async () => {
    const from = knob();
    const to: Vec2 = [from[0] + 6, from[1] + 4];

    await act(async () => {
      fireEvent.pointerMove(vp.canvas, ev(from, 0));
      fireEvent.pointerDown(vp.canvas, ev(from, 1));
      fireEvent.pointerMove(vp.canvas, ev([from[0] + 3, from[1] + 2], 1));
      fireEvent.pointerMove(vp.canvas, ev(to, 1));
    });
    await wait();
    // While it is dragged nothing is written yet.
    expect(spline().tangents).toBeUndefined();
    await act(async () => void fireEvent.pointerUp(vp.canvas, ev(to, 0)));
    await wait(60);

    const t = spline().tangents!;
    expect(t[0]).toBeNull();
    expect(t[2]).toBeNull();

    // The tangent points from the point to where the knob was let go (to screen precision).
    const want: Vec2 = [to[0] - 20, to[1] - 20];
    const got = t[1]!;
    const angle = Math.atan2(got[1]!, got[0]!) - Math.atan2(want[1], want[0]);
    expect(Math.abs(angle)).toBeLessThan(0.05);

    // A double-click on the knob, now along the own tangent: automatic again, the field gone.
    const k = knob(got as Vec2);
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, ev(k, 0));
      fireEvent.doubleClick(vp.canvas, ev(k, 0));
    });
    await wait(60);
    expect("tangents" in spline()).toBe(false);

    // Undo brings the own tangent back (each change one step).
    await act(async () => undo());
    expect(spline().tangents?.[1]).toEqual(got);
  });

  it("a knob only pressed and let go changes nothing", async () => {
    const from = knob();
    await act(async () => {
      fireEvent.pointerMove(vp.canvas, ev(from, 0));
      fireEvent.pointerDown(vp.canvas, ev(from, 1));
      fireEvent.pointerUp(vp.canvas, ev(from, 0));
    });
    await wait(60);
    expect(spline().tangents).toBeUndefined();
    // The spline stays selected (the press went to the knob, not to a new selection).
    expect(spline().points).toHaveLength(3);
  });

  it("a second finger while one drags a knob calls the drag off", async () => {
    const from = knob();
    const finger = (at: Vec2, id: number, buttons: number) => ({
      ...ev(at, buttons),
      pointerId: id,
      pointerType: "touch",
      isPrimary: id === 1,
    });

    await act(async () => {
      fireEvent.pointerDown(vp.canvas, finger(from, 1, 1));
      fireEvent.pointerMove(vp.canvas, finger([from[0] + 3, from[1] + 2], 1, 1));
      fireEvent.pointerMove(vp.canvas, finger([from[0] + 6, from[1] + 4], 1, 1));
    });
    await wait();
    await act(async () => void fireEvent.pointerDown(vp.canvas, finger([0, -10], 2, 1)));
    await act(async () => {
      fireEvent.pointerUp(vp.canvas, finger([0, -10], 2, 0));
      fireEvent.pointerUp(vp.canvas, finger([from[0] + 6, from[1] + 4], 1, 0));
    });
    await wait(60);
    expect(spline().tangents).toBeUndefined();
  });
});
