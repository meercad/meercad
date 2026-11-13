/**
 * More of the side panel (FeatureTree.tsx): on the phone its grip closes the sheet by a tap or a
 * swipe down; a part of PLA shows its mass (40 × 20 × 10 mm at 1.24 g/cm³ = 9.92 g) and so does the
 * total; the swatch's menu offers material and colour; the parts are checked for overlaps; a
 * group is hidden whole by its button; a reference's menu starts marking on it and it is deleted;
 * variables are searched, a new one gets the next free name and is cancelled, an automatic one is
 * moved to the user's own, and Enter in a name field ends the edit.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { contextMenu, pickMenu, renderUi } from "../../test/ui";
import { glb } from "../../../../tests/glbs";
import { addTerrain } from "../lib/terrain";
import { cancelMarking, useTerrainDraw } from "../lib/terrainDraw";
import { SidePanel } from "./FeatureTree";

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
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 20, mode: "new_body" },
];
const rebuilt = () => act(async () => void (await rebuildNow()));
const settle = (ms = 30) => act(async () => new Promise((r) => setTimeout(r, ms)));
const partRow = (title: RegExp) => [...document.querySelectorAll("li.tree-item")].find((el) => title.test(el.getAttribute("title") ?? ""))!;

beforeAll(async () => {
  await newProject(undefined, "Panel more 2");
  apply({ type: "add_features", features: design }, { type: "set_param", name: "w", expr: "5 mm" }, { type: "set_param", name: "a1", expr: "3 mm", auto: true } as never);
  await rebuildNow();
});
afterEach(cleanup);

describe("the side panel, more", () => {
  it("closes the phone's sheet by a tap on its grip or a swipe down", async () => {
    renderUi(<SidePanel />);
    useApp.setState({ sideOpen: true } as never);
    const grip = document.querySelector<HTMLButtonElement>(".sheet-grip")!;
    await act(async () => void fireEvent.click(grip));
    expect(useApp.getState().sideOpen).toBe(false);
    useApp.setState({ sideOpen: true } as never);
    await act(async () => {
      fireEvent.pointerDown(grip, { clientY: 100, pointerId: 3 });
      grip.dispatchEvent(new PointerEvent("pointermove", { clientY: 120 }));
    });
    expect(useApp.getState().sideOpen).toBe(true);
    await act(async () => void grip.dispatchEvent(new PointerEvent("pointermove", { clientY: 160 })));
    expect(useApp.getState().sideOpen).toBe(false);
    // A short drag that ends is no swipe.
    useApp.setState({ sideOpen: true } as never);
    await act(async () => {
      fireEvent.pointerDown(grip, { clientY: 100, pointerId: 4 });
      grip.dispatchEvent(new PointerEvent("pointerup", { clientY: 110 }));
    });
    expect(useApp.getState().sideOpen).toBe(true);
  });

  it("shows a part's mass in its material and the total, and checks for overlaps", async () => {
    apply({ type: "set_material", part: "ex1", material: "pla" });
    renderUi(<SidePanel />);
    await rebuilt();
    await settle(200);
    // 40 × 20 × 10 mm = 8 cm³ of PLA at 1.24 g/cm³.
    expect(partRow(/40 × 20 × 10/).textContent).toMatch(/9\.92 g PLA/);
    expect(document.querySelector(".mass-total")?.textContent).toMatch(/9\.92 g/);
    const asked: unknown[] = [];
    const on = (e: Event) => void asked.push((e as CustomEvent).detail);
    window.addEventListener("meercad:materials", on);
    const mass = partRow(/40 × 20 × 10/).querySelector<HTMLElement>(".link-btn")!;
    await act(async () => void fireEvent.keyDown(mass, { key: "Enter" }));
    await act(async () => void fireEvent.click(partRow(/40 × 20 × 10/).querySelector(".part-swatch")!));
    await pickMenu(/^Material: PLA/);
    window.removeEventListener("meercad:materials", on);
    expect(asked).toEqual([["ex1"], ["ex1"]]);
    await act(async () => void fireEvent.click(screen.getByTitle("Check whether parts overlap")));
    await settle(500);
  });

  it("hides a group whole by its button", async () => {
    apply({ type: "set_part_list", groups: [{ name: "Posts", parts: ["ex2"] }] });
    renderUi(<SidePanel />);
    await rebuilt();
    const group = [...document.querySelectorAll("div.group-row")].find((el) => el.textContent?.includes("Posts"))!;
    await act(async () => void fireEvent.click(group.querySelector("button[title='Hide all']")!));
    expect(useApp.getState().hidden.has("ex2")).toBe(true);
    useApp.setState({ hidden: new Set() });
  });

  it("starts marking on a reference from its menu, and deletes it", async () => {
    renderUi(<SidePanel />);
    await act(async () => addTerrain({ folder: "Yard", photos: 3, size: [1000, 1000, 10], measured: false } as never, glb([{ x: 0, y: 0, z: 0, s: 1000 }])));
    await settle(100);
    const row = () => [...document.querySelectorAll("li.tree-item")].find((el) => el.textContent?.includes("Yard"))!;
    for (const [label, kind] of [["Mark a line", "line"], ["Mark an area", "area"], ["Highlighter", "stroke"], ["Pin a note", "note"], ["Set a stake-out point", "point"]] as const) {
      await contextMenu(row());
      await pickMenu(label);
      expect(useTerrainDraw.getState().kind, label).toBe(kind);
      cancelMarking();
    }
    await contextMenu(row());
    await pickMenu("Correct the scale…");
    cancelMarking();
    await contextMenu(row());
    await pickMenu("Clean up…");
    await act(async () => void fireEvent.keyDown(document.body, { key: "Escape" }));
    await act(async () => void fireEvent.click(row().querySelector("button[title=Delete]")!));
    expect(currentDoc().references ?? []).toHaveLength(0);
  });

  it("searches variables, adds one by the next free name, and makes an automatic one the user's", async () => {
    apply({ type: "set_param", name: "v1", expr: "1 mm" }, { type: "set_param", name: "h", expr: "2 mm" }, { type: "set_param", name: "d", expr: "w * 2" });
    renderUi(<SidePanel />);
    await rebuilt();
    const search = screen.getByPlaceholderText("Search variables");
    await act(async () => void fireEvent.change(search, { target: { value: "w" } }));
    await act(async () => void fireEvent.click(screen.getByTitle("Clear")));
    expect((search as HTMLInputElement).value).toBe("");
    await act(async () => void fireEvent.change(search, { target: { value: "zz" } }));
    await act(async () => void fireEvent.keyDown(search, { key: "Escape" }));
    await act(async () => void fireEvent.click(screen.getByTitle("Add variable")));
    // A new row with a free name and 10 mm; cancelled, it goes.
    const addRow = () => [...document.querySelectorAll(".param-row")].find((r) => r.querySelector<HTMLInputElement>("input.expr")?.value === "10 mm");
    const suggested = addRow()!.querySelector<HTMLInputElement>("input.name-input")!.value;
    expect(Object.keys(currentDoc().params)).not.toContain(suggested);
    const cancel = [...addRow()!.querySelectorAll("button")].find((b) => !b.getAttribute("title"))!;
    await act(async () => void fireEvent.click(cancel));
    expect(addRow()).toBeUndefined();
    // The automatic a1 moves to the user's variables.
    await act(async () => void fireEvent.change(search, { target: { value: "a1" } }));
    await act(async () => void fireEvent.click(screen.getAllByTitle("Move to my variables")[0]!));
    expect(currentDoc().autoParams ?? []).not.toContain("a1");
    // Enter ends editing a name (a new name renames it).
    const name = [...document.querySelectorAll<HTMLInputElement>(".param-row input.name-input")].find((i) => i.defaultValue === "a1")!;
    await act(async () => void fireEvent.change(name, { target: { value: "a2" } }));
    await act(async () => void fireEvent.keyDown(name, { key: "Enter" }));
    await act(async () => void fireEvent.blur(name));
    expect(Object.keys(currentDoc().params)).toContain("a2");
  });
});
