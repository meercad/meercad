/**
 * Lines of a sketch shown in the 3D view (drawn as fat lines) are picked where they are drawn,
 * before the sketch's region inside them, and a click there selects the sketch with that line. A
 * hovered line or edge of a part gets a thick line over it, gone again when the pointer leaves it.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import type { Viewport } from "@meercad/viewport";
import { apply, getViewport, newProject, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { clickInView, DEFAULT_KINDS } from "./viewport/click";
import { ViewportView } from "./ViewportView";

const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "p1", type: "point", x: 0, y: 0 },
      { id: "p2", type: "point", x: 0, y: 50 },
      { id: "p3", type: "point", x: 50, y: 50 },
      { id: "p4", type: "point", x: 50, y: 0 },
      { id: "l1", type: "line", p1: "p1", p2: "p2" },
      { id: "l2", type: "line", p1: "p2", p2: "p3" },
      { id: "l3", type: "line", p1: "p3", p2: "p4" },
      { id: "l4", type: "line", p1: "p4", p2: "p1" },
    ],
    constraints: [],
  },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "q1", type: "point", x: 100, y: 0 },
      { id: "q2", type: "point", x: 120, y: 0 },
      { id: "q3", type: "point", x: 120, y: 20 },
      { id: "m1", type: "line", p1: "q1", p2: "q2" },
      { id: "m2", type: "line", p1: "q2", p2: "q3" },
      { id: "m3", type: "line", p1: "q3", p2: "q1" },
    ],
    constraints: [],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
];
/** The thick line drawn over what the pointer is on, if any. */
const hoverLine = () =>
  (vp as unknown as { hoverLine: { material: { linewidth: number }; parent: unknown } | null }).hoverLine;
let vp: Viewport;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Sketch picking");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
  // Fat lines learn the screen's size when they are drawn.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
});
afterAll(cleanup);

describe("a sketch line in the 3D view", () => {
  it("is picked on the line, the region only inside it", () => {
    const on = vp.worldToScreen([50, 25, 0])!;
    expect(vp.pick(on[0], on[1], DEFAULT_KINDS)).toMatchObject({
      kind: "sketch_curve",
      sketchId: "sk1",
      curveId: "l3",
    });

    const inside = vp.worldToScreen([25, 25, 0])!;
    expect(vp.pick(inside[0], inside[1], DEFAULT_KINDS)).toMatchObject({ kind: "region", sketchId: "sk1" });
  });

  it("selects its sketch when clicked", async () => {
    const on = vp.worldToScreen([50, 25, 0])!;
    await act(async () => clickInView(vp, vp.pick(on[0], on[1], DEFAULT_KINDS), false));
    expect(useApp.getState().selectedFeature).toBe("sk1");
    expect(useApp.getState().selection).toMatchObject([{ kind: "sketch_curve", curveId: "l3" }]);
  });

  it("stands out under the pointer with a thick line, as does an edge of a part", async () => {
    const on = vp.worldToScreen([50, 25, 0])!;
    await act(async () => vp.setHover(vp.pick(on[0], on[1], DEFAULT_KINDS)));
    expect(hoverLine()?.material.linewidth).toBe(5);
    expect(hoverLine()?.parent).toBeTruthy();
    expect(vp.renderer.domElement.style.cursor).toBe("pointer");

    const edge = vp.worldToScreen([110, 0, 10])!;
    const edgePick = vp.pick(edge[0], edge[1], DEFAULT_KINDS);
    expect(edgePick?.kind).toBe("edge");
    await act(async () => vp.setHover(edgePick));
    expect(hoverLine()?.material.linewidth).toBe(5);

    await act(async () => vp.setHover(null));
    expect(hoverLine()).toBeNull();
    expect(vp.renderer.domElement.style.cursor).not.toBe("pointer");
  });
});
