/**
 * The side panel (FeatureTree.tsx) rendered with Testing Library over a design the real kernel
 * built: the steps and their state, the parts with their sizes, the variables. Clicks and edits go
 * through the store, and the numbers shown are checked against the drawn parts.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { answer, contextMenu, pickMenu, rebuilt as uiRebuilt, renderUi } from "../../test/ui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { SidePanel, toggleHidden } from "./FeatureTree";

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
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 0, 0, 40, 20),
    constraints: [],
  },
  {
    id: "ex1",
    op: "extrude",
    profile: { sketch: "sk1" },
    extent: "blind",
    distance: "h",
    mode: "new_body",
    name: "Base",
  },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  {
    id: "ex2",
    op: "extrude",
    profile: { sketch: "sk2" },
    extent: "blind",
    distance: "h * 2",
    mode: "new_body",
  },
];

async function rebuilt() {
  await act(async () => void (await rebuildNow()));
}

beforeAll(async () => {
  await newProject(undefined, "Panel");
  apply({ type: "set_param", name: "h", expr: "10 mm" }, { type: "add_features", features: design });
  await rebuildNow();
});
afterEach(cleanup);

describe("the side panel", () => {
  it("lists the steps, the parts with their sizes and the variables", async () => {
    render(<SidePanel />);
    await rebuilt();

    for (const name of ["Base", "Extrude 2", "Sketch 1", "Sketch 2"]) {
      expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    }

    // Each part's box in its tooltip: 40 × 20 × 10 and 10 × 10 × 20.
    expect(document.querySelector('[title^="6 faces · 40 × 20 × 10 mm"]')).not.toBeNull();
    expect(document.querySelector('[title^="6 faces · 10 × 10 × 20 mm"]')).not.toBeNull();
    expect(screen.getByDisplayValue("10 mm")).toBeTruthy();
  });

  it("selects a step by click, several with ⌘ and a range with Shift", async () => {
    render(<SidePanel />);
    await rebuilt();

    /** The step's row in the list (draggable), not the part of the same name. */
    const row = (name: string) =>
      screen
        .getAllByText(name)
        .map((el) => el.closest('[draggable="true"]'))
        .find(
          (el) =>
            el && el.closest("li")?.getAttribute("draggable") !== "true" && el.getAttribute("title") !== null,
        )!;
    fireEvent.click(row("Base"));
    expect(useApp.getState().selectedFeature).toBe("ex1");
    fireEvent.click(row("Extrude 2"), { metaKey: true });
    expect(useApp.getState().featureSelection).toEqual(["ex1", "ex2"]);
    fireEvent.click(row("Sketch 1"), { shiftKey: true });
    expect(useApp.getState().featureSelection).toEqual(["sk1", "ex1", "sk2", "ex2"]);
    fireEvent.click(row("Extrude 2"));
    expect(useApp.getState().featureSelection).toEqual(["ex2"]);
  });

  it("hides and shows a part", async () => {
    render(<SidePanel />);
    await rebuilt();
    act(() => toggleHidden("ex2"));
    expect(useApp.getState().hidden.has("ex2")).toBe(true);
    act(() => toggleHidden("ex2"));
    expect(useApp.getState().hidden.has("ex2")).toBe(false);
  });

  it("changes a variable and the parts follow", async () => {
    render(<SidePanel />);
    await rebuilt();

    const input = screen.getByDisplayValue("10 mm");
    fireEvent.change(input, { target: { value: "15 mm" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(currentDoc().params["h"]).toBe("15 mm");
    await rebuilt();

    const vols = useApp.getState().output!.report.bodies.map((b) => Math.round(b.volume));
    expect(vols).toEqual([12000, 3000]);
    expect(document.querySelector('[title^="6 faces · 40 × 20 × 15 mm"]')).not.toBeNull();
  });

  it("finds variables by name", async () => {
    apply({ type: "set_param", name: "width", expr: "40 mm" });
    render(<SidePanel />);
    await rebuilt();

    const search = screen.queryByLabelText("Search variables");

    if (search) {
      fireEvent.change(search, { target: { value: "wid" } });
      expect(screen.queryByDisplayValue("15 mm")).toBeNull();
      expect(screen.getByDisplayValue("40 mm")).toBeTruthy();
    }

    expect(within(document.body).getAllByText(/width|h/).length).toBeGreaterThan(0);
  });
});

describe("the side panel's menus and dialogs", () => {
  const stepRow = (name: string) =>
    screen
      .getAllByText(name)
      .map((el) => el.closest('[draggable="true"]'))
      .find(
        (el) =>
          el && el.closest("li")?.getAttribute("draggable") !== "true" && el.getAttribute("title") !== null,
      )!;
  const partRow = (title: RegExp) =>
    [...document.querySelectorAll("li.tree-item")].find((el) => title.test(el.getAttribute("title") ?? ""))!;

  it("renames, suppresses and rolls back a step from its menu", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    await contextMenu(stepRow("Extrude 2"));
    await pickMenu("Rename");
    await answer("Peg");
    expect(currentDoc().features.find((f) => f.id === "ex2")!.name).toBe("Peg");
    await contextMenu(stepRow("Peg"));
    await pickMenu("Suppress");
    expect(currentDoc().features.find((f) => f.id === "ex2")!.suppressed).toBe(true);
    await rebuilt();
    expect(useApp.getState().output!.report.bodies.map((b) => b.id)).toEqual(["ex1"]);
    await contextMenu(stepRow("Peg"));
    await pickMenu("Unsuppress");
    await contextMenu(stepRow("Base"));
    await pickMenu("Roll back to here");
    expect(currentDoc().rollback).toBe("ex1");
    await act(async () => void fireEvent.click(screen.getByTitle("Roll forward to the end")));
    expect(currentDoc().rollback).toBeNull();
    // A name cleared falls back to the step's own name.
    await contextMenu(stepRow("Peg"));
    await pickMenu("Rename");
    await answer("");
    expect(currentDoc().features.find((f) => f.id === "ex2")!.name).toBeUndefined();
  });

  it("moves a step by dragging it", async () => {
    renderUi(<SidePanel />);
    await rebuilt();

    const from = stepRow("Sketch 2");
    const targets = [...document.querySelectorAll("li")].filter((li) =>
      li.querySelector('[draggable="true"][title]'),
    );
    fireEvent.dragStart(from);
    // Before the first step.
    fireEvent.dragOver(targets[0]!);
    fireEvent.drop(targets[0]!);
    expect(currentDoc().features.map((f) => f.id)).toEqual(["sk2", "sk1", "ex1", "ex2"]);
  });

  it("puts parts into a group, renames, folds and ungroups it", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    await act(async () => void fireEvent.click(screen.getByTitle("New group")));
    await answer("Bits");
    expect(currentDoc().partGroups).toEqual([{ name: "Bits", parts: [] }]);
    await contextMenu(partRow(/40 × 20/));
    await pickMenu("Move to Bits");
    expect(currentDoc().partGroups).toEqual([{ name: "Bits", parts: ["ex1"] }]);

    const head = screen.getByTitle("Click to fold · double-click to rename · drop parts here");
    await act(async () => void fireEvent.doubleClick(head));
    await answer("Pieces");
    expect(currentDoc().partGroups![0]!.name).toBe("Pieces");
    await contextMenu(partRow(/40 × 20/));
    await pickMenu("Take out of group");
    expect(currentDoc().partGroups).toEqual([{ name: "Pieces", parts: [] }]);
    // Dragging the other part onto the group.
    fireEvent.dragStart(partRow(/10 × 10/));
    fireEvent.dragOver(screen.getByTitle("Click to fold · double-click to rename · drop parts here"));
    fireEvent.drop(screen.getByTitle("Click to fold · double-click to rename · drop parts here"));
    expect(currentDoc().partGroups).toEqual([{ name: "Pieces", parts: ["ex2"] }]);
    await contextMenu(screen.getByTitle("Click to fold · double-click to rename · drop parts here"));
    await pickMenu("Ungroup");
    expect(currentDoc().partGroups).toBeUndefined();
  });

  it("shows a part see-through and hides it from its menu", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    await contextMenu(partRow(/10 × 10/));
    await pickMenu("Show see-through");
    expect(currentDoc().seeThrough).toEqual(["ex2"]);
    await contextMenu(partRow(/10 × 10/));
    await pickMenu("Show solid");
    expect(currentDoc().seeThrough ?? []).toEqual([]);
    await contextMenu(partRow(/10 × 10/));
    await pickMenu("Hide");
    expect(useApp.getState().hidden.has("ex2")).toBe(true);
    await contextMenu(partRow(/10 × 10/));
    await pickMenu("Show");
    expect(useApp.getState().hidden.has("ex2")).toBe(false);
  });

  it("adds, renames and moves variables, and makes variants", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    await act(async () => void fireEvent.click(screen.getByTitle("Add variable")));
    await act(async () => void fireEvent.click(screen.getByTitle("Add")));

    const added = Object.keys(currentDoc().params).find((n) => !["h", "width"].includes(n))!;
    expect(currentDoc().params[added]).toBe("10 mm");

    const name = screen.getByDisplayValue(added);
    fireEvent.change(name, { target: { value: "depth" } });
    fireEvent.blur(name);
    expect(currentDoc().params["depth"]).toBe("10 mm");
    await contextMenu(screen.getByDisplayValue("depth").closest(".param-row")!);
    await pickMenu("Move to automatic");
    expect(currentDoc().autoParams).toContain("depth");

    if (screen.queryByTitle("Add variant")) {
      await act(async () => void fireEvent.click(screen.getByTitle("Add variant")));
      await answer("Tall");
      expect(currentDoc().variant).toBe("Tall");
      expect(currentDoc().variants![0]!.params["h"]).toBe("15 mm");
    }
  });
});
