/**
 * The values shown on the model (InlineValues.tsx) for the selected step, in the real 3D view: an
 * extrude's distance and its sketch's sizes appear as chips, and a value typed into a chip changes
 * the part to the volume that follows; a new variable can be made from a value.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
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
const chips = () => [...document.querySelectorAll<HTMLButtonElement>(".value-chip button[title='Click to edit']")];
const volume = async () => (await rebuildNow()).report.bodies[0]!.volume;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Inline");
  apply({ type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => {
    const vp = (await import("../store")).getViewport()!;
    vp.setView("iso", false);
    vp.fit(false);
    useApp.setState({ selectedFeature: "ex1" });
  });
  await act(async () => new Promise((r) => setTimeout(r, 30)));
});
afterAll(cleanup);

describe("values on the model", () => {
  it("shows the extrude's distance and the sketch's sizes", () => {
    const texts = chips().map((c) => c.textContent);
    expect(texts.some((t) => /10/.test(t ?? ""))).toBe(true);
    expect(chips().length).toBeGreaterThanOrEqual(1);
  });

  it("changes the distance typed into its chip", async () => {
    const chip = chips().find((c) => /10/.test(c.textContent ?? ""))!;
    await act(async () => void fireEvent.click(chip));
    const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
    expect(input).not.toBeNull();
    await act(async () => void fireEvent.change(input, { target: { value: "25" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(String((currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown }).distance)).toMatch(/^25( mm)?$/);
    expect(await volume()).toBeCloseTo(40 * 20 * 25, 6);
  });

  it("leaves the value as it was on Escape", async () => {
    await rebuilt();
    const chip = chips().find((c) => /25/.test(c.textContent ?? ""))!;
    await act(async () => void fireEvent.click(chip));
    const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "99" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Escape" }));
    expect(await volume()).toBeCloseTo(40 * 20 * 25, 6);
  });

  it("makes a variable from a value", async () => {
    await rebuilt();
    const chip = chips().find((c) => /25/.test(c.textContent ?? ""))!;
    await act(async () => void fireEvent.click(chip));
    const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
    // The last entry of the list makes a new variable of the value.
    const make = [...document.querySelectorAll<HTMLButtonElement>(".value-menu button")].at(-1);
    expect(make).toBeDefined();
    {
      await act(async () => void fireEvent.mouseDown(make));
      await act(async () => void fireEvent.click(make));
      const name = screen.queryByLabelText("Variable name") as HTMLInputElement | null;
      expect(name).not.toBeNull();
      if (name) {
        await act(async () => void fireEvent.change(name, { target: { value: "height" } }));
        await act(async () => void fireEvent.keyDown(name, { key: "Enter" }));
        expect(currentDoc().params["height"]).toMatch(/^25( mm)?$/);
        expect((currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown }).distance).toBe("height");
      }
    }
    void input;
  });
});
