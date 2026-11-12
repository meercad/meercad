/**
 * More of the app's store (store.ts): a selection survives rebuilds by the faces' names (the same
 * face, wherever it is numbered now), and is dropped rather than pointing at another face when its
 * face is gone; edges stay only while the part keeps its topology. Hiding what is selected, a hole
 * started where a face was tapped (its first hole exactly there), rebuilds held while dragging, and
 * opening drafts.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { apply, cancelDialog, currentDoc, hideSelectedParts, holdRebuilds, newProject, openDraft, rebuilding, rebuildNow, scheduleRebuild, startDraft, startHoleAt, undo, useApp } from "./store";

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
];
/** A pick of the face of ex1 whose tags start with `tag`, as a click there would give. */
const facePick = (tag: string, point: [number, number, number], normal: [number, number, number] | null = null): Pick => {
  const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
  const face = m.faceTags.findIndex((t) => t[0]!.startsWith(tag));
  expect(face, tag).toBeGreaterThanOrEqual(0);
  return { kind: "face", bodyId: "ex1", face, tags: m.faceTags[face]!, point, normal } as Pick;
};
/** Waits for the app's own rebuild (the one that keeps the selection right) to land. */
const settled = async () => {
  // The rebuild is asked for in a microtask after the change.
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 200 && (rebuilding() || useApp.getState().building); i++) await new Promise((r) => setTimeout(r, 20));
};

beforeAll(async () => {
  await newProject(undefined, "Store more");
  apply({ type: "add_features", features: design });
  await rebuildNow();
  scheduleRebuild();
  await settled();
});
beforeEach(() => useApp.setState({ selection: [], hidden: new Set() }));

describe("a selection across rebuilds", () => {
  it("keeps the top face selected when the part grows, by its name", async () => {
    useApp.setState({ selection: [facePick("ex1.end_cap", [20, 10, 10], [0, 0, 1])] });
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 15 } });
    await settled();
    const [p] = useApp.getState().selection as Extract<Pick, { kind: "face" }>[];
    expect(p!.tags).toEqual(["ex1.end_cap"]);
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
    expect(m.faceTags[p!.face]).toEqual(["ex1.end_cap"]);
  });

  it("finds the face again when a cut renumbers the faces, and drops an edge", async () => {
    const top = facePick("ex1.end_cap", [5, 5, 15], [0, 0, 1]);
    const edge = { kind: "edge", bodyId: "ex1", edge: 0, point: [20, 0, 15] } as Pick;
    useApp.setState({ selection: [top, edge] });
    apply({ type: "add_features", features: [{ id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "c", type: "point", x: 20, y: 10 }, { id: "k", type: "circle", center: "c", radius: 3 }], constraints: [] }, { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 60, mode: "cut" }] });
    await settled();
    const sel = useApp.getState().selection;
    expect(sel).toHaveLength(1);
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
    expect(m.faceTags[(sel[0] as Extract<Pick, { kind: "face" }>).face]![0]).toBe("ex1.end_cap");
  });

  it("drops a face that is gone rather than pointing at another one", async () => {
    useApp.setState({ selection: [facePick("ex2.side", [20, 7, 5])] });
    undo();
    await settled();
    expect(useApp.getState().selection).toEqual([]);
  });
});

describe("the store's helpers", () => {
  it("hides the parts and sketches a selection touches", () => {
    useApp.setState({ selection: [facePick("ex1.end_cap", [5, 5, 15], [0, 0, 1]), { kind: "region", sketchId: "sk1", key: "r", point: [0, 0, 0] } as unknown as Pick] });
    hideSelectedParts();
    expect([...useApp.getState().hidden].sort()).toEqual(["ex1", "sk1"]);
    expect(useApp.getState().selection).toEqual([]);
    hideSelectedParts();
    expect(useApp.getState().hidden.size).toBe(2);
  });

  it("starts a hole where the top face was tapped, its first hole exactly there", () => {
    startHoleAt(facePick("ex1.end_cap", [12.344, 7.656, 15], [0, 0, 1]));
    const d = useApp.getState().dialog!;
    expect(d.feature.op).toBe("hole");
    expect(d.field).toBe("points");
    expect((d.feature as { points: [number, number][] }).points).toEqual([[12.34, 7.66]]);
    cancelDialog();
    // A round face has no plane to drill from.
    startHoleAt(facePick("ex1.side", [0, 10, 5], null));
    expect(useApp.getState().dialog).toBeNull();
  });

  it("collects rebuilds while held and runs one when let go", async () => {
    holdRebuilds(true);
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 11 } });
    apply({ type: "edit_feature", id: "ex1", patch: { distance: 12 } });
    expect(rebuilding()).toBe(true);
    holdRebuilds(false);
    await settled();
    expect(useApp.getState().output!.report.bodies[0]!.bbox.max[2]).toBeCloseTo(12, 6);
  });

  it("opens a prepared draft and one made by a drag", () => {
    const draft = { id: "fi9", op: "fillet", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.ba]"] }], radius: 1 } as Feature;
    openDraft(draft);
    expect(useApp.getState().dialog).toMatchObject({ feature: { id: "fi9" }, isNew: true, field: null });
    startDraft({ ...draft, id: "fi8" });
    expect(useApp.getState().dialog).toMatchObject({ feature: { id: "fi8" }, gesture: true });
    cancelDialog();
    expect(currentDoc().features.some((f) => f.id === "fi8" || f.id === "fi9")).toBe(false);
  });
});
