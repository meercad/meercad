/**
 * Drag arrows (Manipulators.tsx) for a bend and for holes tied by Equal, in the real 3D view: a
 * bend's arrow sets its angle from the radius dragged (a 60 mm strip bent at radius 30 makes
 * 60/30 rad = 114.6°); a ring's and a spiral's arrow set the radius; a hole whose circle is Equal to
 * another (which carries the diameter) widens both by that diameter; a hole without any dimension
 * gets its circle's radius changed.
 */
import { act, cleanup } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick, Viewport } from "@meercad/viewport";
import { apply, cancelDialog, currentDoc, editFeature, getViewport, newProject, rebuildNow, updateDraft, useApp } from "../store";
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
let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const handle = (id: string) => vp.handles.find((h) => h.id === id);
async function drag(id: string, to: number) {
  const h = handle(id)!;
  expect(h, `${id}: ${vp.handles.map((x) => x.id).join()}`).toBeDefined();
  await act(async () => h.onStart?.());
  await act(async () => h.onDrag(to));
  await act(async () => h.onEnd(to));
  await settle();
}
const draft = <T,>() => useApp.getState().dialog!.feature as T;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Bend arrows");
  apply({ type: "add_features", features: [
    { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 60, 10), constraints: [] },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 2, mode: "new_body" },
    { id: "bd1", op: "bend", mode: "bend", bodies: ["ex1"], axis: { ref: "origin.Y" }, angle: 90 } as Feature,
  ] as Feature[] });
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
});
afterAll(async () => {
  await act(async () => cancelDialog());
  cleanup();
});

describe("a bend's arrow", () => {
  it("sets a bend's angle from the radius dragged, and a ring's or a spiral's radius", async () => {
    await act(async () => editFeature("bd1"));
    await rebuilt();
    await settle();
    await drag("bend", 30);
    expect(draft<{ angle: number }>().angle).toBeCloseTo((60 / 30) * (180 / Math.PI), 1);
    await act(async () => updateDraft({ mode: "wrap", angle: undefined, radius: 20 } as never));
    await rebuilt();
    await settle();
    await drag("bend", 25);
    expect(draft<{ radius: number }>().radius).toBe(25);
    await act(async () => updateDraft({ mode: "spiral", radius: 8, gap: 1 } as never));
    await rebuilt();
    await settle();
    await drag("bend", 9.5);
    expect(draft<{ radius: number }>().radius).toBe(9.5);
    await act(async () => cancelDialog());
  });
});

describe("holes tied by Equal", () => {
  it("widens both by the other circle's diameter, and changes a free circle's radius", async () => {
    apply({ type: "delete_feature", id: "bd1" } as never, { type: "add_features", features: [
      { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [
        { id: "c1", type: "point", x: 15, y: 5 }, { id: "k1", type: "circle", center: "c1", radius: 2 },
        { id: "c2", type: "point", x: 45, y: 5 }, { id: "k2", type: "circle", center: "c2", radius: 2 },
        { id: "c3", type: "point", x: 30, y: 5 }, { id: "k3", type: "circle", center: "c3", radius: 1.5 },
      ], constraints: [{ id: "d", type: "diameter", curve: "k2", value: 4 }, { id: "e", type: "equal", a: "k1", b: "k2" }] },
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 10, mode: "cut" },
    ] as Feature[] });
    await rebuilt();
    const wall = (tag: string, at: [number, number, number]): Pick => {
      const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
      const face = m.faceTags.findIndex((tags) => tags.some((t) => t.startsWith(tag)));
      return { kind: "face", bodyId: "ex1", face, tags: m.faceTags[face]!, point: at, normal: null, surface: [0, 1, 0] } as unknown as Pick;
    };
    await act(async () => useApp.setState({ selection: [wall("ex2.side[sk2.k1]", [15, 7, 1])], selectedFeature: null }));
    await settle();
    await drag("hole", 3);
    const d = (currentDoc().features.find((f) => f.id === "sk2") as Extract<Feature, { op: "sketch" }>).constraints.find((c) => c.id === "d") as { value: unknown };
    expect(d.value).toBe(6);
    await act(async () => useApp.setState({ selection: [wall("ex2.side[sk2.k3]", [30, 6.5, 1])], selectedFeature: null }));
    await settle();
    await drag("hole", 2.5);
    const k3 = (currentDoc().features.find((f) => f.id === "sk2") as Extract<Feature, { op: "sketch" }>).entities.find((e) => e.id === "k3") as { radius: number };
    expect(k3.radius).toBe(2.5);
    // Cut 10 deep through the 2 mm strip: the strip lost three round holes (two Ø6, one Ø5).
    const v = (await rebuildNow()).report.bodies.find((b) => b.id === "ex1")!.volume!;
    expect(v).toBeCloseTo(60 * 10 * 2 - Math.PI * (9 + 9 + 6.25) * 2, 1);
  });
});
