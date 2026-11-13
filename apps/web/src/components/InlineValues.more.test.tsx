/**
 * More of the values on the model (InlineValues.tsx): a number typed over a value that is a
 * variable changes the variable (in its unit), so everything using it follows; an expression typed
 * there replaces the link; a picked side face of an extrusion narrows the sketch sizes to the shape
 * it came from; a box and a Gridfinity bin show their sizes, and a typed one changes the part.
 */
import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import {
  apply,
  cancelDialog,
  commitDialog,
  currentDoc,
  getViewport,
  newProject,
  rebuildNow,
  startFeature,
  useApp,
} from "../store";
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
// Two blocks from one sketch: 40 wide (a length 40) and 10 wide (a length "w").
const design: Feature[] = [
  {
    id: "sk1",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [...rect("a", 0, 0, 40, 20), ...rect("b", 60, 0, 10, 10)],
    constraints: [
      { id: "c1", type: "length", line: "aa", value: 40 },
      { id: "c2", type: "length", line: "ba", value: "w" },
    ],
  },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
];
const chips = () => [
  ...document.querySelectorAll<HTMLButtonElement>(".value-chip button[title='Click to edit']"),
];
const texts = () => chips().map((c) => c.textContent ?? "");

async function show(id: string, selection: Pick[] = []) {
  await rebuilt();
  await act(async () => useApp.setState({ selectedFeature: id, selection }));
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

const bbox = async (id: string) => (await rebuildNow()).report.bodies.find((b) => b.id === id)!.bbox;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Inline more");
  apply(
    { type: "set_param", name: "h", expr: "10 mm" },
    { type: "set_param", name: "w", expr: "10 mm" },
    { type: "add_features", features: design },
  );
  renderUi(<ViewportView />);
  await rebuilt();
  await act(async () => {
    const vp = getViewport()!;
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(cleanup);

describe("values that are variables", () => {
  it("changes the variable when a number is typed over it, in its unit", async () => {
    await show("ex1");
    await type(/^↕ h/, "15");
    expect(currentDoc().params["h"]).toBe("15 mm");
    expect((currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown }).distance).toBe("h");
    expect((await bbox("ex1")).max[2]).toBeCloseTo(15, 6);
  });

  it("replaces the link when an expression is typed", async () => {
    await show("ex1");
    await type(/^↕ h/, "h + 5");
    expect((currentDoc().features.find((f) => f.id === "ex1") as { distance: unknown }).distance).toBe(
      "h + 5",
    );
    expect((await bbox("ex1")).max[2]).toBeCloseTo(20, 6);
  });
});

describe("narrowed to a picked face", () => {
  it("shows only the sizes of the shape the picked side face came from", async () => {
    await show("ex1");
    expect(texts()).toEqual(expect.arrayContaining(["40", "w"]));

    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
    const face = m.faceTags.findIndex((t) => t[0] === "ex1.side[sk1.ba]");
    expect(face).toBeGreaterThanOrEqual(0);
    await show("ex1", [
      {
        kind: "face",
        bodyId: "ex1",
        face,
        tags: m.faceTags[face]!,
        point: [65, 0, 5],
        normal: [0, -1, 0],
      } as Pick,
    ]);
    expect(texts()).toContain("w");
    expect(texts()).not.toContain("40");
  });
});

describe("generated parts", () => {
  it("shows a box's width, depth and height, and a typed width makes it that wide", async () => {
    await act(async () => startFeature("box"));
    await act(async () => void commitDialog());

    const box = currentDoc().features.at(-1)!;
    await show(box.id);

    const w = (box as { width: number }).width;
    expect(texts().some((t) => t === `↔ ${w} mm` || t.startsWith("⌀"))).toBe(true);
    expect(texts().some((t) => t.startsWith("↥ "))).toBe(true);
    await type(/^↔ /, String(w + 10));

    const b = await bbox(box.id);
    expect(b.max[0]! - b.min[0]!).toBeCloseTo(w + 10, 3);
  });

  it("shows a Gridfinity bin's cells and height", async () => {
    await act(async () => startFeature("gridfinity"));
    await act(async () => void commitDialog());

    const bin = currentDoc().features.at(-1) as Extract<Feature, { op: "gridfinity" }>;
    await show(bin.id);
    expect(texts().filter((t) => t.startsWith("▦ "))).toHaveLength(2);
    await type(/^▦ /, "3");

    const b = await bbox(bin.id);
    // Three cells of 42 mm, less the 0.5 mm play.
    expect(b.max[0]! - b.min[0]!).toBeCloseTo(3 * 42 - 0.5, 3);
    await act(async () => cancelDialog());
  });
});
