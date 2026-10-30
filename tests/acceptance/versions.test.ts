import { describe, expect, it } from "vitest";
import { applyOp, designOf, versionChanges } from "@meercad/model";
import { validateDocument, type Feature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const block = (): ReturnType<typeof doc> =>
  doc([sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 10, 10)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "height", mode: "new_body" } as Feature], { height: 20 });
/** An imported "file" large enough to be kept once in the blobs. */
const scan = (n: number): Feature => ({ id: `im${n}`, op: "import", format: "stl", fileName: "scan.stl", data: "A".repeat(10_000) });

describe("versions", () => {
  it("saves the design under a name and brings it back, the versions staying", async () => {
    const s = await newSession();
    let d = block();
    d = applyOp(d, { type: "save_version", name: "First" });
    d = applyOp(d, { type: "set_param", name: "height", expr: 40 });
    d = applyOp(d, { type: "add_features", features: [{ id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1", where: { face: "ex1.end_cap" } }, radius: 1 }] });
    expect(s.rebuild(d).report.bodies[0]!.bbox.max[2]).toBeCloseTo(40, 6);
    d = applyOp(d, { type: "save_version", name: "Rounded" });
    d = applyOp(d, { type: "restore_version", name: "First" });
    expect(d.params).toEqual({ height: 20 });
    expect(d.features.map((f) => f.id)).toEqual(["sk1", "ex1"]);
    expect(d.versions!.map((v) => v.name)).toEqual(["First", "Rounded"]);
    expect(s.rebuild(d).report.bodies[0]!.volume).toBeCloseTo(2000, 6);
    d = applyOp(d, { type: "restore_version", name: "Rounded" });
    expect(d.features.map((f) => f.id)).toEqual(["sk1", "ex1", "fi1"]);
    expect(validateDocument(d).ok).toBe(true);
  });

  it("replaces a version of the same name, renames and deletes them", () => {
    let d = applyOp(block(), { type: "save_version", name: "A" });
    d = applyOp(d, { type: "set_param", name: "height", expr: 30 });
    d = applyOp(d, { type: "save_version", name: "A" });
    expect(d.versions).toHaveLength(1);
    expect(d.versions![0]!.state.params).toEqual({ height: 30 });
    d = applyOp(d, { type: "save_version", name: "B" });
    expect(() => applyOp(d, { type: "rename_version", name: "A", to: "B" })).toThrow(/already exists/);
    d = applyOp(d, { type: "rename_version", name: "A", to: "C" });
    d = applyOp(d, { type: "delete_version", name: "B" });
    expect(d.versions!.map((v) => v.name)).toEqual(["C"]);
    d = applyOp(d, { type: "delete_version", name: "C" });
    expect(d.versions).toBeUndefined();
    expect(() => applyOp(d, { type: "restore_version", name: "C" })).toThrow(/unknown version/);
  });

  it("keeps an imported file once however many versions share it", () => {
    let d = applyOp(block(), { type: "add_features", features: [scan(1)] });
    d = applyOp(d, { type: "save_version", name: "One" });
    d = applyOp(d, { type: "set_param", name: "height", expr: 25 });
    d = applyOp(d, { type: "save_version", name: "Two" });
    expect(Object.keys(d.blobs!)).toHaveLength(1);
    const size = JSON.stringify(d).length;
    expect(size).toBeLessThan(2 * 10_000 + 5000);
    // Without the import the blob goes once no version needs it.
    d = applyOp(d, { type: "delete_feature", id: "im1" });
    d = applyOp(d, { type: "restore_version", name: "One" });
    expect((d.features.find((f) => f.id === "im1") as Feature & { data: string }).data).toBe("A".repeat(10_000));
    d = applyOp(d, { type: "delete_version", name: "One" });
    d = applyOp(d, { type: "delete_version", name: "Two" });
    expect(d.blobs).toBeUndefined();
  });

  it("tells what changed since a version, and builds the design without the versions", () => {
    let d = applyOp(block(), { type: "add_features", features: [scan(1)] });
    d = applyOp(d, { type: "save_version", name: "Then" });
    d = applyOp(d, { type: "edit_feature", id: "ex1", patch: { distance: 5 } });
    d = applyOp(d, { type: "add_features", features: [{ id: "sk2", op: "sketch", plane: { ref: "origin.XY" }, entities: [], constraints: [] } as Feature] });
    expect(versionChanges(d.versions![0]!.state, d)).toEqual({ added: ["sk2"], removed: [], changed: ["ex1"], other: false });
    d = applyOp(d, { type: "set_param", name: "height", expr: 1 });
    expect(versionChanges(d.versions![0]!.state, d).other).toBe(true);
    expect(designOf(d).versions).toBeUndefined();
    expect(designOf(d).blobs).toBeUndefined();
  });
});
