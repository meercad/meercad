/**
 * Finishing a spline with a key (Enter or Escape) keeps what was drawn before it: the keys act on
 * the sketch as it is now, not as it was when the editor opened.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SketchFeature } from "@meercad/schema";
import { THREE, type Viewport } from "@meercad/viewport";
import { closeSketch, currentDoc, getViewport, newProject, startSketch, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "../components/ViewportView";
import { setTool } from "./state";

let vp: Viewport;
const settle = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));
const sketch = () => currentDoc().features.find((f) => f.id === useApp.getState().sketchId) as SketchFeature;

const at = (u: number, v: number) => {
  const [x, y] = vp.worldToScreen([u, v, 0])!;

  return { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", button: 0, isPrimary: true };
};

async function clickAt(u: number, v: number) {
  const ev = at(u, v);
  await act(async () => {
    fireEvent.pointerMove(vp.canvas, { ...ev, buttons: 0 });
    fireEvent.pointerDown(vp.canvas, { ...ev, buttons: 1 });
    fireEvent.pointerUp(vp.canvas, { ...ev, buttons: 0 });
  });
  await settle();
}

beforeEach(async () => {
  withScreen();
  await newProject(undefined, "Spline");
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => startSketch({ ref: "origin.XY" }));
  await act(async () =>
    vp.lookFrom(new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0), false, new THREE.Vector3(20, 10, 0)),
  );
  await settle(50);
});
afterEach(async () => {
  await act(async () => closeSketch());
  cleanup();
});
it.each(["Enter", "Escape"])("%s keeps what was drawn before the spline", async (key) => {
  await act(async () => setTool("line"));
  await clickAt(0, 0);
  await clickAt(30, 0);
  await act(async () => void fireEvent.keyDown(window, { key: "Escape" }));
  await settle();

  const before = sketch().entities.filter((e) => e.type === "line").length;
  await act(async () => setTool("spline"));
  await clickAt(0, 10);
  await clickAt(10, 20);
  await clickAt(20, 12);
  await act(async () => void fireEvent.keyDown(window, { key }));
  await settle();

  const types = sketch().entities.map((e) => e.type);
  expect(before).toBe(1);
  expect(types.filter((t) => t === "line").length).toBe(1);
  expect(types.filter((t) => t === "spline").length).toBe(1);
});
