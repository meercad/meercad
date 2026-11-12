/**
 * Variables and variants in the side panel (FeatureTree.tsx) with the real kernel: switching to a
 * variant builds the part at its values, a value typed while a variant is in use goes into that
 * variant and leaves the plain value alone; variants are renamed and deleted from their menu; a
 * variable still in use is deleted only after asking; a new one is added with Enter and dropped
 * with Escape. Steps are chosen several at once, and a sketch is exported from its menu.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { answer, contextMenu, pickMenu, renderUi } from "../../test/ui";
import { SidePanel } from "./FeatureTree";

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
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
];
const volume = async () => (await rebuildNow()).report.bodies[0]!.volume!;
const rebuilt = () => act(async () => void (await rebuildNow()));
const chip = (name: string) => screen.getAllByRole("radio").find((b) => b.textContent === name)!;
const hRow = () => screen.getByDisplayValue("h").closest(".param-row")!;
async function typeValue(row: Element, value: string) {
  const input = row.querySelectorAll("input")[1]!;
  await act(async () => void fireEvent.focus(input));
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  await act(async () => void fireEvent.blur(input));
}

beforeAll(async () => {
  await newProject(undefined, "Variants");
  apply({ type: "set_param", name: "h", expr: "10 mm" }, { type: "add_features", features: design }, { type: "set_variant", name: "Short", params: { h: "4 mm" } }, { type: "set_variant", name: "Tall", params: { h: "25 mm" } });
  await rebuildNow();
});
afterEach(cleanup);

describe("variants in the side panel", () => {
  it("builds the part at a variant's values and back at the plain ones", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    expect(await volume()).toBeCloseTo(8000, 6);
    await act(async () => void fireEvent.click(chip("Tall")));
    expect(currentDoc().variant).toBe("Tall");
    expect(await volume()).toBeCloseTo(40 * 20 * 25, 6);
    await act(async () => void fireEvent.click(chip("Plain values")));
    expect(currentDoc().variant ?? null).toBeNull();
    expect(await volume()).toBeCloseTo(8000, 6);
  });

  it("puts a value typed while a variant is in use into that variant only", async () => {
    renderUi(<SidePanel />);
    await act(async () => void fireEvent.click(chip("Short")));
    await rebuilt();
    expect(hRow().classList.contains("in-variant")).toBe(true);
    await typeValue(hRow(), "6");
    expect(String(currentDoc().variants!.find((v) => v.name === "Short")!.params["h"])).toMatch(/^6( mm)?$/);
    expect(currentDoc().params["h"]).toBe("10 mm");
    expect(await volume()).toBeCloseTo(40 * 20 * 6, 6);
    await act(async () => void fireEvent.click(chip("Plain values")));
  });

  it("renames and deletes a variant from its menu", async () => {
    renderUi(<SidePanel />);
    await contextMenu(chip("Tall"));
    await pickMenu("Rename…");
    await answer("Giant");
    expect(currentDoc().variants!.map((v) => v.name)).toEqual(["Short", "Giant"]);
    await contextMenu(chip("Giant"));
    await pickMenu("Delete");
    expect(currentDoc().variants!.map((v) => v.name)).toEqual(["Short"]);
  });
});

describe("variables and steps", () => {
  it("adds a variable with Enter, drops one with Escape, and deletes one in use only after asking", async () => {
    renderUi(<SidePanel />);
    await act(async () => void fireEvent.click(screen.getByTitle("Add variable")));
    const [name, expr] = [...document.querySelectorAll<HTMLInputElement>(".param-row input.name-input, .param-row input.expr")].slice(-2);
    await act(async () => void fireEvent.change(name!, { target: { value: "gap" } }));
    await act(async () => void fireEvent.change(expr!, { target: { value: "0.3 mm" } }));
    await act(async () => void fireEvent.keyDown(expr!, { key: "Enter" }));
    expect(currentDoc().params["gap"]).toBe("0.3 mm");
    await act(async () => void fireEvent.click(screen.getByTitle("Add variable")));
    const [, other] = [...document.querySelectorAll<HTMLInputElement>(".param-row input.expr")].slice(-2);
    await act(async () => void fireEvent.keyDown(other!, { key: "Escape" }));
    expect(Object.keys(currentDoc().params).sort()).toEqual(["gap", "h"]);
    // h drives the extrusion: deleting it asks, and No keeps it.
    await act(async () => void fireEvent.click(hRow().querySelector('button[title="Still in use"]')!));
    await answer(null);
    expect(currentDoc().params["h"]).toBe("10 mm");
    // gap is free: it goes at once.
    const gapRow = screen.getByDisplayValue("gap").closest(".param-row")!;
    await act(async () => void fireEvent.click(gapRow.querySelector('button[title="Delete"]')!));
    expect(currentDoc().params["gap"]).toBeUndefined();
  });

  it("chooses several steps with ⌘ and Shift, and exports a sketch from its menu", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    const step = (id: string) => [...document.querySelectorAll("li > div.tree-item")].find((el) => el.textContent?.includes(id === "sk1" ? "Sketch 1" : "Extrude 1"))!;
    await act(async () => void fireEvent.click(step("sk1")));
    await act(async () => void fireEvent.click(step("ex1"), { metaKey: true }));
    expect(useApp.getState().featureSelection).toEqual(["sk1", "ex1"]);
    await act(async () => void fireEvent.click(step("ex1"), { metaKey: true }));
    expect(useApp.getState().featureSelection).toEqual(["sk1"]);
    await act(async () => void fireEvent.click(step("ex1"), { shiftKey: true }));
    expect(useApp.getState().featureSelection).toEqual(["sk1", "ex1"]);
    // The Mac app's save dialog gets the drawing: a DXF and an SVG of the 40 × 20 rectangle.
    const desktop = (window as unknown as { meercadDesktop: { saveFile: (f: { name: string; data: string }) => Promise<string | null> } }).meercadDesktop;
    const was = desktop.saveFile;
    const saved: { name: string; data: string }[] = [];
    desktop.saveFile = async (f) => (saved.push(f), null);
    try {
      await contextMenu(step("sk1"));
      await pickMenu("Export DXF");
      await contextMenu(step("sk1"));
      await pickMenu("Export SVG");
    } finally {
      desktop.saveFile = was;
    }
    expect(saved.map((f) => f.name)).toEqual(["Variants-sk1.dxf", "Variants-sk1.svg"]);
    expect(saved[0]!.data).toMatch(/\bLINE\b/);
    expect(saved[1]!.data).toMatch(/<svg/);
  });
});
