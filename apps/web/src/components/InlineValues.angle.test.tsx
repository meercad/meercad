/**
 * Angles and movable values on the model (InlineValues.tsx), in the real 3D view: two lines of a
 * sketch picked together show the angle between them on a dashed arc, typing it adds the angle
 * dimension and turns the second line only (the first stays exactly where it was), and a dimension's
 * value dragged elsewhere stays where it was put (stored in the sketch).
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchFeature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, rebuildNow, useApp } from "../store";
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
      { id: "p2", type: "point", x: 40, y: 0 },
      { id: "p3", type: "point", x: 20, y: 20 },
      { id: "l1", type: "line", p1: "p1", p2: "p2" },
      { id: "l2", type: "line", p1: "p1", p2: "p3" },
      { id: "l3", type: "line", p1: "p2", p2: "p3" },
    ],
    constraints: [
      { id: "c1", type: "coincident", a: "p1", b: "origin" },
      { id: "c2", type: "horizontal", line: "l1" },
      { id: "c3", type: "length", line: "l1", value: 40 },
    ],
  },
  // Two lines nothing holds: only the angle decides which of them moves.
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "q1", type: "point", x: 60, y: 0 },
      { id: "q2", type: "point", x: 100, y: 0 },
      { id: "q3", type: "point", x: 80, y: 20 },
      { id: "m1", type: "line", p1: "q1", p2: "q2" },
      { id: "m2", type: "line", p1: "q1", p2: "q3" },
    ],
    constraints: [],
  },
];
const curve = (curveId: string, sketchId = "sk1"): Pick => ({
  kind: "sketch_curve",
  sketchId,
  curveId,
  point: [10, 2, 0],
});
const chips = () => [...document.querySelectorAll<HTMLElement>(".value-chip")];
const texts = () => chips().map((x) => x.querySelector("button")?.textContent ?? "");
const sketch = () => currentDoc().features.find((x) => x.id === "sk1") as SketchFeature;

/** A line's two end points as stored in the document. */
const ends = (lineId: string) => {
  const line = sketch().entities.find((x) => x.id === lineId) as { p1: string; p2: string };

  return [line.p1, line.p2].map((id) => sketch().entities.find((x) => x.id === id));
};

async function type(chip: HTMLElement, value: string) {
  await act(async () => void fireEvent.click(chip.querySelector("button")!));

  const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
}

async function select(...picks: Pick[]) {
  await rebuilt();

  const sketchId = (picks[0] as { sketchId: string }).sketchId;
  await act(async () => useApp.setState({ selection: picks, selectedFeature: sketchId }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
}

beforeAll(async () => {
  withScreen();
  await getSolver();
  await newProject(undefined, "Inline angles");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => {
    const viewport = getViewport()!;
    viewport.setView("top", false);
    viewport.fit(false);
  });
});
afterAll(cleanup);

describe("two lines picked together", () => {
  it("show the angle between them, and a typed angle becomes a dimension", async () => {
    await select(curve("l1"), curve("l2"));
    expect(texts()).toEqual(["45°"]);
    expect(chips()[0]!.classList.contains("quick-dim")).toBe(true);

    const before = ends("l1");
    await type(chips()[0]!, "30");
    // The first line picked stays exactly where it was; the other one turns.
    expect(ends("l1")).toEqual(before);

    expect(sketch().constraints.at(-1)).toMatchObject({ type: "angle", a: "l1", b: "l2", value: 30 });

    const p3 = (await rebuildNow()).report.sketches[0]!.points.find(([id]) => id === "p3")!;
    expect((Math.atan2(p3[2], p3[1]) * 180) / Math.PI).toBeCloseTo(30, 3);

    // Now a dimension: shown as one, with its dashed arc; a new value turns the same line again.
    await select(curve("l2"), curve("l1"));
    expect(texts()).toEqual(["30°"]);
    expect(chips()[0]!.classList.contains("on-line")).toBe(true);
    expect(getViewport()!.overlay.children.some((x) => x.children.length > 0)).toBe(true);

    await type(chips()[0]!, "50");
    expect(ends("l1")).toEqual(before);

    const turned = (await rebuildNow()).report.sketches[0]!.points.find(([id]) => id === "p3")!;
    expect((Math.atan2(turned[2], turned[1]) * 180) / Math.PI).toBeCloseTo(50, 3);
  });

  it("turn the line picked second, also when nothing else holds the first one", async () => {
    const free = () => currentDoc().features.find((x) => x.id === "sk2") as SketchFeature;
    const point = (id: string) => free().entities.find((x) => x.id === id);
    const [q1, q2, q3] = ["q1", "q2", "q3"].map(point);
    await select(curve("m2", "sk2"), curve("m1", "sk2"));
    expect(texts()).toEqual(["45°"]);
    await type(chips()[0]!, "70");

    expect([point("q1"), point("q3")]).toEqual([q1, q3]);
    expect(point("q2")).not.toEqual(q2);
  });

  it("show no angle for the same line picked twice", async () => {
    await select(curve("l1"), curve("l1"));
    expect(texts().some((x) => x.startsWith("∠"))).toBe(false);
  });
});

describe("a dimension's value", () => {
  it("stays where it was dragged, in the sketch", async () => {
    await select(curve("l1"));

    const chip = chips().find((x) => x.textContent === "40")!;
    expect(chip).toBeDefined();

    const viewport = getViewport()!;
    const rect = viewport.canvas.getBoundingClientRect();
    const target = viewport.worldToScreen([20, -15, 0])!;
    const [x, y] = [rect.left + target[0], rect.top + target[1]];
    await act(async () => {
      fireEvent.pointerDown(chip, { clientX: x - 40, clientY: y - 40, pointerId: 5, button: 0 });
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, pointerId: 5 }));
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: x, clientY: y, pointerId: 5 }));
    });

    const label = (sketch().constraints.find((c) => c.id === "c3") as { label?: [number, number] }).label!;
    expect(label[0]).toBeCloseTo(20, 1);
    expect(label[1]).toBeCloseTo(-15, 1);

    // Drawn like a drawing's dimension on the model: lines and arrowheads, its value on the line.
    await select(curve("l1"));
    expect(
      chips()
        .find((x) => x.textContent === "40")!
        .classList.contains("on-line"),
    ).toBe(true);

    const drawn = getViewport()!.overlay.children.flatMap((x) => x.children);
    expect(drawn.some((x) => x.children.length === 2)).toBe(true);
  });
});
