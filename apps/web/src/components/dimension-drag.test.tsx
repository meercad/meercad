/**
 * Dragging a sketch dimension's line (parallel to itself), on the model (InlineValues.tsx) and in the
 * sketch editor (SketchEditor.tsx), in the real 3D view: while the drag goes on only the picture
 * follows (the document stays as it is, nothing is solved or built); on release the sketch gets the
 * new place once, as one undo step, and the model is not built again for it.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchFeature } from "@meercad/schema";
import type { Handle, Viewport } from "@meercad/viewport";
import {
  apply,
  closeSketch,
  currentDoc,
  getViewport,
  newProject,
  openSketch,
  rebuildNow,
  undo,
  useApp,
} from "../store";
import { getSolver } from "../sketch/solver";
import { setTool } from "../sketch/state";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "p1", type: "point", x: 0, y: 0 },
      { id: "p2", type: "point", x: 40, y: 0 },
      { id: "p3", type: "point", x: 40, y: 20 },
      { id: "p4", type: "point", x: 0, y: 20 },
      { id: "l1", type: "line", p1: "p1", p2: "p2" },
      { id: "l2", type: "line", p1: "p2", p2: "p3" },
      { id: "l3", type: "line", p1: "p3", p2: "p4" },
      { id: "l4", type: "line", p1: "p4", p2: "p1" },
    ],
    constraints: [
      { id: "c1", type: "length", line: "l1", value: 40 },
      { id: "c2", type: "horizontal", line: "l1" },
      { id: "c3", type: "vertical", line: "l2" },
      { id: "c4", type: "horizontal", line: "l3" },
      { id: "c5", type: "vertical", line: "l4" },
      { id: "c6", type: "fix", point: "p1" },
    ],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
let vp: Viewport;

const sketch = () => currentDoc().features.find((x) => x.id === "sk1") as SketchFeature;
const label = () => (sketch().constraints.find((x) => x.id === "c1") as { label?: [number, number] }).label;
const grip = (id: string) =>
  (vp as unknown as { grips: Handle[] }).grips.find((x) => x.id === id) as Handle | undefined;
const settle = (ms = 30) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

beforeAll(async () => {
  withScreen();
  await getSolver();
  await newProject(undefined, "Dimension drag");
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

/**
 * Drags `id` by 3 and then 6 mm: the document stays the same while it goes on, the grip (laid out
 * again from the dimension as shown) follows; released, the label is where it was let go.
 */
async function dragDimension(id: string) {
  const start = grip(id);
  expect(start, id).toBeDefined();

  const before = currentDoc();
  const along = (h: Handle, by: number) => h.origin.map((x, i) => x + h.dir[i]! * by);
  await act(async () => {
    start!.onDrag(3);
    start!.onDrag(6);
  });
  await settle();
  expect(currentDoc()).toBe(before);
  expect(label()).toBeUndefined();

  // Where it is shown is the place it would be stored at (0.01 mm).
  const moved = grip(id)!;
  along(start!, 6).forEach((x, i) => expect(moved.origin[i]).toBeCloseTo(x, 1));

  await act(async () => start!.onEnd(6));
  await settle();

  return along(start!, 6);
}

describe("a dimension's line dragged on the model", () => {
  it("only moves the picture while it goes on, and is stored once on release", async () => {
    await act(async () => useApp.setState({ selectedFeature: "sk1", selection: [] }));
    await settle();

    const end = await dragDimension("dimension:sk1.c1");
    expect(label()).toBeDefined();
    // The value is where it was let go (top view: sketch x, y are world x, y).
    expect(grip("dimension:sk1.c1")!.origin[1]).toBeCloseTo(end[1]!, 2);

    // The model is not built again for a value's place.
    expect((await rebuildNow()).report.firstRecomputed).toBe(-1);

    // One undo step.
    undo();
    expect(label()).toBeUndefined();
  });
});

describe("a dimension's line dragged in the sketch editor", () => {
  it("only moves the picture while it goes on, and is stored once on release", async () => {
    await act(async () => openSketch("sk1"));
    await rebuilt();
    await act(async () => setTool("select"));
    await settle();

    await dragDimension("dimension:c1");
    expect(label()).toBeDefined();
    expect((await rebuildNow()).report.firstRecomputed).toBe(-1);

    undo();
    expect(label()).toBeUndefined();
    await act(async () => closeSketch());
  });
});
