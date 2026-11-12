/**
 * Every document change (op) by what it does to the document, and what it refuses, plus the undo
 * history: a change that cannot be made leaves the design exactly as it was.
 */
import { describe, expect, it } from "vitest";
import { CABLES_ENABLED, type Feature, type MeercadDocument } from "@meercad/schema";
import { applyOp, DocumentStore, nextFeatureId, OpError } from "./store.js";

const sketch = (id: string): Feature =>
  ({ id, op: "sketch", plane: { ref: "origin.XY" }, entities: [{ id: "p1", type: "point", x: 0, y: 0 }, { id: "p2", type: "point", x: 5, y: 0 }, { id: "l1", type: "line", p1: "p1", p2: "p2" }], constraints: [{ id: "c1", type: "length", line: "l1", value: "w" }] }) as Feature;
const extrude = (id: string, sk: string, distance: string | number = "w"): Feature => ({ id, op: "extrude", profile: { sketch: sk }, extent: "blind", distance, mode: "new_body" }) as Feature;
const base = (): MeercadDocument => ({ format: "meercad/1", params: { w: "5 mm", h: "w * 2" }, features: [sketch("sk1"), extrude("ex1", "sk1"), extrude("ex2", "sk1", "h")], rollback: null });
const ids = (d: MeercadDocument) => d.features.map((f) => f.id);
const refuses = (d: MeercadDocument, op: unknown, msg: RegExp) => expect(() => applyOp(d, op)).toThrow(msg);

describe("steps", () => {
  it("adds at the end, after a given step, at the start, or after the rollback point", () => {
    const d = base();
    expect(ids(applyOp(d, { type: "add_features", features: [extrude("ex3", "sk1", 1)] }))).toEqual(["sk1", "ex1", "ex2", "ex3"]);
    expect(ids(applyOp(d, { type: "add_features", after: "ex1", features: [extrude("ex3", "sk1", 1)] }))).toEqual(["sk1", "ex1", "ex3", "ex2"]);
    expect(ids(applyOp(d, { type: "add_features", after: null, features: [sketch("sk0")] }))).toEqual(["sk0", "sk1", "ex1", "ex2"]);
    const rolled = applyOp(d, { type: "set_rollback", id: "ex1" });
    const added = applyOp(rolled, { type: "add_features", features: [extrude("ex3", "sk1", 1)] });
    expect(ids(added)).toEqual(["sk1", "ex1", "ex3", "ex2"]);
    expect(added.rollback).toBe("ex3");
  });

  it("refuses steps paused in this version", () => {
    if (CABLES_ENABLED) return;
    refuses(base(), { type: "add_features", features: [{ id: "cab1", op: "cable", points: [{ at: [0, 0, 0] }, { at: [10, 0, 0] }], diameter: 2 }] }, /cable steps are not available/);
  });

  it("edits a step, removes fields set to null, and never changes its id", () => {
    const d = applyOp(base(), { type: "edit_feature", id: "ex1", patch: { distance: 7, flip: true } });
    expect(d.features[1]).toMatchObject({ distance: 7, flip: true });
    const back = applyOp(d, { type: "edit_feature", id: "ex1", patch: { flip: null } });
    expect("flip" in back.features[1]!).toBe(false);
    refuses(d, { type: "edit_feature", id: "ex1", patch: { id: "zz" } }, /cannot change a feature id/);
    refuses(d, { type: "edit_feature", id: "nope", patch: { distance: 1 } }, /unknown feature "nope"/);
  });

  it("deleting the rollback step moves the rollback point to the step before", () => {
    const d = applyOp(applyOp(base(), { type: "set_rollback", id: "ex1" }), { type: "delete_feature", id: "ex1" });
    expect(d.rollback).toBe("sk1");
    expect(ids(d)).toEqual(["sk1", "ex2"]);
  });

  it("moves a step after another or to the start", () => {
    expect(ids(applyOp(base(), { type: "move_feature", id: "ex2", after: "sk1" }))).toEqual(["sk1", "ex2", "ex1"]);
    // Moved before its sketch, a step would refer to a later one: refused, nothing changes.
    refuses(base(), { type: "move_feature", id: "ex1", after: null }, /unknown or later feature "sk1"/);
  });

  it("refuses a rollback to a step that does not exist", () => {
    refuses(base(), { type: "set_rollback", id: "nope" }, /unknown feature/);
    expect(applyOp(applyOp(base(), { type: "set_rollback", id: "ex1" }), { type: "set_rollback", id: null }).rollback).toBeNull();
  });
});

describe("variables", () => {
  it("renames a variable in formulas, steps, sketch dimensions, variants, joints and the fit", () => {
    let d = base();
    d = applyOp(d, { type: "set_param", name: "a", expr: "w + 1", auto: true });
    d = applyOp(d, { type: "set_variant", name: "big", params: { w: "9 mm" } });
    d = applyOp(d, { type: "set_fit", fit: "w / 50" });
    d = { ...d, mechanism: { joints: [{ id: "j1", type: "slider", a: "ex1", b: "ex2", anchor: { axis: { ref: "origin.X" } }, limits: [0, "w"] }, { id: "j2", type: "revolute", a: "ex2", b: "ground", anchor: { axis: { ref: "origin.Z" } } }], couplings: [{ id: "k1", driver: "j1", driven: "j2", ratio: "w" }], clearance: "w / 10" } } as MeercadDocument;
    const r = applyOp(d, { type: "rename_param", name: "w", to: "width" });
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/\bw\b(?![a-z])/);
    expect(r.params).toMatchObject({ width: "5 mm", h: "width * 2", a: "width + 1" });
    expect(r.variants![0]!.params).toEqual({ width: "9 mm" });
    expect(r.fit).toBe("width / 50");
    expect(r.mechanism!.joints[0]!.limits).toEqual([0, "width"]);
    expect((r.features[0] as Extract<Feature, { op: "sketch" }>).constraints[0]).toMatchObject({ value: "width" });
  });

  it("refuses renaming to a name in use, from an unknown one, or to the fit", () => {
    refuses(base(), { type: "rename_param", name: "w", to: "h" }, /already exists/);
    refuses(base(), { type: "rename_param", name: "nope", to: "x" }, /unknown parameter/);
    refuses(base(), { type: "rename_param", name: "w", to: "fit" }, /design's fit/);
    refuses(base(), { type: "set_param", name: "fit", expr: "0.2" }, /set it with set_fit/);
  });

  it("deleting a variable also takes it out of variants and the automatic list", () => {
    let d = applyOp(base(), { type: "set_param", name: "x", expr: 3, auto: true });
    d = applyOp(d, { type: "set_variant", name: "v", params: { x: 4 } });
    expect(d.autoParams).toEqual(["x"]);
    d = applyOp(d, { type: "set_param", name: "x", expr: null });
    expect(d.params["x"]).toBeUndefined();
    expect(d.variants![0]!.params).toEqual({});
    expect(d.autoParams).toBeUndefined();
  });
});

describe("variants and versions", () => {
  it("renames, uses and deletes variants, and refuses names in use or unknown", () => {
    let d = applyOp(base(), { type: "set_variant", name: "A", params: { w: 6 } });
    d = applyOp(d, { type: "set_variant", name: "B", params: { w: 7 } });
    d = applyOp(d, { type: "use_variant", name: "A" });
    refuses(d, { type: "set_variant", name: "A", rename: "B", params: {} }, /already exists/);
    d = applyOp(d, { type: "set_variant", name: "A", rename: "C", params: { w: 6 } });
    expect(d.variant).toBe("C");
    refuses(d, { type: "use_variant", name: "zz" }, /unknown variant/);
    refuses(d, { type: "delete_variant", name: "zz" }, /unknown variant/);
    d = applyOp(d, { type: "delete_variant", name: "C" });
    expect(d.variant).toBeUndefined();
    d = applyOp(d, { type: "delete_variant", name: "B" });
    expect(d.variants).toBeUndefined();
    expect(applyOp(applyOp(base(), { type: "set_variant", name: "A", params: {} }), { type: "use_variant", name: null }).variant).toBeUndefined();
  });

  it("saves, renames, restores and deletes versions", () => {
    let d = applyOp(base(), { type: "save_version", name: "v1", at: 1 });
    d = applyOp(d, { type: "set_param", name: "w", expr: "8 mm" });
    refuses(d, { type: "rename_version", name: "zz", to: "x" }, /unknown version/);
    d = applyOp(d, { type: "save_version", name: "v2", at: 2 });
    refuses(d, { type: "rename_version", name: "v1", to: "v2" }, /already exists/);
    d = applyOp(d, { type: "rename_version", name: "v1", to: "first" });
    const r = applyOp(d, { type: "restore_version", name: "first" });
    expect(r.params["w"]).toBe("5 mm");
    refuses(d, { type: "restore_version", name: "zz" }, /unknown version/);
    refuses(d, { type: "delete_version", name: "zz" }, /unknown version/);
    d = applyOp(applyOp(d, { type: "delete_version", name: "first" }), { type: "delete_version", name: "v2" });
    expect(d.versions).toBeUndefined();
  });
});

describe("parts and joints", () => {
  it("colours, see-through, part list, fit and units, set and cleared again", () => {
    let d = applyOp(base(), { type: "set_part_color", part: "ex1", color: "#AABBCC" });
    expect(d.partColors).toEqual({ ex1: "#aabbcc" });
    d = applyOp(d, { type: "set_part_color", part: "ex1", color: null });
    expect(d.partColors).toBeUndefined();
    d = applyOp(d, { type: "set_see_through", parts: ["ex1", "ex2"], on: true });
    d = applyOp(d, { type: "set_see_through", parts: ["ex1", "ex2"], on: false });
    expect(d.seeThrough).toBeUndefined();
    d = applyOp(d, { type: "set_part_list", groups: [{ name: "Box", parts: ["ex1"] }], order: ["ex2", "ex1"] });
    expect(d.partOrder).toEqual(["ex2", "ex1"]);
    d = applyOp(d, { type: "set_part_list", groups: [], order: [] });
    expect(d.partGroups).toBeUndefined();
    expect(d.partOrder).toBeUndefined();
    d = applyOp(applyOp(d, { type: "set_fit", fit: 0.3 }), { type: "set_units", units: "in" });
    expect([d.fit, d.units]).toEqual([0.3, "in"]);
    d = applyOp(applyOp(d, { type: "set_fit", fit: null }), { type: "set_units", units: "mm" });
    expect([d.fit, d.units]).toEqual([undefined, undefined]);
  });

  it("deleting a joint takes its couplings and its moments in motions with it", () => {
    let d = applyOp(base(), { type: "set_joint", joint: { id: "j1", type: "revolute", a: "ex1", b: "ground", anchor: { axis: { ref: "origin.Z" } } } });
    d = applyOp(d, { type: "set_joint", joint: { id: "j2", type: "revolute", a: "ex2", b: "ground", anchor: { axis: { ref: "origin.Z" } } } });
    d = applyOp(d, { type: "set_joint", joint: { id: "j2", type: "slider", a: "ex2", b: "ground", anchor: { axis: { ref: "origin.X" } } } });
    expect(d.mechanism!.joints[1]!.type).toBe("slider");
    d = applyOp(d, { type: "set_coupling", coupling: { id: "k1", driver: "j1", driven: "j2", ratio: 2 } });
    d = applyOp(d, { type: "set_motion", motion: { id: "m1", duration: 2, keys: [{ at: 0, values: { j1: 0, j2: 0 } }, { at: 2, values: { j1: 90, j2: 10 } }] } });
    d = applyOp(d, { type: "delete_joint", id: "j1" });
    expect(d.mechanism!.couplings ?? []).toEqual([]);
    expect(d.mechanism!.motions![0]!.keys.map((k) => Object.keys(k.values))).toEqual([["j2"], ["j2"]]);
    refuses(d, { type: "delete_joint", id: "zz" }, /unknown joint/);
  });
});

describe("undo history", () => {
  it("undoes and redoes, amends the last step in place, and tells listeners", () => {
    const s = new DocumentStore(base());
    const seen: number[] = [];
    const off = s.subscribe((d) => seen.push(d.features.length));
    expect([s.canUndo, s.canRedo]).toEqual([false, false]);
    s.undo();
    s.redo();
    s.apply({ type: "add_features", features: [extrude("ex3", "sk1", 1)] });
    s.amend({ type: "edit_feature", id: "ex3", patch: { distance: 2 } });
    s.amend({ type: "edit_feature", id: "ex3", patch: { distance: 3 } });
    expect((s.doc.features[3] as { distance: number }).distance).toBe(3);
    s.undo();
    expect(s.doc.features).toHaveLength(3);
    expect(s.canRedo).toBe(true);
    s.redo();
    expect((s.doc.features[3] as { distance: number }).distance).toBe(3);
    off();
    s.undo();
    expect(seen).toEqual([4, 4, 4, 3, 4]);
    // A failing change leaves the history alone.
    const before = s.doc;
    expect(() => s.apply({ type: "delete_feature", id: "nope" })).toThrow(OpError);
    expect(s.doc).toBe(before);
    // Amending with nothing to amend is a new step.
    const fresh = new DocumentStore(base());
    fresh.amend({ type: "set_param", name: "w", expr: 6 });
    expect(fresh.canUndo).toBe(true);
  });

  it("gives every kind of step a free id of its own", () => {
    const ops = ["sketch", "primitive", "plane", "extrude", "revolve", "fillet", "chamfer", "shell", "thread", "gear", "coil", "spring", "screw", "cable", "linear_pattern", "circular_pattern", "mirror", "boolean", "transform", "delete", "import", "mesh_convert", "bend", "hole", "loft", "split", "rib", "draft", "offset_face", "text", "standard_part", "gridfinity", "label", "box", "snap_hook", "wall", "lithophane", "align", "scale", "sweep"] as const;
    for (const op of ops) expect(nextFeatureId(base(), op), op).toMatch(/^[a-z]+\d+$/);
    expect(nextFeatureId(base(), "extrude")).toBe("ex3");
    expect(nextFeatureId(base(), "sketch")).toBe("sk2");
  });
});
