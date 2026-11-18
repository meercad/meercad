/**
 * Angles and movable values on the model (InlineValues.tsx), in the real 3D view: two lines of a
 * sketch picked together show the angle between them, typing it adds the angle dimension, and a
 * dimension's value dragged elsewhere stays where it was put (stored in the sketch).
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchFeature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { apply, currentDoc, getViewport, newProject, rebuildNow, useApp } from "../store";
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
];
const curve = (curveId: string): Pick => ({
  kind: "sketch_curve",
  sketchId: "sk1",
  curveId,
  point: [10, 2, 0],
});
const chips = () => [...document.querySelectorAll<HTMLElement>(".value-chip")];
const texts = () => chips().map((x) => x.querySelector("button")?.textContent ?? "");
const sketch = () => currentDoc().features.find((x) => x.id === "sk1") as SketchFeature;

async function select(...picks: Pick[]) {
  await rebuilt();
  await act(async () => useApp.setState({ selection: picks, selectedFeature: "sk1" }));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
}

beforeAll(async () => {
  withScreen();
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
    expect(texts()).toEqual(["∠ 45°"]);
    expect(chips()[0]!.classList.contains("quick-dim")).toBe(true);

    await act(async () => void fireEvent.click(chips()[0]!.querySelector("button")!));

    const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "30" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));

    expect(sketch().constraints.at(-1)).toMatchObject({ type: "angle", a: "l1", b: "l2", value: 30 });

    const p3 = (await rebuildNow()).report.sketches[0]!.points.find(([id]) => id === "p3")!;
    expect((Math.atan2(p3[2], p3[1]) * 180) / Math.PI).toBeCloseTo(30, 3);

    // Now a dimension: shown as one.
    await select(curve("l2"), curve("l1"));
    expect(texts()).toEqual(["30°"]);
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
  });
});
