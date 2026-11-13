/**
 * More drag arrows (Manipulators.tsx) in the real 3D view: a hole sized by a variable widens by
 * changing the variable, and says what it is linked to; unlinking freezes just this hole; a picked
 * sketch region is pulled up into a new part of the dragged height; editing a move shows its three
 * arrows at the moved part; a drag back to nothing cancels.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as store from "../store";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick, Viewport } from "@meercad/viewport";
import { apply, cancelDialog, currentDoc, editFeature, getViewport, newProject, rebuildNow, undo, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

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
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "c", type: "point", x: 20, y: 10 }, { id: "k", type: "circle", center: "c", radius: 4 }], constraints: [{ id: "d", type: "diameter", curve: "k", value: "hole" }] },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 30, mode: "cut" },
  { id: "sk3", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("q", 60, 0, 10, 10), constraints: [] },
];
let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const volumeOf = async (id: string) => (await rebuildNow()).report.bodies.find((b) => b.id === id)?.volume ?? NaN;
async function select(...picks: Pick[]) {
  await act(async () => useApp.setState({ selection: picks, selectedFeature: null }));
  await settle();
}
const handle = (id: string) => vp.handles.find((h) => h.id === id)!;
async function drag(id: string, to: number) {
  const h = handle(id);
  expect(h, `${id}: ${vp.handles.map((x) => x.id).join()}`).toBeDefined();
  await act(async () => h.onStart?.());
  await act(async () => h.onDrag(to));
  await act(async () => h.onEnd(to));
  await settle();
}

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "More arrows");
  apply({ type: "set_param", name: "hole", expr: "8 mm" }, { type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
});
beforeEach(() => useApp.setState({ selection: [] }));
afterAll(cleanup);

describe("more drag arrows", () => {
  const wall = (): Pick => {
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
    const face = m.faceTags.findIndex((tags) => tags.some((t) => t.startsWith("ex2.side[sk2.k]")));
    return { kind: "face", bodyId: "ex1", face, tags: m.faceTags[face]!, point: [20, 6, 5], normal: null, surface: [0, 1, 0] } as unknown as Pick;
  };

  it("widens a hole sized by a variable by changing the variable, and says so", async () => {
    await select(wall());
    expect(handle("hole").value).toBeCloseTo(4, 6);
    await drag("hole", 5);
    expect(currentDoc().params["hole"]).toMatch(/^10( mm)?$/);
    expect(await volumeOf("ex1")).toBeCloseTo(8000 - Math.PI * 25 * 10, 3);
    // Its value label offers to unlink, naming what it changes with.
    await select(wall());
    expect(document.querySelector<HTMLButtonElement>("button.unlink")!.title).toMatch(/Changes together with the variable "hole"/);
    await act(async () => undo());
    await rebuilt();
  });

  it("unlinks just this hole: its size is frozen, the variable stays", async () => {
    await select(wall());
    // The label lays itself out again with the next frame of the view; here a second pick stands in.
    await select(wall());
    const unlink = document.querySelector<HTMLButtonElement>("button.unlink");
    expect(unlink).not.toBeNull();
    await act(async () => void unlink!.click());
    const sk = currentDoc().features.find((f) => f.id === "sk2") as Extract<Feature, { op: "sketch" }>;
    expect(sk.constraints.find((c) => c.id === "d")).toMatchObject({ value: 8 });
    expect(currentDoc().params["hole"]).toBe("8 mm");
    await act(async () => undo());
    await rebuilt();
  });

  it("pulls a picked sketch region up into a new part of the dragged height", async () => {
    const out = useApp.getState().output!;
    const key = out.report.sketches.find((s) => s.id === "sk3")!.regions[0]!.key;
    await select({ kind: "region", sketchId: "sk3", key, point: [65, 5, 0] } as Pick);
    await drag("extrude", 7);
    const step = currentDoc().features.at(-1)!;
    expect(step).toMatchObject({ op: "extrude", distance: 7, profile: { sketch: "sk3", regions: [key] } });
    expect(await volumeOf(step.id)).toBeCloseTo(700, 3);
    await act(async () => undo());
    await rebuilt();
    // Dragged back to nothing: no step.
    await select({ kind: "region", sketchId: "sk3", key, point: [65, 5, 0] } as Pick);
    const before = currentDoc().features.length;
    await drag("extrude", 0);
    expect(currentDoc().features.length).toBe(before);
    expect(useApp.getState().dialog).toBeNull();
  });

  it("drags with a ghost of the profile while rebuilds are slow", async () => {
    const slow = vi.spyOn(store, "rebuildIsSlow").mockReturnValue(true);
    try {
      const out = useApp.getState().output!;
      const key = out.report.sketches.find((s) => s.id === "sk3")!.regions[0]!.key;
      await select({ kind: "region", sketchId: "sk3", key, point: [65, 5, 0] } as Pick);
      const h = handle("extrude");
      await act(async () => h.onStart?.());
      await act(async () => h.onDrag(4));
      await act(async () => h.onDrag(6));
      // A pause in the drag lets one rebuild through.
      await settle(450);
      await act(async () => h.onEnd(6));
      await settle();
      expect(currentDoc().features.at(-1)).toMatchObject({ op: "extrude", distance: 6 });
      await act(async () => undo());
      await rebuilt();
    } finally {
      slow.mockRestore();
    }
  });

  it("shows the three arrows of a move at the moved part, and drags along y", async () => {
    apply({ type: "add_features", features: [{ id: "mv1", op: "transform", bodies: ["ex1"], translate: [5, 0, 0] } as Feature] });
    await rebuilt();
    await act(async () => editFeature("mv1"));
    await settle();
    expect(["move-x", "move-y", "move-z"].every((id) => handle(id))).toBe(true);
    expect(handle("move-x").value).toBe(5);
    await act(async () => handle("move-y").onDrag(3));
    expect((useApp.getState().dialog!.feature as { translate: unknown[] }).translate).toEqual([5, 3, 0]);
    await act(async () => cancelDialog());
  });

  it("takes a typed value on an arrow's label, and ignores what is no number", async () => {
    await select(wall());
    const chip = () => [...document.querySelectorAll<HTMLButtonElement>(".handle-chip button")].find((b) => /^Ø/.test(b.textContent ?? ""))!;
    await act(async () => void fireEvent.click(chip()));
    let input = document.querySelector<HTMLInputElement>(".handle-chip input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "abc" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    expect(currentDoc().params["hole"]).toMatch(/^8( mm)?$/);
    await select(wall());
    await act(async () => void fireEvent.click(chip()));
    input = document.querySelector<HTMLInputElement>(".handle-chip input")!;
    await act(async () => void fireEvent.change(input, { target: { value: "12" } }));
    await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
    await settle();
    // The label shows the diameter: 12 typed is a 12 mm hole.
    expect(currentDoc().params["hole"]).toMatch(/^12( mm)?$/);
    await act(async () => undo());
    await rebuilt();
  });
});

