/**
 * Dragging a selected sketch line on the model (viewport/sketchLineDrag.ts), in the real 3D view: the
 * line has a drag arrow that the line itself grabs too; dragging moves the line across itself, its
 * neighbours follow, the width dimension that held it changes with it, and it is one undo step.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchFeature } from "@meercad/schema";
import type { Handle, Viewport } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, undo, useApp } from "../store";
import { getSolver } from "../sketch/solver";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
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
    constraints: [
      { id: "c1", type: "coincident", a: "p1", b: "origin" },
      { id: "c2", type: "point_on", point: "p2", curve: "origin.y" },
      { id: "c3", type: "horizontal", line: "l2" },
      { id: "c4", type: "point_on", point: "p4", curve: "origin.x" },
      { id: "c5", type: "vertical", line: "l3" },
      { id: "c6", type: "length", line: "l2", value: 50 },
    ],
  },
];
let vp: Viewport;

const sketch = () => currentDoc().features.find((x) => x.id === "sk1") as SketchFeature;
const point = (id: string) => sketch().entities.find((x) => x.id === id) as { x: number; y: number };
const lineHandle = () => vp.handles.find((x) => x.id === "sketch_line") as Handle | undefined;

beforeAll(async () => {
  withScreen();
  await getSolver();
  await newProject(undefined, "Line drag");
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

describe("a sketch line selected on the model", () => {
  it("has a drag arrow that the line itself grabs too", async () => {
    await act(async () =>
      useApp.setState({
        selection: [{ kind: "sketch_curve", sketchId: "sk1", curveId: "l3", point: [50, 25, 0] }],
        selectedFeature: "sk1",
      }),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(lineHandle()).toBeDefined();

    const onLine = vp.worldToScreen([50, 10, 0])!;
    const rect = vp.canvas.getBoundingClientRect();
    const hit = (vp as unknown as { hitHandle(x: number, y: number): Handle | null }).hitHandle(
      rect.left + onLine[0],
      rect.top + onLine[1],
    );
    expect(hit?.id).toBe("sketch_line");
  });

  it("moves across itself, changing the width that held it, as one undo step", async () => {
    const handle = lineHandle()!;
    await act(async () => {
      handle.onDrag(3);
      handle.onDrag(5);
      handle.onEnd(5);
    });
    await rebuilt();

    expect(point("p3").x).toBeCloseTo(55, 4);
    expect(point("p4").x).toBeCloseTo(55, 4);
    expect(point("p4").y).toBeCloseTo(0, 4);
    expect(sketch().constraints.find((x) => x.id === "c6")).toMatchObject({ value: 55 });

    undo();
    expect(point("p3").x).toBeCloseTo(50, 4);
    expect(sketch().constraints.find((x) => x.id === "c6")).toMatchObject({ value: 50 });
  });

  it("is no arrow for a curve the sketch no longer has", async () => {
    await act(async () =>
      useApp.setState({
        selection: [{ kind: "sketch_curve", sketchId: "sk1", curveId: "gone", point: [0, 0, 0] }],
      }),
    );
    expect(lineHandle()).toBeUndefined();
  });
});
