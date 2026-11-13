/**
 * Values shown at more kinds of steps in the 3D view (InlineValues.tsx), each typed over and checked
 * in the rebuilt part: a bend's angle, a wrap's radius and a spiral's gap; a wall holder's cells; a
 * label's width; a Gridfinity bin's cells and height (a bin round a part has none); and a value that
 * is no expression shows as the step's error.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, getViewport, newProject, rebuildNow, useApp } from "../store";
import { rebuilt, renderUi, withScreen } from "../../test/ui";
import { ViewportView } from "./ViewportView";

const rect = (w: number, h: number): SketchEntity[] => [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: w, y: 0 },
  { id: "p3", type: "point", x: w, y: h },
  { id: "p4", type: "point", x: 0, y: h },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const chips = () => [...document.querySelectorAll<HTMLButtonElement>(".value-chip button[title='Click to edit']")];
const texts = () => chips().map((c) => c.textContent ?? "");
async function show(id: string) {
  await rebuilt();
  await act(async () => useApp.setState({ selectedFeature: id, selection: [] }));
  await act(async () => new Promise((r) => setTimeout(r, 30)));
}
async function type(chipText: RegExp, value: string) {
  const chip = chips().find((c) => chipText.test(c.textContent ?? ""));
  expect(chip, `${chipText} in ${texts().join(" | ")}`).toBeDefined();
  await act(async () => void fireEvent.click(chip!));
  const input = document.querySelector<HTMLInputElement>(".value-chip input")!;
  await act(async () => void fireEvent.change(input, { target: { value } }));
  await act(async () => void fireEvent.keyDown(input, { key: "Enter" }));
  await rebuilt();
}
const feature = <T,>(id: string) => currentDoc().features.find((f) => f.id === id) as T;
const bbox = async (id: string) => (await rebuildNow()).report.bodies.find((b) => b.id === id)!.bbox;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Inline kinds");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect(60, 10), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 2, mode: "new_body" },
  ] as Feature[] });
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => {
    const vp = getViewport()!;
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("values at more kinds of steps", () => {
  it("a bend's angle, then as a wrap its radius, then as a spiral its gap", async () => {
    apply({ type: "add_features", features: [{ id: "bd1", op: "bend", mode: "bend", bodies: ["ex1"], axis: { ref: "origin.Y" }, angle: 90 } as Feature] });
    await show("bd1");
    await type(/^∠/, "120");
    expect(feature<{ angle: unknown }>("bd1").angle).toBe(120);
    apply({ type: "edit_feature", id: "bd1", patch: { mode: "wrap", angle: undefined, radius: 15 } } as never);
    await show("bd1");
    await type(/^R /, "20");
    expect(feature<{ radius: unknown }>("bd1").radius).toBe(20);
    apply({ type: "edit_feature", id: "bd1", patch: { mode: "spiral", radius: 8, gap: 1 } } as never);
    await show("bd1");
    expect(texts().some((x) => /^↔/.test(x))).toBe(true);
    await type(/^↔/, "2");
    expect(feature<{ gap: unknown }>("bd1").gap).toBe(2);
    apply({ type: "delete_feature", id: "bd1" } as never);
  });

  it("a wall holder's cells and a label's width", async () => {
    apply({ type: "add_features", features: [
      { id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [2, 2] },
      { id: "lb1", op: "label", text: "M3", width: 30, height: 10 },
    ] as Feature[] });
    await show("wl1");
    await type(/^▦ 2/, "3");
    expect(feature<{ units: unknown[] }>("wl1").units[0]).toBe(3);
    const b = await bbox("wl1");
    // openGrid cells are 28 mm.
    expect(b.max[0] - b.min[0]).toBeCloseTo(3 * 28, 0);
    await show("lb1");
    await type(/^↔ 30/, "40");
    expect(feature<{ width: unknown }>("lb1").width).toBe(40);
    expect((await bbox("lb1")).max[0] - (await bbox("lb1")).min[0]).toBeCloseTo(40, 3);
  });

  it("a bin's cells and height, none for a bin round a part, and a value that is no expression shows as the step's error", async () => {
    apply({ type: "add_features", features: [
      { id: "gf1", op: "gridfinity", kind: "bin", units: [1, 1], height: 3 } as Feature,
      { id: "gf2", op: "gridfinity", kind: "bin", pocket: { body: "ex1" } } as Feature,
    ] });
    await show("gf1");
    await type(/^↕ 3/, "5");
    // It is taken as written; the step then says what is wrong with it, and undo brings 5 back.
    const st = (await rebuildNow()).report.features.find((f) => f.id === "gf1")!;
    expect(st.status).toBe("error");
    const { undo } = await import("../store");
    await act(async () => undo());
    expect(feature<{ height: unknown }>("gf1").height).toBe(5);
    // Height 5 units: 35 mm plus the lip (4.4 mm).
    expect((await bbox("gf1")).max[2]).toBeCloseTo(35 + 4.4, 3);
    await show("gf2");
    expect(texts().filter((x) => /^▦/.test(x))).toEqual([]);
    await show("gf1");
    await type(/^↕ 5/, "nope +");
    // It is taken as written; the step then says what is wrong with it, and undo brings 5 back.
    const st = (await rebuildNow()).report.features.find((f) => f.id === "gf1")!;
    expect(st.status).toBe("error");
    const { undo } = await import("../store");
    await act(async () => undo());
    expect(feature<{ height: unknown }>("gf1").height).toBe(5);
  });
});
