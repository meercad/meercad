/**
 * Drag arrows on what is selected (Manipulators.tsx) in the real 3D view: the top of an extrusion
 * changes its height, a side face pushes out a new step, an edge rounds when dragged out and bevels
 * when dragged in, a hole's wall changes its diameter, a whole part moves, a shell's wall thickens.
 * The part that comes out has the volume the drag means. The part: a 40 × 20 × 10 block with an
 * Ø8 hole through it at (20, 10).
 */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick, Viewport } from "@meercad/viewport";
import {
  apply,
  cancelDialog,
  currentDoc,
  editFeature,
  getViewport,
  newProject,
  rebuildNow,
  undo,
  useApp,
} from "../store";
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
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  {
    id: "sk2",
    op: "sketch",
    plane: { ref: "origin.XY" },
    entities: [
      { id: "c", type: "point", x: 20, y: 10 },
      { id: "k", type: "circle", center: "c", radius: 4 },
    ],
    constraints: [{ id: "d", type: "diameter", curve: "k", value: 8 }],
  },
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 30, mode: "cut" },
];
const HOLE = Math.PI * 16 * 10;
let vp: Viewport;
const settle = (ms = 40) => act(async () => new Promise((r) => setTimeout(r, ms)));
const FACE = new Set(["face"] as const);
const EDGE = new Set(["edge"] as const);

const pickAt = (w: [number, number, number], kinds: Set<"face" | "edge">) => {
  const [x, y] = vp.worldToScreen(w)!;

  return vp.pick(x, y, kinds as never);
};

async function select(...picks: (Pick | null)[]) {
  expect(picks.every(Boolean)).toBe(true);
  await act(async () => useApp.setState({ selection: picks as Pick[] }));
  await settle();
}

async function drag(id: string, to: number) {
  const h = vp.handles.find((x) => x.id === id || x.id.startsWith(id))!;
  expect(h, `arrow ${id}: ${vp.handles.map((x) => x.id).join()}`).toBeDefined();
  await act(async () => h.onStart?.());
  await act(async () => h.onDrag(to));
  await act(async () => h.onEnd(to));
  await settle();

  return h;
}

const volume = async () => (await rebuildNow()).report.bodies[0]!.volume!;

beforeAll(async () => {
  withScreen();
  await newProject(undefined, "Arrows on picks");
  expect(apply({ type: "add_features", features: design })).toBe(true);
  renderUi(<ViewportView />);
  await rebuilt();
  vp = getViewport()!;
  await act(async () => {
    vp.setView("iso", false);
    vp.fit(false);
  });
});
beforeEach(async () => {
  await act(async () => useApp.setState({ selection: [] }));
});
afterAll(cleanup);

describe("arrows on what is selected", () => {
  it("lifts the top of the extrusion to 15 mm", async () => {
    expect(await volume()).toBeCloseTo(8000 - HOLE, 3);
    await select(pickAt([5, 5, 10], FACE));

    const h = vp.handles.find((x) => x.id === "cap")!;
    expect(h.value).toBeCloseTo(10, 9);
    await drag("cap", 15);
    expect(currentDoc().features.find((f) => f.id === "ex1")).toMatchObject({ distance: 15 });
    expect(await volume()).toBeCloseTo(40 * 20 * 15 - Math.PI * 16 * 15, 3);
    await act(async () => undo());
    await rebuilt();
    expect(await volume()).toBeCloseTo(8000 - HOLE, 3);
  });

  it("pushes a side face out 5 mm as a step of its own", async () => {
    // Whichever long or short side the view shows.
    const side = [
      pickAt([40, 10, 5], FACE),
      pickAt([20, 0, 5], FACE),
      pickAt([20, 20, 5], FACE),
      pickAt([0, 10, 5], FACE),
    ].find(
      (p): p is Extract<Pick, { kind: "face" }> =>
        p?.kind === "face" && !!p.normal && Math.abs(p.normal[2]) < 0.1,
    )!;
    await select(side);

    const area = Math.abs(side.normal![0]) > 0.5 ? 20 * 10 : 40 * 10;
    await drag("extrude", 5);

    const step = currentDoc().features.at(-1)!;
    expect(step).toMatchObject({ op: "extrude", mode: "join", distance: 5 });
    expect(await volume()).toBeCloseTo(8000 - HOLE + area * 5, 3);
    await act(async () => undo());
    await rebuilt();
  });

  it("rounds an edge dragged out and bevels it dragged in", async () => {
    const edge = [pickAt([20, 0, 10], EDGE), pickAt([40, 10, 10], EDGE), pickAt([20, 20, 10], EDGE)].find(
      (p) => p?.kind === "edge",
    )!;
    await select(edge);
    await drag("edge", 2);
    expect(currentDoc().features.at(-1)).toMatchObject({ op: "fillet", radius: 2 });

    // Along a 40 mm (or 20 mm) edge: (1 − π/4)·r² per mm comes off, r = 2.
    const along = Math.abs(
      edge.kind === "edge" && Math.abs(((edge as { point: number[] }).point[1] ?? 0) - 10) > 5 ? 40 : 20,
    );
    expect(await volume()).toBeCloseTo(8000 - HOLE - (1 - Math.PI / 4) * 4 * along, 3);
    await act(async () => undo());
    await rebuilt();
    await select(edge);
    await drag("edge", -1.5);
    expect(currentDoc().features.at(-1)).toMatchObject({ op: "chamfer", distance: 1.5 });
    expect(await volume()).toBeCloseTo(8000 - HOLE - (1.5 ** 2 / 2) * along, 3);
    await act(async () => undo());
    await rebuilt();
  });

  it("widens the hole by its wall's arrow: Ø8 to Ø10", async () => {
    // The hole's wall, picked as a click on it would: its face and tags, the point on it.
    const mesh = useApp.getState().output!.meshes.find((m) => m.bodyId === "ex1")!;
    const face = mesh.faceTags.findIndex((tags) => tags.some((t) => t.startsWith("ex2.side[sk2.k]")));
    expect(face).toBeGreaterThanOrEqual(0);
    await select({
      kind: "face",
      bodyId: "ex1",
      face,
      tags: mesh.faceTags[face]!,
      point: [20, 6, 5],
      normal: null,
      surface: [0, 1, 0],
    } as unknown as Pick);

    const h = vp.handles.find((x) => x.id === "hole");
    expect(h, vp.handles.map((x) => x.id).join()).toBeDefined();
    await drag("hole", 5);

    const sk = currentDoc().features.find((f) => f.id === "sk2") as Extract<Feature, { op: "sketch" }>;
    expect(JSON.stringify(sk.constraints)).toMatch(/"value":10\b/);
    expect(await volume()).toBeCloseTo(8000 - Math.PI * 25 * 10, 3);
    await act(async () => undo());
    await rebuilt();
  });

  it("moves a whole part 12 mm along X", async () => {
    const mesh = useApp.getState().output!.meshes.find((m) => m.bodyId === "ex1")!;
    const top = pickAt([5, 5, 10], FACE)!;
    await select(...mesh.faceTags.map((tags, face) => ({ ...top, face, tags }) as Pick));
    // The bar of actions for a whole part.
    expect(screen.getByText("Move")).toBeTruthy();

    const x = vp.handles.find((h) => /x$/i.test(h.id) || h.dir[0] === 1)!;
    expect(x).toBeDefined();
    await act(async () => x.onStart?.());
    await act(async () => x.onDrag(12));
    await act(async () => x.onEnd(12));
    await settle();

    const move = currentDoc().features.at(-1)!;
    expect(move).toMatchObject({ op: "transform", bodies: ["ex1"] });
    expect((move as { translate: number[] }).translate).toEqual([12, 0, 0]);

    const box = (await rebuildNow()).report.bodies[0]!.bbox;
    expect(box.min[0]).toBeCloseTo(12, 6);
    await act(async () => undo());
    await rebuilt();
  });

  it("thickens a shell's wall by its arrow", async () => {
    apply({
      type: "add_features",
      features: [{ id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 } as Feature],
    });
    await rebuilt();
    await act(async () => editFeature("sh1"));
    await settle();

    const h = vp.handles.find((x) => x.id === "shell")!;
    expect(h.value).toBeCloseTo(2, 9);
    await act(async () => h.onDrag(3));
    expect((useApp.getState().dialog!.feature as { thickness: unknown }).thickness).toBe(3);
    await act(async () => cancelDialog());
  });

  it("offers the actions that fit a face, an edge and a region", async () => {
    await select(pickAt([5, 5, 10], FACE));
    expect(screen.getByText("Push/Pull")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("Measure")));
    expect(useApp.getState().measure.active).toBe(true);
    useApp.setState({ measure: { active: false, picks: [], result: null } });
    await select(pickAt([20, 0, 10], EDGE));
    expect(screen.getByText("Chamfer")).toBeTruthy();
  });
});
