/**
 * The values shown on the model (InlineValues.tsx) for each kind of step, in the real 3D view: a
 * round's radius, a bevel's distance, a shell's wall, an offset plane, a
 * pattern's count and spacing, the sketch's sizes. A value typed into a chip changes the part to
 * the volume that follows; a value linked to a variable is unlinked to a plain number, and a sketch
 * size typed in keeps the variables the sketch already uses.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, getViewport, newProject, rebuildNow, useApp } from "../store";
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
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [{ id: "w", type: "length", line: "l1", value: "w" }, { id: "h", type: "length", line: "l2", value: 20 }, { id: "f", type: "fix", point: "p1" }, { id: "hz", type: "horizontal", line: "l1" }, { id: "vt", type: "vertical", line: "l2" }, { id: "hz2", type: "horizontal", line: "l3" }, { id: "vt2", type: "vertical", line: "l4" }] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l1]"] }], radius: 2 },
  { id: "ch1", op: "chamfer", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l3]"] }], distance: 1 },
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
];
const chips = () => [...document.querySelectorAll<HTMLButtonElement>(".value-chip button[title='Click to edit']")];
const texts = () => chips().map((c) => c.textContent ?? "");
const volume = async () => (await rebuildNow()).report.bodies[0]!.volume!;
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
}
/** The block 40 × 20 × 10 with an R r round along one 40 mm edge and a c bevel along the other. */
const block = (r: number, c: number) => 8000 - (1 - Math.PI / 4) * r * r * 40 - (c * c * 40) / 2;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Inline ops");
  apply({ type: "set_param", name: "w", expr: "40 mm" }, { type: "add_features", features: design });
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => {
    const vp = getViewport()!;
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("values on the model for each step", () => {
  it("shows a round's radius and changes it to 3 mm", async () => {
    expect(await volume()).toBeCloseTo(block(2, 1), 3);
    await show("fi1");
    expect(texts()).toContain("R 2 mm");
    await type(/^R 2/, "3");
    expect(await volume()).toBeCloseTo(block(3, 1), 3);
  });

  it("shows a bevel's distance and changes it to 2 mm", async () => {
    await show("ch1");
    expect(texts()).toContain("⌟ 1 mm");
    await type(/^⌟ 1/, "2");
    expect(await volume()).toBeCloseTo(block(3, 2), 3);
  });

  it("shows an offset plane's distance and moves it", async () => {
    await show("pl1");
    expect(texts()).toContain("⇥ 30 mm");
    await type(/^⇥ 30/, "45");
    expect(currentDoc().features.find((f) => f.id === "pl1")).toMatchObject({ offset: 45 });
  });

  it("shows the sketch's sizes with the extrusion, and keeps the variable a size uses", async () => {
    await show("ex1");
    // The width comes from the variable w; the height is a plain 20.
    expect(texts()).toEqual(expect.arrayContaining(["↕ 10 mm", "20"]));
    expect(texts().some((t) => /^w|40/.test(t))).toBe(true);
    await type(/^20$/, "25");
    const sk = currentDoc().features.find((f) => f.id === "sk1") as Extract<Feature, { op: "sketch" }>;
    expect(sk.constraints.find((c) => c.id === "h")).toMatchObject({ value: 25 });
    expect(sk.constraints.find((c) => c.id === "w")).toMatchObject({ value: "w" });
    expect(currentDoc().params["w"]).toBe("40 mm");
    expect((await rebuildNow()).report.bodies[0]!.bbox.max[1]).toBeCloseTo(25, 6);
  });

  it("unlinks a size from its variable to a plain number", async () => {
    await show("sk1");
    const unlink = document.querySelector<HTMLButtonElement>(".value-chip .unlink");
    expect(unlink).not.toBeNull();
    await act(async () => void fireEvent.click(unlink!));
    const sk = currentDoc().features.find((f) => f.id === "sk1") as Extract<Feature, { op: "sketch" }>;
    expect(String((sk.constraints.find((c) => c.id === "w") as { value: unknown }).value)).toMatch(/^40( mm)?$/);
  });

  it("shows a shell's wall and a pattern's count and spacing", async () => {
    apply({
      type: "add_features",
      features: [
        // Open at the bottom: the top's rounded and bevelled edges would stop a shell open there.
        { id: "sh1", op: "shell", faces: [{ face: "ex1.start_cap" }], thickness: 2 } as Feature,
        { id: "lp1", op: "linear_pattern", source: { bodies: ["ex1"] }, direction: { ref: "origin.X" }, count: 2, spacing: 60 } as Feature,
      ],
    });
    await show("sh1");
    expect(texts()).toContain("▭ 2 mm");
    await show("lp1");
    expect(texts()).toEqual(expect.arrayContaining(["× 2", "↔ 60 mm"]));
    await type(/^× 2/, "3");
    await rebuilt();
    expect(useApp.getState().output!.report.bodies).toHaveLength(3);
  });
});
