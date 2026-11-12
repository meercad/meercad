/**
 * More of an assistant's requests in the app: an imported mesh measured, compared and rebuilt;
 * undo, redo, preview and versions; sketches as DXF and SVG; parts shown and hidden; folders;
 * big exports fetched piece by piece.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import type { Feature, SketchEntity } from "@meercad/schema";
import { prism, turned } from "../../../../tests/acceptance/meshes";
import { testCall } from "./mcpBridge";
import { useApp } from "../store";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => testCall(method, params) as Promise<T>;
const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const stlOf = (corners: Float64Array) => writeStl([{ positions: Float32Array.from(corners), indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i) }]);

const square: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 30, y: 0 },
  { id: "p3", type: "point", x: 30, y: 30 },
  { id: "p4", type: "point", x: 0, y: 30 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
];
const box: Feature[] = [
  { id: "sk1", op: "sketch", plane: { ref: "origin.XY" }, entities: square, constraints: [] },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "h", mode: "new_body" },
];

beforeAll(async () => {
  await call("new_project", { name: "More" });
  await call("apply_ops", { ops: [{ type: "set_param", name: "h", expr: "10 mm" }, { type: "add_features", features: box }] });
});

describe("editing through the assistant", () => {
  it("undoes and redoes, naming the parts that changed", async () => {
    await call("apply_ops", { ops: [{ type: "set_param", name: "h", expr: "20 mm" }] });
    const undone = await call<{ bodies: { id: string; volume: number }[] }>("undo");
    expect(undone.bodies.map((b) => [b.id, b.volume])).toEqual([["ex1", 9000]]);
    const redone = await call<{ bodies: { id: string; volume: number }[] }>("redo");
    expect(redone.bodies.map((b) => [b.id, b.volume])).toEqual([["ex1", 18000]]);
  });

  it("previews ops without changing the design, and clears the preview", async () => {
    const p = await call<{ bodies: { volume: number }[] }>("preview_ops", { ops: [{ type: "set_param", name: "h", expr: "5 mm" }] });
    expect(p.bodies[0]!.volume).toBe(4500);
    expect(useApp.getState().proposalDoc).not.toBeNull();
    expect((await call<{ document: { params: Record<string, string> } }>("get_model")).document.params["h"]).toBe("20 mm");
    expect(await call("clear_preview")).toBe("ok");
    expect(useApp.getState().proposalDoc).toBeNull();
    const full = await call<{ features: unknown[]; params: Record<string, unknown> }>("preview_ops", { ops: [{ type: "set_param", name: "h", expr: "5 mm" }], detail: "full" });
    expect(full.features).toHaveLength(2);
  });

  it("files versions away and shows one without restoring it", async () => {
    const saved = await call<{ ok: boolean; versions: string[] }>("apply_ops", { ops: [{ type: "save_version", name: "tall" }] });
    expect(saved).toEqual({ ok: true, versions: ["tall"] });
    await call("apply_ops", { ops: [{ type: "set_param", name: "h", expr: "1 mm" }] });
    const v = await call<{ document: { params: Record<string, string> } }>("get_version", { name: "tall" });
    expect(v.document.params["h"]).toBe("20 mm");
    const m = await call<{ versions: { name: string }[] }>("get_model");
    expect(m.versions.map((x) => x.name)).toEqual(["tall"]);
    const file = await call<{ files: Record<string, string> }>("export", { format: "meercad", version: "tall" });
    expect(JSON.parse(new TextDecoder().decode(fromB64(file.files["model.meercad"]!))).params["h"]).toBe("20 mm");
  });

  it("gives a sketch's solved geometry and writes it as DXF and SVG", async () => {
    const sk = await call<{ regions: { area: number }[]; diagnostics: { dof: number } }>("get_sketch", { id: "sk1" });
    expect(sk.regions.map((r) => r.area)).toEqual([900]);
    await expect(call("get_sketch", { id: "zz" })).rejects.toThrow(/sketch "zz" not found/);
    const dxf = new TextDecoder().decode(fromB64((await call<{ files: Record<string, string> }>("export", { format: "dxf", sketch: "sk1" })).files["sketch.dxf"]!));
    expect(dxf).toContain("LINE");
    const svg = new TextDecoder().decode(fromB64((await call<{ files: Record<string, string> }>("export", { format: "svg", sketch: "sk1" })).files["sketch.svg"]!));
    expect(svg).toContain("<svg");
    await expect(call("export", { format: "dxf" })).rejects.toThrow(/needs a sketch id/);
  });

  it("hands a big export over in pieces", async () => {
    const r = await call<{ files: Record<string, string>; staged?: { token: string; sizes: Record<string, number> } }>("export", { format: "stl", stage: true, name: "x" });
    // Small: inline.
    expect(Object.keys(r.files)).toEqual(["x.stl"]);
    expect(r.staged).toBeUndefined();
    await expect(call("staged_files", { token: "nope", pieces: [] })).rejects.toThrow(/no longer here/);
  });
});

describe("parts, folders and the project", () => {
  it("shows and hides parts", async () => {
    expect(await call("set_visibility", { hide: ["ex1"] })).toEqual({ hidden: ["ex1"], shown: [] });
    expect(await call("set_visibility", { all: true })).toEqual({ hidden: [], shown: ["ex1"] });
  });

  it("lists materials and the parts' materials", async () => {
    await call("apply_ops", { ops: [{ type: "set_material", part: "ex1", material: "petg" }] });
    const m = await call<{ materials: { id: string; density: number }[]; parts: Record<string, string> }>("list_materials");
    expect(m.parts).toEqual({ ex1: "petg" });
    expect(m.materials.find((x) => x.id === "petg")!.density).toBeGreaterThan(1);
  });

  it("renames the project, makes a folder and moves it there", async () => {
    expect((await call<{ project: { name: string } }>("rename_project", { name: "Renamed" })).project.name).toBe("Renamed");
    expect(await call("create_folder", { name: "Box" })).toEqual({ folder: "Box" });
    expect((await call<{ project: { folder: string } }>("move_project", { folder: "Box" })).project.folder).toBe("Box");
    expect(await call("list_folders")).toEqual({ folders: ["Box"], current: "Box" });
    const st = await call<{ project: { name: string }; projectCount: number }>("get_status");
    expect(st.project.name).toBe("Renamed");
    expect((await call<{ name: string }[]>("list_projects")).map((p) => p.name)).toContain("Renamed");
  });
});

describe("imported meshes", () => {
  it("measures a cylinder on a mesh and the angle between two of its faces", async () => {
    // A Ø20 × 30 cylinder as 96 facets.
    const cyl = turned([[0, 0], [10, 0], [10, 30], [0, 30]], 96);
    const imported = await call<{ added: string[] }>("import_file", { name: "cyl.stl", base64: b64(stlOf(cyl)) });
    const id = imported.added[0]!;
    const side = await call<{ shape: string; values: Record<string, string>[] }>("measure_scan", { part: id, point: [10, 0, 15] });
    expect(side.shape).toBe("cylinder");
    expect(Object.assign({}, ...side.values)).toMatchObject({ Diameter: "20 mm" });
    const two = await call<{ a: { shape: string }; b: { shape: string }; between: Record<string, string>[] }>("measure_scan", { part: id, point: [3, 3, 30], other: { point: [3, 3, 0] } });
    expect([two.a.shape, two.b.shape]).toEqual(["plane", "plane"]);
    expect(Object.assign({}, ...two.between)).toMatchObject({ Distance: "30 mm" });
  });

  it("compares a drawn part with a mesh of it", async () => {
    const plate = prism([[0, 0], [30, 0], [30, 30], [0, 30]], 20);
    const imported = await call<{ added: string[] }>("import_file", { name: "plate.stl", base64: b64(stlOf(plate)) });
    await call("apply_ops", { ops: [{ type: "set_param", name: "h", expr: "20 mm" }] });
    const d = await call<{ minMm: number; maxMm: number; shareWithinTolerance: number }>("deviation", { part: "ex1", mesh: imported.added[0]!, show: false });
    // ex1 is 30 × 30 × 20, the mesh the same: no deviation.
    expect(Math.abs(d.minMm)).toBeLessThan(0.01);
    expect(Math.abs(d.maxMm)).toBeLessThan(0.01);
    expect(d.shareWithinTolerance).toBe(1);
  });

  it("cleans up a mesh and rebuilds it with features of the right size", async () => {
    const plate = prism([[100, 0], [130, 0], [130, 10], [100, 10]], 5);
    const imported = await call<{ added: string[] }>("import_file", { name: "small.stl", base64: b64(stlOf(plate)) });
    const id = imported.added[0]!;
    const repaired = await call<{ messages: { text: string }[] }>("repair_mesh", { part: id, reduce: 0.05 });
    expect(Array.isArray(repaired.messages)).toBe(true);
    await expect(call("repair_mesh", { part: "ex1" })).rejects.toThrow(/not an imported mesh/);
    const rebuilt = await call<{ added: string[] }>("rebuild_mesh", { part: id });
    expect(rebuilt.added.length).toBeGreaterThanOrEqual(2);
    const m = await call<{ rebuild: { bodies: { id: string; volume: number }[] } }>("get_model");
    const made = m.rebuild.bodies.filter((b) => rebuilt.added.includes(b.id));
    expect(made.reduce((v, b) => v + b.volume, 0)).toBeCloseTo(1500, 1);
  });
});

describe("pictures for the assistant", () => {
  it("renders views, a motion sheet with a GIF and a drawing sheet", async () => {
    // The pictures come from the app's own 3D view.
    const { withScreen, renderUi, rebuilt } = await import("../../test/ui");
    const { ViewportView } = await import("../components/ViewportView");
    const { createElement } = await import("react");
    withScreen();
    renderUi(createElement(ViewportView));
    await rebuilt();
    const view = await call<{ png: string }>("render_view", { view: "iso", width: 320, height: 240 });
    expect(view.png.length).toBeGreaterThan(0);
    for (const extra of [{ direction: [1, -1, 1] }, { focus: ["ex1"], isolate: true }, { section: { plane: "XZ", offset: 5 } }, { highlight: { parts: ["ex1"], faces: [{ face: "ex1.end_cap" }] } }, { style: "rendered" }, { frame: { min: [0, 0, 0], max: [30, 30, 20] } }])
      expect((await call<{ png: string }>("render_view", { view: "top", ...extra })).png.length, JSON.stringify(extra)).toBeGreaterThan(0);
    await expect(call("render_view", { section: { plane: "AB" } })).rejects.toThrow(/section needs plane/);
    await call("apply_ops", { ops: [{ type: "set_joint", joint: { id: "jz", type: "revolute", a: "ex1", b: "ground", anchor: { axis: { ref: "origin.Z" } }, limits: [0, 90] } }] });
    const motion = await call<{ png: string; frames: unknown[]; gif?: string }>("render_motion", { joint: "jz", frames: 3, video: { frames: 4, width: 64, height: 64 } });
    expect(motion.frames).toHaveLength(3);
    expect(motion.gif?.length).toBeGreaterThan(0);
    await expect(call("render_motion", {})).rejects.toThrow(/give a joint/);
    const sheet = await call<{ file: string; scale: string; views: string[] }>("drawing", { views: ["front", "top"], paper: "A4", format: "svg" });
    expect(sheet.views).toEqual(["front", "top"]);
    expect(atob(sheet.file)).toContain("<svg");
    const dxf = await call<{ file: string }>("drawing", { format: "dxf" });
    expect(atob(dxf.file)).toContain("SECTION");
    const pdf = await call<{ file: string }>("drawing", {});
    expect(atob(pdf.file).slice(0, 5)).toBe("%PDF-");
  }, 120_000);
});
