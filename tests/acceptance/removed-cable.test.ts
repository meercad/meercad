/**
 * Designs made while meerCAD had cables (removed Nov 2026) still open: the cable steps are left out
 * on load and on rebuild, and everything that named a cable lets go of it, so the rest builds as
 * before. The design here is written in the test; no real design file is touched.
 */
import { describe, expect, it } from "vitest";
import { applyOp, OpError } from "@meercad/model";
import { validateDocument, withoutRemovedFeatures, type Feature, type MeercadDocument } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", -30, -20, 60, 40)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
/** Cable steps as earlier versions wrote them: a round one fixed to the block, a ribbon with plugs. */
const cab1 = { id: "cab1", op: "cable", points: [{ at: [0, 0, 10], on: "ex1" }, { at: [60, 0, 30] }], diameter: 2, material: "pvc" } as unknown as Feature;
const cab2 = { id: "cab2", op: "cable", shape: "ribbon", points: [{ at: [0, 0, 0] }, { at: [50, 0, 0] }], start: { kind: "idc" } } as unknown as Feature;

/** A design that names the cables everywhere a part could be named. */
function oldDesign(rollback: string | null = null): MeercadDocument {
  return {
    ...doc([
      ...block,
      cab1,
      cab2,
      { id: "mv1", op: "transform", bodies: ["ex1", "cab1"], translate: [0, 0, 5] },
      { id: "mv2", op: "transform", bodies: ["cab2"], translate: [1, 0, 0] },
      { id: "lp1", op: "linear_pattern", source: { bodies: ["cab1"] }, direction: { ref: "origin.X" }, count: 2, spacing: 10 },
      { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }], radius: 3 },
    ]),
    rollback,
    partColors: { ex1: "#ff0000", cab1: "#000000", lp1_2: "#00ff00" },
    partMaterials: { ex1: "pla", cab2: "pvc" },
    partOrder: ["cab1", "ex1"],
    seeThrough: ["cab2"],
    partGroups: [{ name: "Wiring", parts: ["cab1", "cab2"] }],
    mechanism: {
      joints: [
        { id: "j1", type: "revolute", a: "ex1", b: "ground", anchor: { axis: { ref: "origin.Z" } } },
        { id: "j2", type: "fixed", a: "cab1", b: "ex1", anchor: { axis: { ref: "origin.Z" } } },
      ],
      couplings: [{ id: "c1", driver: "j1", driven: "j2", ratio: 1 }],
      motions: [{ id: "m1", duration: 1, keys: [{ at: 0, values: { j1: 0, j2: 0 } }] }],
    },
  } as MeercadDocument;
}

describe("files with the removed cables", () => {
  it("open without them: the cables and what only worked on them go, the rest stays", () => {
    const v = validateDocument(JSON.parse(JSON.stringify(oldDesign())));
    expect(v.ok ? [] : v.errors).toEqual([]);
    if (!v.ok) return;
    const d = v.value;
    expect(d.features.map((f) => f.id)).toEqual(["sk1", "ex1", "mv1", "fi1"]);
    expect(d.features.find((f) => f.id === "mv1")).toMatchObject({ bodies: ["ex1"] });
    expect(d.partColors).toEqual({ ex1: "#ff0000" });
    expect(d.partMaterials).toEqual({ ex1: "pla" });
    expect(d.partOrder).toEqual(["ex1"]);
    expect(d.seeThrough).toEqual([]);
    expect(d.partGroups).toEqual([{ name: "Wiring", parts: [] }]);
    expect(d.mechanism).toEqual({
      joints: [{ id: "j1", type: "revolute", a: "ex1", b: "ground", anchor: { axis: { ref: "origin.Z" } } }],
      couplings: [],
      motions: [{ id: "m1", duration: 1, keys: [{ at: 0, values: { j1: 0 } }] }],
    });
  });

  it("move a rollback on a dropped step back to the step before", () => {
    expect(withoutRemovedFeatures(oldDesign("cab2"))).toMatchObject({ removed: ["cab1", "cab2", "mv2", "lp1"], doc: { rollback: "ex1" } });
    expect(withoutRemovedFeatures(oldDesign("lp1")).doc.rollback).toBe("mv1");
    expect(withoutRemovedFeatures(oldDesign("fi1")).doc.rollback).toBe("fi1");
    const plain = doc(block);
    expect(withoutRemovedFeatures(plain)).toEqual({ doc: plain, removed: [] });
    expect(withoutRemovedFeatures("not a design")).toEqual({ doc: "not a design", removed: [] });
  });

  it("rebuild as the design without cables did, even when the steps reach the kernel", async () => {
    const plain = (await newSession()).rebuild({ ...doc([...block, { id: "mv1", op: "transform", bodies: ["ex1"], translate: [0, 0, 5] }, { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }], radius: 3 }]) });
    const r = (await newSession()).rebuild(oldDesign());
    expect(r.report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    expect(r.report.features.map((f) => f.id)).toEqual(["sk1", "ex1", "mv1", "fi1"]);
    expect(r.report.bodies.map((b) => b.id)).toEqual(["ex1"]);
    expect(r.report.bodies[0]!.volume).toBeCloseTo(plain.report.bodies[0]!.volume, 6);
    expect(r.report.bodies[0]!.bbox.min[2]).toBeCloseTo(5, 6);
  });

  it("are no step any more: a new cable is refused", () => {
    expect(() => applyOp(doc(block), { type: "add_features", features: [cab1] })).toThrow(OpError);
  });
});
