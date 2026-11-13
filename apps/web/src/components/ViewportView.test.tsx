/**
 * The 3D view (ViewportView.tsx) mounted in happy-dom with the real viewport and the real kernel;
 * only the WebGL drawing is left out (apps/web/test/setup.ts). The view takes the design's parts,
 * hides and colours them, measures between picks, and the joints panel moves them.
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, getViewport, newProject, useApp } from "../store";
import { rebuilt, renderUi } from "../../test/ui";
import { ViewportView } from "./ViewportView";
import { openForCheck, restPose, setJointValue, useMotion } from "../lib/mechanism";

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
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];

beforeAll(async () => {
  await newProject(undefined, "View");
  apply(
    { type: "add_features", features: design },
    {
      type: "set_joint",
      joint: {
        id: "j1",
        type: "slider",
        a: "ex2",
        b: "ground",
        anchor: { axis: { ref: "origin.X" } },
        limits: [-30, 30],
      },
    },
  );
});
afterEach(cleanup);

describe("the 3D view", () => {
  it("shows the design's parts and registers itself", async () => {
    renderUi(<ViewportView />);
    await rebuilt();

    const vp = getViewport()!;
    expect(vp).toBeTruthy();
    expect(vp.canvas.tagName).toBe("CANVAS");
    expect(document.body.contains(vp.canvas)).toBe(true);
  });

  it("hides parts, shows sketches and planes", async () => {
    renderUi(<ViewportView />);
    await rebuilt();
    await act(async () =>
      useApp.setState({ hidden: new Set(["ex2"]), showPlanes: true, showSketches: true }),
    );
    await act(async () => useApp.setState({ hidden: new Set(), showPlanes: false }));
    expect(getViewport()).toBeTruthy();
  });

  it("moves a part when the joints panel moves it", async () => {
    renderUi(<ViewportView />);
    await rebuilt();
    await act(async () => {
      openForCheck();
      setJointValue("j1", -20);
    });
    expect(useMotion.getState().free["j1"]).toBe(-20);
    await act(async () => restPose());
    await act(async () => useMotion.setState({ open: false }));
  });
});
