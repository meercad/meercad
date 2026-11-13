/**
 * More of the side panel (FeatureTree.tsx): a part's colour picked, kept and reset; a part larger
 * than the print bed says by how much, in the design's unit; sections fold and stay folded; the
 * surroundings (an area from photos) are renamed, hidden and deleted; a step others use is deleted
 * together with them once confirmed. The parts: a 40 × 20 × 10 block and a 10 × 10 × 20 post.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { usePrefs } from "../lib/keymap";
import { answer, contextMenu, pickMenu, renderUi } from "../../test/ui";
import { deleteFeature, SidePanel } from "./FeatureTree";

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
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 60, 0, 10, 10),
    constraints: [],
  },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 20, mode: "new_body" },
];
const rebuilt = () => act(async () => void (await rebuildNow()));
const partRow = (title: RegExp) =>
  [...document.querySelectorAll("li.tree-item")].find((el) => title.test(el.getAttribute("title") ?? ""))!;
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";

beforeAll(async () => {
  await newProject(undefined, "Panel more");
  apply({ type: "add_features", features: design });
  await rebuildNow();
});
afterEach(cleanup);

describe("parts in the side panel", () => {
  it("picks a part's colour, keeps it in the design and resets it", async () => {
    renderUi(<SidePanel />);
    await rebuilt();

    // The browser's colour picker: the test answers it at once.
    const make = document.createElement.bind(document);

    const spy = (tag: string) => {
      const el = make(tag);

      if (tag === "input") {
        (el as HTMLInputElement).click = () => {
          (el as HTMLInputElement).value = "#123456";
          el.dispatchEvent(new Event("change"));
        };
      }

      return el;
    };

    document.createElement = spy as typeof document.createElement;

    try {
      await contextMenu(partRow(/10 × 10/));
      await pickMenu("Colour…");
    } finally {
      document.createElement = make as typeof document.createElement;
    }

    expect(currentDoc().partColors).toEqual({ ex2: "#123456" });
    await act(async () => void fireEvent.click(partRow(/10 × 10/).querySelector(".part-swatch")!));
    await pickMenu("Reset colour");
    expect(currentDoc().partColors).toBeUndefined();
  });

  it("warns of a part larger than the print bed, with both sizes", async () => {
    const bed = usePrefs.getState().printBed;
    usePrefs.setState({ printBed: [30, 30, 30] as never });

    try {
      renderUi(<SidePanel />);
      await rebuilt();

      const warn = partRow(/40 × 20/).querySelector(".too-big") as HTMLElement;
      expect(warn).toBeTruthy();
      expect(partRow(/10 × 10/).querySelector(".too-big")).toBeNull();
      await act(async () => void fireEvent.click(warn));
      expect(lastToast()).toMatch(/is 40 × 20 × 10 mm, larger than the print bed \(30 × 30 × 30 mm\)/);
    } finally {
      usePrefs.setState({ printBed: bed });
    }
  });

  it("folds a section and keeps it folded", async () => {
    renderUi(<SidePanel />);
    await rebuilt();

    const head = screen
      .getAllByRole("button")
      .find((b) => b.classList.contains("section-toggle") && /Parts/.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(head));
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(localStorage.getItem("meercad.sections")).toMatch(/"parts":false/);
    cleanup();
    renderUi(<SidePanel />);

    const again = screen
      .getAllByRole("button")
      .find((b) => b.classList.contains("section-toggle") && /Parts/.test(b.textContent ?? ""))!;
    expect(again.getAttribute("aria-expanded")).toBe("false");
    await act(async () => void fireEvent.click(again));
  });
});

describe("surroundings and steps", () => {
  it("renames, hides and deletes an area from photos", async () => {
    expect(
      apply({
        type: "set_reference",
        reference: {
          id: "rf1",
          name: "Garden",
          format: "glb",
          data: "AAAA",
          geo: { lat: 52.5, lon: 13.4, alt: 30 },
          marks: [{ id: "m1", kind: "note", points: [[0, 0, 0]], text: "Tree", color: "#ff0000" }],
        } as never,
      }),
    ).toBe(true);
    renderUi(<SidePanel />);

    const row = () =>
      [...document.querySelectorAll("li.tree-item")].find((el) => /Garden|Lawn/.test(el.textContent ?? ""))!;
    expect(row().textContent).toMatch(/Garden · 1 mark/);
    expect(row().getAttribute("title")).toBe("Placed by GPS at 52.500000, 13.400000");
    await contextMenu(row());
    await pickMenu("Rename…");
    await answer("Lawn");
    expect(currentDoc().references![0]!.name).toBe("Lawn");
    await act(async () => void fireEvent.click(row().querySelector('button[title="Hide"]')!));
    expect(currentDoc().references![0]!.hidden).toBe(true);
    await contextMenu(row());
    await pickMenu("Show");
    expect(currentDoc().references![0]!.hidden).toBeUndefined();
    await contextMenu(row());
    await pickMenu("Delete");
    expect(currentDoc().references ?? []).toEqual([]);
  });

  it("deletes a step with the steps that use it, once confirmed, and keeps them on No", async () => {
    renderUi(<SidePanel />);

    const sketch = currentDoc().features.find((f) => f.id === "sk2")!;
    const deleting = deleteFeature(sketch);
    await answer(null);
    await act(async () => deleting);
    expect(currentDoc().features.map((f) => f.id)).toContain("ex2");

    const again = deleteFeature(currentDoc().features.find((f) => f.id === "sk2")!);
    await answer();
    await act(async () => again);
    expect(currentDoc().features.map((f) => f.id)).toEqual(["sk1", "ex1"]);
    expect(lastToast()).toMatch(/^Deleted/);
  });
});
