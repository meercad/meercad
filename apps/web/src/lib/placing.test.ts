/**
 * Putting parts in place, with the real kernel: copy and paste beside the original, laying a part
 * on a face for printing (it lands on Z = 0 where it stood), the best way up, and where a hole goes
 * when its edge is tapped (as far in as the hole's wall needs).
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { apply, currentDoc, newProject, rebuildNow, undo, useApp } from "../store";
import { copyParts, cutParts, duplicateParts, hasClip, pasteParts, selectAll, selectParts, selectedParts } from "./clipboard";
import { checkPart, faceNormal, layDown, layOnFace, printBestWayUp, showPrintCheck, hidePrintCheck, setOverhangLimit, usePrintCheck } from "./printability";
import { edgeInset, holeBesideEdge } from "./holes";

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
/** A 40 × 20 × 10 block and a T (10 mm post, 30 × 10 × 2 bar on top). */
const design: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 0, 0, 40, 20), constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 110, 0, 10, 10), constraints: [] },
  { id: "post", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "pl", op: "plane", base: { ref: "origin.XY" }, offset: 10 },
  { id: "sk3", op: "sketch", plane: { ref: "pl" }, entities: rect("d", 100, 0, 30, 10), constraints: [] },
  { id: "bar", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 2, mode: "join", targets: ["post"] },
];
const box = async (id: string) => (await rebuildNow()).report.bodies.find((b) => b.id === id)!.bbox;

beforeAll(async () => {
  await newProject(undefined, "Placing");
  apply({ type: "add_features", features: design });
  await rebuildNow();
});

describe("copy and paste", () => {
  it("pastes a copy beside the original, further with each paste", async () => {
    selectParts(["ex1"]);
    expect(selectedParts()).toEqual(["ex1"]);
    expect(copyParts()).toBe(true);
    expect(hasClip()).toBe(true);
    await pasteParts();
    const out = await rebuildNow();
    const copy = out.report.bodies.find((b) => b.id.endsWith("_ex1"))!;
    // Its width × 1.2 + 5 = 53 mm along X.
    expect(copy.bbox.min[0]).toBeCloseTo(53, 6);
    expect(copy.volume).toBeCloseTo(8000, 6);
    duplicateParts();
    await rebuildNow();
    undo();
    undo();
    expect(currentDoc().features.some((f) => f.op === "transform")).toBe(false);
    await rebuildNow();
  });

  it("selects all parts and cuts one", async () => {
    selectAll();
    expect(selectedParts().sort()).toEqual(["ex1", "post"]);
    selectParts(["post"]);
    cutParts();
    expect(currentDoc().features.at(-1)).toMatchObject({ op: "delete", bodies: ["post"] });
    undo();
    useApp.setState({ selection: [] });
    expect(copyParts([])).toBe(false);
  });
});

describe("laying parts for printing", () => {
  it("finds the T's overhang and that it prints best upside down", async () => {
    await rebuildNow();
    const r = checkPart("post")!;
    expect(r.stats.overhangArea).toBeCloseTo(200, 0);
    expect(r.stats.plateArea).toBeCloseTo(100, 0);
    expect(r.stats.height).toBeCloseTo(12, 6);
    expect(r.stats.best?.down.map((v) => Math.round(v))).toEqual([0, 0, 1]);
    showPrintCheck("post");
    setOverhangLimit(60);
    expect(usePrintCheck.getState().limit).toBe(60);
    hidePrintCheck();
    expect(usePrintCheck.getState().body).toBeNull();
  });

  it("turns it the best way up: the bar on the plate, where it stood", async () => {
    printBestWayUp("post");
    const b = await box("post");
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(12, 6);
    // The bar (30 wide) now lies at the bottom: the box is the same size, upside down.
    expect(b.max[0] - b.min[0]).toBeCloseTo(30, 6);
    const again = checkPart("post")!;
    expect(again.stats.overhangArea).toBeCloseTo(0, 0);
    expect(again.stats.plateArea).toBeCloseTo(300, 0);
    // Turned the best way already: nothing more to do.
    printBestWayUp("post");
    expect(useApp.getState().toasts.at(-1)!.text).toMatch(/already stands the best way up/);
  });

  it("lays the block on its side face", async () => {
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === "ex1")!;
    const side = m.faceTags.findIndex((t) => t.includes("ex1.side[sk1.ba]"));
    expect(faceNormal("ex1", side)!.map((v) => Math.round(v))).toEqual([0, -1, 0]);
    layOnFace("ex1", side);
    const b = await box("ex1");
    // Lying on its 40 × 10 face: 20 high now, bottom on the plate.
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(20, 6);
    expect(layDown("ex1", [0, 0, -1])).toBe(false);
  });
});

describe("holes by an edge", () => {
  it("goes as far in from the edge as the hole's wall needs", async () => {
    const hole = { id: "h", op: "hole", kind: "clearance", size: "M3", plane: { ref: "origin.XY" }, points: [] } as unknown as Extract<Feature, { op: "hole" }>;
    const inset = edgeInset(hole)!;
    expect(inset).toBeGreaterThan(3);
    expect(edgeInset({ ...hole, size: "nonsense" })).toBeUndefined();
    const out = await rebuildNow();
    const m = out.meshes.find((x) => x.bodyId === "ex1")!;
    // An edge of the face lying on the plate now: the hole goes on that face, `inset` in.
    for (let e = 0; e < m.edgeFaces.length; e++) {
      const at = holeBesideEdge(m, e, [0, 0, 0], inset);
      if (!at) continue;
      expect(Math.hypot(...at.normal)).toBeCloseTo(1, 9);
      return;
    }
    throw new Error("no edge took a hole");
  });
});
