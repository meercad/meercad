/**
 * Sketch sizes at a picked edge of the model (InlineValues.tsx with sketchEdge.ts), in the real 3D
 * view: clicking an edge a sketch line was extruded from (or opening its menu) selects that extrusion
 * and shows only that line's dimension; a line no dimension fixes shows its measured length, and a
 * value typed there adds the dimension to the sketch (one undo step); an edge along the extrusion
 * shows only its distance; a line of a sketch shown in the view shows its own size.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity, SketchFeature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, rebuildNow, undo, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { clickInView } from "./viewport/click";
import { openContextMenu } from "./viewport/contextMenu";
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
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect,
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
  // A sketch no step uses yet stays in the view, with a circle of 8 mm.
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "m", type: "point", x: 80, y: 0 },
      { id: "k1", type: "circle", center: "m", radius: 4 },
    ],
    constraints: [{ id: "d1", type: "diameter", curve: "k1", value: 8 }],
  },
];
/** The value chips (not the drag arrows' hints). */
const chips = () =>
  [...document.querySelectorAll<HTMLElement>(".value-chip")].filter((chip) =>
    chip.querySelector("button[title='Click to edit']"),
  );
const texts = () => chips().map((chip) => chip.querySelector("button")!.textContent);

/** The edge of ex1 between the faces with these tags. */
function edgeBetween(a: string, b: string): Pick {
  const mesh = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
  const edge = mesh.edgeFaces.findIndex(
    (faces) =>
      faces.length === 2 &&
      faces.some((face) => mesh.faceTags[face]!.includes(a)) &&
      faces.some((face) => mesh.faceTags[face]!.includes(b)),
  );
  expect(edge, `${a} | ${b}`).toBeGreaterThanOrEqual(0);

  return { kind: "edge", bodyId: "ex1", edge, point: [20, 0, 10] };
}

async function click(pick: Pick) {
  await rebuilt();
  await act(async () => useApp.setState({ selectedFeature: null, selection: [] }));
  await act(async () => clickInView(getViewport()!, pick, false));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
}

async function type(chipText: RegExp, value: string) {
  const chip = chips().find((x) => chipText.test(x.textContent ?? ""));
  expect(chip, `${chipText} in ${texts().join(" | ")}`).toBeDefined();
  await act(async () => void fireEvent.click(chip!.querySelector("button")!));

  const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
}

const sketch = () => currentDoc().features.find((x) => x.id === "sk1") as SketchFeature;
const box = async () => (await rebuildNow()).report.bodies.find((x) => x.id === "ex1")!.bbox;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Inline edges");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => {
    const viewport = getViewport()!;
    viewport.setView("iso", false);
    viewport.fit(false);
  });
});
afterAll(cleanup);

describe("an edge a sketch line was extruded from", () => {
  it("selects the extrusion and shows that line's dimension, changed in the sketch", async () => {
    await click(edgeBetween("ex1.side[sk1.l1]", "ex1.end_cap"));
    expect(useApp.getState().selectedFeature).toBe("ex1");
    expect(texts()).toContain("40");
    expect(texts()).toContain("↕ 10 mm");

    await type(/^40$/, "50");
    expect(sketch().constraints.find((x) => x.id === "c1")).toMatchObject({ value: 50 });
    expect((await box()).max[0]).toBeCloseTo(50, 6);

    undo();
    expect(sketch().constraints.find((x) => x.id === "c1")).toMatchObject({ value: 40 });
    expect((await box()).max[0]).toBeCloseTo(40, 6);
  });

  it("shows a line's measured length while no dimension fixes it, and adds one when typed", async () => {
    await click(edgeBetween("ex1.side[sk1.l2]", "ex1.start_cap"));
    expect(texts()).not.toContain("40");

    const measured = chips().find((x) => x.classList.contains("quick-dim"));
    expect(measured?.textContent).toMatch(/^20/);

    const before = sketch().constraints.length;
    await type(/^20/, "30");
    expect(sketch().constraints).toHaveLength(before + 1);
    expect(sketch().constraints.at(-1)).toMatchObject({ type: "length", line: "l2", value: 30 });
    expect((await box()).max[1]).toBeCloseTo(30, 6);

    // Now a dimension: shown as one, no longer as a measured size.
    await click(edgeBetween("ex1.side[sk1.l2]", "ex1.start_cap"));
    expect(texts()).toContain("30");
    expect(chips().some((x) => x.classList.contains("quick-dim"))).toBe(false);

    undo();
    expect(sketch().constraints).toHaveLength(before);
  });

  it("along the extrusion shows only its distance", async () => {
    await click(edgeBetween("ex1.side[sk1.l1]", "ex1.side[sk1.l2]"));
    expect(useApp.getState().selectedFeature).toBe("ex1");
    expect(texts()).toEqual(["↕ 10 mm"]);
  });
});

describe("the menu of an edge (right click, long press)", () => {
  it("selects the edge as a click does, so the line's dimension shows beside the menu", async () => {
    await rebuilt();
    await act(async () => useApp.setState({ selectedFeature: null, selection: [] }));
    await act(async () =>
      openContextMenu(getViewport()!, edgeBetween("ex1.side[sk1.l1]", "ex1.end_cap"), 50, 50),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
    expect(useApp.getState().selectedFeature).toBe("ex1");
    expect(texts()).toContain("40");
    await act(async () => void fireEvent.keyDown(document, { key: "Escape" }));
  });
});

describe("a line of a sketch in the view", () => {
  it("shows that curve's size", async () => {
    await click({ kind: "sketch_curve", sketchId: "sk2", curveId: "k1", point: [84, 0, 0] });
    expect(useApp.getState().selectedFeature).toBe("sk2");
    expect(texts()).toEqual(["⌀ 8"]);
  });
});
