/**
 * The Delete key on the model (deletion.ts) with the real kernel: a hole's wall takes the hole out
 * of its cut, a rounded face its edge out of the fillet, a double-clicked part goes as a Delete
 * step; each checked by the volume that comes out.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { apply, currentDoc, newProject, rebuildNow, undo, useApp } from "../store";
import { deleteBodies, deleteModelSelection } from "./deletion";

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
const circle = (id: string, x: number, y: number, r: number): SketchEntity[] => [
  { id: `${id}c`, type: "point", x, y },
  { id, type: "circle", center: `${id}c`, radius: r },
];
/** A 40 × 20 × 10 block with two Ø6 holes cut through it, one edge rounded R2, and a cube beside it. */
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [...circle("h1", 10, 10, 3), ...circle("h2", 30, 10, 3)], constraints: [] },
  { id: "cut", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut" },
  { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.ba]"] }, { edge: ["ex1.end_cap", "ex1.side[sk1.bc]"] }], radius: 2 },
  { id: "sk3", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 60, 0, 10, 10), constraints: [] },
  { id: "cube", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 10, mode: "new_body" },
];
const hole = Math.PI * 9 * 10;
const round = (4 - Math.PI) * 40; // one R2 fillet along a 40 mm edge: (r² − πr²/4) × length

async function picks(match: (tag: string) => boolean, body = "ex1"): Promise<Pick[]> {
  const out = await rebuildNow();
  const m = out.meshes.find((x) => x.bodyId === body)!;
  return m.faceTags.flatMap((tags, face) => (tags.some(match) ? [{ kind: "face" as const, bodyId: body, face, tags, point: [0, 0, 0] as [number, number, number], normal: null }] : []));
}
const volume = async (id = "ex1") => (await rebuildNow()).report.bodies.find((b) => b.id === id)?.volume;

beforeAll(async () => {
  await newProject(undefined, "Delete");
  apply({ type: "add_features", features: design });
  expect(await volume()).toBeCloseTo(8000 - 2 * hole - 2 * round, 1);
});

describe("the Delete key on the model", () => {
  it("takes one hole out of the cut and keeps the other", async () => {
    useApp.setState({ selection: await picks((t) => t === "cut.side[sk2.h1]") });
    await deleteModelSelection();
    expect(currentDoc().features.find((f) => f.id === "cut")).toMatchObject({ profile: { sketch: "sk2", regions: [expect.stringContaining("h2")] } });
    expect(await volume()).toBeCloseTo(8000 - hole - 2 * round, 1);
    expect(useApp.getState().selection).toEqual([]);
    undo();
  });

  it("deletes the cut with its last hole, both holes in one undo step", async () => {
    useApp.setState({ selection: await picks((t) => t === "cut.side[sk2.h1]" || t === "cut.side[sk2.h2]") });
    await deleteModelSelection();
    expect(currentDoc().features.some((f) => f.id === "cut")).toBe(false);
    expect(await volume()).toBeCloseTo(8000 - 2 * round, 1);
    undo();
    expect(await volume()).toBeCloseTo(8000 - 2 * hole - 2 * round, 1);
  });

  it("drops one rounded edge from the fillet", async () => {
    useApp.setState({ selection: (await picks((t) => t.startsWith("fi1.round[") && t.includes("sk1.ba"))).slice(0, 1) });
    await deleteModelSelection();
    expect((currentDoc().features.find((f) => f.id === "fi1") as { edges: unknown[] }).edges).toHaveLength(1);
    expect(await volume()).toBeCloseTo(8000 - 2 * hole - round, 1);
    undo();
  });

  it("deletes a whole part as a Delete step", async () => {
    useApp.setState({ selection: await picks(() => true, "cube") });
    await deleteModelSelection();
    expect(currentDoc().features.at(-1)).toMatchObject({ op: "delete", bodies: ["cube"] });
    expect(await volume("cube")).toBeUndefined();
    undo();
    deleteBodies([]);
    expect(currentDoc().features.at(-1)!.id).toBe("cube");
  });

  it("says what cannot be deleted on its own", async () => {
    useApp.setState({ selection: [{ kind: "edge", bodyId: "ex1", edge: 0, point: [0, 0, 0] }] });
    await deleteModelSelection();
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/Edges can't be deleted on their own/);
    useApp.setState({ selection: [{ kind: "plane", planeId: "origin.XY", point: [0, 0, 0] }] });
    await deleteModelSelection();
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/Nothing here can be deleted/);
    useApp.setState({ selection: [{ kind: "face", bodyId: "ex1", face: 0, tags: [], point: [0, 0, 0], normal: null }] });
    await deleteModelSelection();
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/no name/);
    useApp.setState({ selection: [] });
  });
});
