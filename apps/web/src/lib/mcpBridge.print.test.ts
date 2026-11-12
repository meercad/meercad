/**
 * An assistant's checks for printing, answered by the app (mcpTools.ts) with the real kernel: a T
 * standing on its stem overhangs 200 mm² (its two arms' undersides, 10 × 10 each) and needs about
 * 4000 mm³ of support; another way up checked without turning it;
 * turned the best way up it needs none. The wall thickness of a 2 mm plate, quickly and without the
 * map; parts that overlap by 1000 mm³ and parts that touch.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import type { Feature, SketchEntity } from "@meercad/schema";
import { prism, turnedAboutX } from "../../../../tests/acceptance/meshes";
import { testCall } from "./mcpBridge";
import { useThickness } from "./thickness";
import { usePrintCheck } from "./printability";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => testCall(method, params) as Promise<T>;
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const stlOf = (corners: Float64Array) => writeStl([{ positions: Float32Array.from(corners), indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i) }]);
type Print = { overhangMm2: number; supportMm3: number; onBedMm2: number; heightMm: number; best: { supportMm3: number } | string; down?: number[]; turned?: unknown[] };
let tee = "";
let plate = "";
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

beforeAll(async () => {
  await call("new_project", { name: "Printing" });
  const t = turnedAboutX(prism([[10, 0], [20, 0], [20, 20], [30, 20], [30, 25], [0, 25], [0, 20], [10, 20]], 10), 90);
  tee = (await call<{ added: string[] }>("import_file", { name: "tee.stl", base64: b64(stlOf(t)) })).added[0]!;
  plate = (await call<{ added: string[] }>("import_file", { name: "plate.stl", base64: b64(stlOf(prism([[100, 0], [130, 0], [130, 30], [100, 30]], 2))) })).added[0]!;
});

describe("checking a part for printing", () => {
  it("finds the T's overhang and support as it stands, and that the other way up needs none", async () => {
    const r = await call<Print>("print_check", { part: tee });
    expect(r.overhangMm2).toBeCloseTo(200, 0);
    expect(r.supportMm3).toBeCloseTo(4000, -2);
    expect(r.onBedMm2).toBeCloseTo(100, 0);
    expect(r.heightMm).toBeCloseTo(25, 2);
    expect(r.best).toMatchObject({ supportMm3: 0 });
    expect(usePrintCheck.getState().body).toBe(tee);
  });

  it("checks another way up without turning it: upside down it needs no support", async () => {
    const byDir = await call<Print>("print_check", { part: tee, down: [0, 0, 1], show: false });
    expect(byDir.overhangMm2).toBeCloseTo(0, 0);
    expect(byDir.onBedMm2).toBeCloseTo(300, 0);
    expect(byDir.best).toBe("this way up");
    await expect(call("print_check", { part: tee, down: [0, 0, 0] })).rejects.toThrow(/down must not be \[0, 0, 0\]/);
    await expect(call("print_check", { part: tee, down: [0, 0, 1], turn: "best" })).rejects.toThrow(/not both/);
    expect(usePrintCheck.getState().body).toBeNull();
  });

  it("turns it the best way up: then it needs no support", async () => {
    const r = await call<Print>("print_check", { part: tee, turn: "best" });
    expect(r.overhangMm2).toBeCloseTo(0, 0);
    expect(r.heightMm).toBeCloseTo(25, 2);
    const again = await call<Print>("print_check", { part: tee, turn: "best" });
    expect(JSON.stringify(again.turned)).toMatch(/already/);
  });

  it("measures the plate's walls quickly, without leaving the map shown", async () => {
    const r = await call<{ thinnestMm: number; shareThinnerThanMinWall: number; shown: boolean; quality?: string }>("wall_thickness", { part: plate, minWall: 1, quality: "fast", show: false });
    expect(r.thinnestMm).toBeCloseTo(2, 2);
    expect(r.shareThinnerThanMinWall).toBe(0);
    expect(r).toMatchObject({ shown: false, quality: "fast" });
    expect(useThickness.getState().body).toBeNull();
    await expect(call("wall_thickness", { part: "nope" })).rejects.toThrow(/nope/);
  });
});

describe("parts that overlap", () => {
  it("finds two blocks overlapping by 1000 mm³ and two that just touch", async () => {
    await call("apply_ops", { ops: [{ type: "add_features", features: [
      { id: "sa", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("a", 200, 0, 20, 10), constraints: [] },
      { id: "ea", op: "extrude", profile: { sketch: "sa" }, extent: "blind", distance: 10, mode: "new_body" },
      { id: "sb", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("b", 210, 0, 20, 10), constraints: [] },
      { id: "eb", op: "extrude", profile: { sketch: "sb" }, extent: "blind", distance: 10, mode: "new_body", targets: [] },
      { id: "sc", op: "sketch", plane: { ref: "origin.XY" }, entities: rect("c", 230, 0, 10, 10), constraints: [] },
      { id: "ec", op: "extrude", profile: { sketch: "sc" }, extent: "blind", distance: 10, mode: "new_body" },
    ] as Feature[] }] });
    const r = await call<{ overlaps: { a: string; b: string; overlapMm3: number }[]; touching: string[][] }>("check_interference", { parts: ["ea", "eb", "ec"] });
    const ab = r.overlaps.find((o) => [o.a, o.b].sort().join() === "ea,eb")!;
    expect(ab.overlapMm3).toBeCloseTo(1000, 3);
    expect(r.touching.map((p) => [...p].sort().join())).toContain("eb,ec");
    await expect(call("check_interference", { parts: ["zz"] })).rejects.toThrow(/no part "zz"/);
  });
});
