import { describe, expect, it } from "vitest";
import { applyOp, OpError } from "@meercad/model";
import type { Feature, Joint, MeercadDocument } from "@meercad/schema";
import { circle, rect, sketch } from "./acceptance/helpers.js";

/** Document ops that had no test of their own: rollback, couplings, motions, reference models. */
const feats: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("r", 0, 0, 20, 10), ...circle("c1", 5, 5, 2)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "ex2", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
];
const base = (): MeercadDocument => ({ format: "meercad/1", params: {}, features: structuredClone(feats), rollback: null });
const hinge: Joint = { id: "j1", type: "revolute", a: "ex2", b: "ex1", anchor: { axisOf: { face: "ex2.side[sk1.c1]" } }, limits: [-90, 90] };
const slide: Joint = { id: "j2", type: "slider", a: "ex1", b: "ground", anchor: { axisOf: { face: "ex1.side[sk1.c1]" } } };
const withJoints = () => applyOp(applyOp(base(), { type: "set_joint", joint: hinge }), { type: "set_joint", joint: slide });

describe("document ops", () => {
  it("rolls back to a feature and forward again, and refuses an unknown one", () => {
    const d = applyOp(base(), { type: "set_rollback", id: "ex1" });
    expect(d.rollback).toBe("ex1");
    expect(applyOp(d, { type: "set_rollback", id: null }).rollback).toBeNull();
    expect(() => applyOp(base(), { type: "set_rollback", id: "nope" })).toThrow();
  });

  it("replaces a coupling by id and deletes it", () => {
    let d = applyOp(withJoints(), { type: "set_coupling", coupling: { id: "c1", driver: "j1", driven: "j2", ratio: 1 } });
    d = applyOp(d, { type: "set_coupling", coupling: { id: "c1", driver: "j1", driven: "j2", ratio: 2 } });
    expect(d.mechanism!.couplings).toEqual([{ id: "c1", driver: "j1", driven: "j2", ratio: 2 }]);
    d = applyOp(d, { type: "delete_coupling", id: "c1" });
    expect(d.mechanism!.couplings).toBeUndefined();
    expect(d.mechanism!.joints).toHaveLength(2);
    expect(() => applyOp(d, { type: "delete_coupling", id: "c1" })).toThrow(OpError);
  });

  it("stores a motion with its moments in time order, replaces and deletes it", () => {
    const keys = [
      { at: 2, values: { j1: 90 } },
      { at: 0, values: { j1: 0 } },
      { at: 1, values: { j1: 45 } },
    ];
    let d = applyOp(withJoints(), { type: "set_motion", motion: { id: "m1", duration: 2, keys } });
    expect(d.mechanism!.motions![0]!.keys.map((k) => k.at)).toEqual([0, 1, 2]);
    // The op's own object is not changed (it is cloned).
    expect(keys.map((k) => k.at)).toEqual([2, 0, 1]);
    d = applyOp(d, { type: "set_motion", motion: { id: "m1", duration: 4, loop: true, keys: keys.slice(0, 2) } });
    expect(d.mechanism!.motions).toHaveLength(1);
    expect(d.mechanism!.motions![0]).toMatchObject({ duration: 4, loop: true });
    d = applyOp(d, { type: "delete_motion", id: "m1" });
    expect(d.mechanism!.motions).toBeUndefined();
    expect(() => applyOp(d, { type: "delete_motion", id: "m1" })).toThrow(OpError);
  });

  it("adds, replaces and deletes a reference model", () => {
    const ref = { id: "r1", name: "Scan", format: "glb" as const, data: "AAAA" };
    let d = applyOp(base(), { type: "set_reference", reference: ref });
    d = applyOp(d, { type: "set_reference", reference: { ...ref, name: "Room", hidden: true } });
    expect(d.references).toEqual([{ ...ref, name: "Room", hidden: true }]);
    d = applyOp(applyOp(d, { type: "set_reference", reference: { ...ref, id: "r2" } }), { type: "delete_reference", id: "r1" });
    expect(d.references!.map((r) => r.id)).toEqual(["r2"]);
    d = applyOp(d, { type: "delete_reference", id: "r2" });
    expect(d.references).toBeUndefined();
    expect(() => applyOp(d, { type: "delete_reference", id: "r2" })).toThrow(OpError);
  });
});
