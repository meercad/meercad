/**
 * Own materials in the material picker (MaterialPicker.tsx): a new one from the tile, its colour set,
 * cancelled; one made and used, edited with a density, deleted; another material looked at and
 * used; the close button and a press beside the picker close it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow } from "../store";
import { renderUi } from "../../test/ui";
import { MaterialPicker, openMaterialPicker } from "./MaterialPicker";

const rect: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 20, y: 0 },
  { id: "p3", type: "point", x: 20, y: 20 },
  { id: "p4", type: "point", x: 0, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const settle = () => act(async () => new Promise((r) => setTimeout(r, 30)));
const click = (el: Element) => act(async () => void fireEvent.click(el));
const button = (text: string | RegExp) => screen.getAllByRole("button").find((b) => (typeof text === "string" ? b.textContent?.trim() === text : text.test(b.textContent ?? "")))!;

beforeAll(async () => {
  await newProject(undefined, "Own materials");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  ] as Feature[] });
  await rebuildNow();
  renderUi(<MaterialPicker />);
  await act(async () => openMaterialPicker(["ex1"]));
  await settle();
});
afterAll(cleanup);

describe("own materials", () => {
  it("starts one from the tile, sets its colour, and cancels", async () => {
    await click(button(/^New material/));
    const color = document.querySelector<HTMLInputElement>(".mat-form input[type=color]")!;
    await act(async () => void fireEvent.change(color, { target: { value: "#ff8800" } }));
    expect(document.querySelector(".mat-form code")!.textContent).toBe("#FF8800");
    await click(button("Cancel"));
    expect(document.querySelector(".mat-form")).toBeNull();
  });

  it("makes one and uses it, edits it, and deletes it", async () => {
    await click(button(/^New material/));
    const name = document.querySelector<HTMLInputElement>(".mat-form input.field")!;
    await act(async () => void fireEvent.change(name, { target: { value: "Shop PLA" } }));
    await click(button("Create and use"));
    const own = currentDoc().materials!.find((m) => m.name === "Shop PLA")!;
    expect(currentDoc().partMaterials?.["ex1"]).toBe(own.id);
    await click(button("Edit"));
    const density = document.querySelector<HTMLInputElement>(".mat-form input[inputmode=decimal]")!;
    await act(async () => void fireEvent.change(density, { target: { value: "1,3" } }));
    await click(button("Save"));
    expect(currentDoc().materials!.find((m) => m.id === own.id)!.density).toBe(1.3);
    await click(button("Delete"));
    expect(currentDoc().materials ?? []).toEqual([]);
  });

  it("looks at another material and uses it", async () => {
    await click(button(/PETG/));
    await click(button(/ABS/));
    // Clicking a tile uses it at once; looking at another one after that offers "Use".
    expect(currentDoc().partMaterials?.["ex1"]).toBe("abs");
    await click(button("Own material from this"));
    await click(button("Cancel"));
    expect(screen.queryByText("Use")).toBeNull();
  });

  it("closes by its button and by a press beside it", async () => {
    await act(async () => void fireEvent.pointerDown(screen.getByRole("dialog")));
    expect(screen.queryByRole("dialog")).not.toBeNull();
    await click(screen.getByTitle("Close (Esc)"));
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => openMaterialPicker(["ex1"]));
    await act(async () => void fireEvent.pointerDown(document.querySelector(".modal-backdrop")!));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
