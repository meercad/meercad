/**
 * Linking values of several steps (FeatureTree.tsx LinkBar) and dragging in the side panel, with
 * the real kernel: two extrusions of 10 mm picked together share a new variable of 10 mm and the
 * parts keep their size, then follow it together; values that differ say so; a bad or taken name is
 * refused; steps of different kinds are not linked. The roll-back bar dragged up builds less; a part
 * dragged onto a group goes into it.
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, useApp } from "../store";
import { answer, renderUi } from "../../test/ui";
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
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("a", 0, 0, 10, 10),
    constraints: [],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("b", 20, 0, 10, 10),
    constraints: [],
  },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk3",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: rect("c", 40, 0, 10, 10),
    constraints: [],
  },
  { id: "ex3", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 12, mode: "new_body" },
];
const rebuilt = () => act(async () => void (await rebuildNow()));
const row = (label: string) =>
  [...document.querySelectorAll<HTMLElement>("li > div.tree-item")].find((el) =>
    el.textContent?.includes(label),
  )!;

const pick = async (...labels: string[]) => {
  await act(async () => void fireEvent.click(row(labels[0]!)));
  for (const l of labels.slice(1)) await act(async () => void fireEvent.click(row(l), { metaKey: true }));
};

const heights = async () =>
  (await rebuildNow()).report.bodies.map((b) => +(b.bbox.max[2]! - b.bbox.min[2]!).toFixed(6));
const lastToast = () => useApp.getState().toasts.at(-1)?.text ?? "";

beforeAll(async () => {
  await newProject(undefined, "Linking");
  apply({ type: "add_features", features: design });
  await rebuildNow();
});
afterEach(cleanup);

describe("linking values of several steps", () => {
  it("shares a new variable between two extrusions of 10 mm, and they follow it", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    await pick("Extrude 1", "Extrude 2");
    expect(document.querySelector(".link-bar")!.textContent).toMatch(/2 extrudes picked/);
    await act(
      async () => void fireEvent.click(screen.getByText(/^Link distance \(10 mm\) with a variable…$/)),
    );
    await answer("depth");
    expect(currentDoc().params["depth"]).toBe("10 mm");
    expect(
      currentDoc()
        .features.filter((f) => f.op === "extrude")
        .map((f) => (f as { distance: unknown }).distance),
    ).toEqual(["depth", "depth", 12]);
    expect(lastToast()).toMatch(/2 extrudes now share "depth"/);
    expect(await heights()).toEqual([10, 10, 12]);
    apply({ type: "set_param", name: "depth", expr: "7 mm" });
    expect(await heights()).toEqual([7, 7, 12]);
    // Linked now: the bar says so.
    await pick("Extrude 1", "Extrude 2");
    expect(document.querySelector(".link-bar")!.textContent).toMatch(/distance: linked to\s*depth/);
  });

  it("says when values differ, refuses bad or taken names, and does not mix kinds", async () => {
    renderUi(<SidePanel />);
    await rebuilt();
    await pick("Extrude 2", "Extrude 3");
    expect(document.querySelector(".link-bar")!.textContent).toMatch(/distance: values differ/);
    await pick("Extrude 1", "Sketch 1");
    expect(document.querySelector(".link-bar")!.textContent).toMatch(
      /2 features picked · pick features of one kind/,
    );
    apply(
      { type: "edit_feature", id: "ex3", patch: { distance: "depth" } },
      { type: "edit_feature", id: "ex2", patch: { distance: 7 } },
    );
    await rebuilt();
    await pick("Extrude 2", "Extrude 3");
    await act(async () => void fireEvent.click(screen.getByText(/^Link distance \(7 mm\)/)));
    await answer("2bad");
    expect(lastToast()).toMatch(/Use letters, digits and _/);
    await act(async () => void fireEvent.click(screen.getByText(/^Link distance \(7 mm\)/)));
    await answer("depth");
    expect(lastToast()).toBe('"depth" already exists');
  });
});

describe("dragging in the side panel", () => {
  it("rolls the model back by dragging the bar up, and forward again", async () => {
    renderUi(<SidePanel />);
    await rebuilt();

    const bar = document.querySelector<HTMLElement>(".rollback-bar")!;
    await act(async () => void fireEvent.dragStart(bar));

    // Dropped on step 3 (Sketch 2): the model ends after Extrude 1.
    const sketch2 = [...document.querySelectorAll<HTMLElement>("ul.tree > li")].find((li) =>
      li.querySelector("div.tree-item")?.textContent?.includes("Sketch 2"),
    )!;
    await act(async () => void fireEvent.drop(sketch2));
    expect(currentDoc().rollback).toBe("ex1");
    expect((await rebuildNow()).report.bodies.map((b) => b.id)).toEqual(["ex1"]);
    await act(async () => void fireEvent.dragStart(document.querySelector<HTMLElement>(".rollback-bar")!));

    // The empty row at the end of the steps.
    const last = sketch2.parentElement!.lastElementChild as HTMLElement;
    await act(async () => void fireEvent.drop(last));
    expect(currentDoc().rollback ?? null).toBeNull();
  });

  it("puts a part dragged onto a group into it", async () => {
    apply({ type: "replace", doc: { ...currentDoc(), partGroups: [{ name: "Left", parts: [] }] } });
    renderUi(<SidePanel />);
    await rebuilt();

    const part = [...document.querySelectorAll<HTMLElement>("li.tree-item")].find(
      (el) => /10 × 10 × 7/.test(el.getAttribute("title") ?? "") || /Extrude 1/.test(el.textContent ?? ""),
    )!;
    await act(async () => void fireEvent.dragStart(part));

    const group = [...document.querySelectorAll<HTMLElement>(".group-row")].find((el) =>
      el.textContent?.includes("Left"),
    )!;
    await act(async () => void fireEvent.dragOver(group));
    await act(async () => void fireEvent.drop(group));
    expect(currentDoc().partGroups![0]!.parts.length).toBe(1);
  });
});
