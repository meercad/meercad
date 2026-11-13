/**
 * The side panel's menus and buttons (FeatureTree.tsx), each entry run once: a step's menu (edit,
 * hide its sketch, delete), its keys (Enter edits, Delete deletes) and double click; a part's menu
 * (new group, copy, duplicate, paste, a Gridfinity bin for it, material, delete) and buttons (hide,
 * material, delete); a group's menu (rename, hide all and show all) and folding. The parts: a
 * 40 × 20 × 10 block and a 10 × 10 × 20 post.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, cancelDialog, closeSketch, currentDoc, newProject, rebuildNow, undo, useApp } from "../store";
import { answer, contextMenu, pickMenu, renderUi } from "../../test/ui";
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
const partRow = (title: RegExp) => [...document.querySelectorAll("li.tree-item")].find((el) => title.test(el.getAttribute("title") ?? ""))!;
const stepRow = (label: string) => [...document.querySelectorAll("div.tree-item")].find((el) => el.querySelector(".tree-label")?.textContent === label)!;
const bodies = async () => (await rebuildNow()).report.bodies.map((b) => b.id).sort();
const POST = /10 × 10 × 20/;

beforeEach(async () => {
  await newProject(undefined, "Panel menus");
  apply({ type: "add_features", features: design });
  await rebuildNow();
  renderUi(<SidePanel />);
  await rebuilt();
});
afterEach(async () => {
  await act(async () => cancelDialog());
  if (useApp.getState().sketchId) await act(async () => closeSketch());
  cleanup();
});

describe("a step's menu and keys", () => {
  it("edits by menu, Enter and double click; hides a sketch; deletes by menu and key", async () => {
    await contextMenu(stepRow("Extrude 1"));
    await pickMenu("Edit");
    expect(useApp.getState().dialog?.feature.id).toBe("ex1");
    await act(async () => cancelDialog());
    await act(async () => void fireEvent.keyDown(stepRow("Extrude 1"), { key: "Enter" }));
    expect(useApp.getState().dialog?.feature.id).toBe("ex1");
    await act(async () => cancelDialog());
    await act(async () => void fireEvent.doubleClick(stepRow("Extrude 2")));
    expect(useApp.getState().dialog?.feature.id).toBe("ex2");
    await act(async () => cancelDialog());
    await contextMenu(stepRow("Sketch 2"));
    await pickMenu("Hide sketch");
    expect(useApp.getState().hidden.has("sk2")).toBe(true);
    // The step's own eye shows it again; its pencil opens it.
    await act(async () => void fireEvent.click(stepRow("Sketch 2").querySelector("button[title=Show]")!));
    expect(useApp.getState().hidden.has("sk2")).toBe(false);
    await act(async () => void fireEvent.click(stepRow("Extrude 2").querySelector("button[title=Edit]")!));
    expect(useApp.getState().dialog?.feature.id).toBe("ex2");
    await act(async () => cancelDialog());
    await act(async () => void fireEvent.keyDown(stepRow("Extrude 2"), { key: "Delete" }));
    await rebuilt();
    expect(currentDoc().features.some((f) => f.id === "ex2")).toBe(false);
    await act(async () => void undo());
    await rebuilt();
    await contextMenu(stepRow("Extrude 2"));
    await pickMenu("Delete");
    await rebuilt();
    expect(currentDoc().features.some((f) => f.id === "ex2")).toBe(false);
  });
});

describe("a part's menu and buttons", () => {
  it("groups, copies, duplicates and pastes", async () => {
    await contextMenu(partRow(POST));
    await pickMenu("New group with this part");
    await answer("Posts");
    await rebuilt();
    expect(currentDoc().partGroups?.find((g) => g.name === "Posts")?.parts).toEqual(["ex2"]);
    await contextMenu(partRow(POST));
    await pickMenu("Duplicate");
    await rebuilt();
    expect((await bodies()).length).toBe(3);
    await contextMenu(partRow(/40 × 20 × 10/));
    await pickMenu("Copy");
    await contextMenu(partRow(/40 × 20 × 10/));
    await pickMenu("Paste");
    await rebuilt();
    expect((await bodies()).length).toBe(4);
  });

  it("makes a bin for it, picks its material, hides and deletes it", async () => {
    await contextMenu(partRow(POST));
    await pickMenu("Gridfinity bin for this part");
    expect(useApp.getState().dialog?.feature.op).toBe("gridfinity");
    await act(async () => cancelDialog());
    const asked: unknown[] = [];
    const on = (e: Event) => void asked.push((e as CustomEvent).detail);
    window.addEventListener("meercad:materials", on);
    await contextMenu(partRow(POST));
    await pickMenu("Material…");
    window.removeEventListener("meercad:materials", on);
    expect(asked).toEqual([["ex2"]]);
    await act(async () => void fireEvent.click(partRow(POST).querySelector("button[title=Hide]")!));
    expect(useApp.getState().hidden.has("ex2")).toBe(true);
    await act(async () => void fireEvent.click(partRow(POST).querySelector("button[title=Show]")!));
    expect(useApp.getState().hidden.has("ex2")).toBe(false);
    await act(async () => void fireEvent.click(partRow(POST).querySelector("button[title='Delete part']")!));
    await rebuilt();
    expect(await bodies()).toEqual(["ex1"]);
    await act(async () => void undo());
    await rebuilt();
    await contextMenu(partRow(POST));
    await pickMenu("Delete part");
    await rebuilt();
    expect(await bodies()).toEqual(["ex1"]);
  });
});

describe("a group", () => {
  it("is renamed, hidden and shown whole, and folds", async () => {
    apply({ type: "set_part_list", groups: [{ name: "Posts", parts: ["ex2"] }] });
    await rebuilt();
    const groupRow = () => [...document.querySelectorAll("div.group-row")].find((el) => el.textContent?.includes(useApp.getState().doc.partGroups?.[0]?.name ?? "?"))!;
    await contextMenu(groupRow());
    await pickMenu("Rename");
    await answer("Pillars");
    expect(currentDoc().partGroups?.[0]?.name).toBe("Pillars");
    await contextMenu(groupRow());
    await pickMenu("Hide all");
    expect(useApp.getState().hidden.has("ex2")).toBe(true);
    await contextMenu(groupRow());
    await pickMenu("Show all");
    expect(useApp.getState().hidden.has("ex2")).toBe(false);
    // Folded, its parts are not listed; unfolded again, they are.
    await act(async () => void fireEvent.click(groupRow()));
    expect(partRow(POST)).toBeUndefined();
    await act(async () => void fireEvent.click(groupRow()));
    expect(partRow(POST)).toBeDefined();
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0);
  });
});
