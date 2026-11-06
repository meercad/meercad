import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import { validateDocument, type StandardPartFeature } from "@meercad/schema";
import { applyOp, withMotion } from "@meercad/model";
import { doc, newSession } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const part = (p: Partial<StandardPartFeature>): StandardPartFeature => ({ id: "np1", op: "standard_part", kind: "profile", plane: { ref: "origin.XY" }, points: [[0, 0]], ...p });
const size = (r: RebuildReport, id: string) => {
  const b = r.bodies.find((x) => x.id === id)!;
  return b.bbox.max.map((v, i) => +(v - b.bbox.min[i]!).toFixed(3));
};
async function build(p: Partial<StandardPartFeature>) {
  const { report } = (await newSession()).rebuild(doc([part(p)]), { mesh: false });
  ok(report);
  return report;
}

describe("aluminium profiles and their parts", () => {
  it("cuts a 2020 profile to length, with four slots and a centre bore", async () => {
    const r = await build({ kind: "profile", size: "2020", length: 100 });
    expect(r.bodies).toHaveLength(1);
    expect(size(r, "np1")).toEqual([20, 20, 100]);
    // Real 2020 profiles weigh about 0.5 kg/m in aluminium: some 180 mm² of section.
    const area = r.bodies[0]!.volume / 100;
    expect(area).toBeGreaterThan(150);
    expect(area).toBeLessThan(260);
    // Slots: 4 openings, each with its cavity, plus the bore: far more faces than a square bar.
    expect(r.bodies[0]!.faces).toBeGreaterThan(20);
  });

  it("makes 2040, 3030 and 4040 profiles to their sizes", async () => {
    expect(size(await build({ kind: "profile", size: "2040", length: 50 }), "np1")).toEqual([40, 20, 50]);
    expect(size(await build({ kind: "profile", size: "3030", length: 50 }), "np1")).toEqual([30, 30, 50]);
    expect(size(await build({ kind: "profile", size: "4040", length: 50 }), "np1")).toEqual([40, 40, 50]);
  });

  it("lays a corner bracket on the face along u, legs 20 mm, holes in both", async () => {
    const r = await build({ kind: "corner_bracket", size: "2020" });
    expect(size(r, "np1")).toEqual([20, 20, 20]);
    const t = 3, leg = 20, hole = 5.5;
    expect(r.bodies[0]!.volume).toBeCloseTo((leg * t + (leg - t) * t) * 20 - 2 * Math.PI * (hole / 2) ** 2 * t, 0);
  });

  it("puts a T-nut into the slot under the face", async () => {
    const r = await build({ kind: "t_nut", size: "M5-6" });
    const b = r.bodies[0]!;
    expect(b.bbox.max[2]).toBeCloseTo(0, 6);
    expect(b.bbox.min[2]).toBeCloseTo(-5.3, 6);
  });
});

describe("linear motion parts", () => {
  it("makes linear bearings and shafts", async () => {
    const lm = await build({ kind: "linear_bearing", size: "LM8UU" });
    expect(lm.bodies[0]!.volume).toBeCloseTo(Math.PI * (7.5 ** 2 - 4 ** 2) * 24, 0);
    const sh = await build({ kind: "shaft", size: "8", length: 300 });
    expect(sh.bodies[0]!.volume).toBeCloseTo(Math.PI * 16 * 300, 0);
  });

  it("makes a rail with counterbored holes at its pitch, and its carriage as a part of its own", async () => {
    const r = await build({ kind: "rail", size: "MGN12", length: 200, withMoving: true });
    expect(r.bodies.map((b) => b.id).sort()).toEqual(["np1", "np1_carriage"]);
    expect(size(r, "np1")).toEqual([200, 12, 8]);
    expect(size(r, "np1_carriage")).toEqual([34.7, 27, 10]);
    // The carriage clears the rail: no overlap.
    const rail = r.bodies.find((b) => b.id === "np1")!;
    expect(rail.volume).toBeLessThan(200 * 12 * 8);
  });

  it("turns a rail in the plane by its angle", async () => {
    const r = await build({ kind: "rail", size: "MGN9", length: 100, angle: 90 });
    expect(size(r, "np1")).toEqual([9, 100, 6.5]);
  });

  it("makes a lead screw with its flanged nut", async () => {
    const r = await build({ kind: "lead_screw", size: "Tr8x8", length: 250, withMoving: true });
    expect(r.bodies.map((b) => b.id).sort()).toEqual(["np1", "np1_nut"]);
    expect(size(r, "np1")).toEqual([8, 8, 250]);
    expect(size(r, "np1_nut")).toEqual([22, 22, 15]);
  });
});

describe("moving parts get their joints", () => {
  const motionDoc = (p: Partial<StandardPartFeature>) => {
    const f = part(p);
    const base = doc([]);
    return withMotion([{ type: "add_features", features: [f] }], base).reduce((d, op) => applyOp(d, op), base);
  };

  it("slides a rail's carriage along the rail, as far as the rail goes", async () => {
    const d = motionDoc({ kind: "rail", size: "MGN12", length: 200, withMoving: true });
    expect(validateDocument(d).ok).toBe(true);
    expect(d.mechanism?.joints).toEqual([expect.objectContaining({ id: "j_np1_carriage", type: "slider", a: "np1_carriage", b: "np1", limits: [0, 165.3] })]);
    const { report } = (await newSession()).rebuild(d, { mesh: false });
    ok(report);
    const j = report.joints.find((x) => x.id === "j_np1_carriage")!;
    expect(j.error).toBeUndefined();
    // Along the rail (x), not across it.
    expect(Math.abs(j.axis![0])).toBeCloseTo(1, 6);
  });

  it("turns a lead screw and couples its nut by the lead", async () => {
    const d = motionDoc({ kind: "lead_screw", size: "Tr8x2", length: "spindle", withMoving: true });
    d.params = { spindle: "300 mm" };
    expect(validateDocument(d).ok).toBe(true);
    expect(d.mechanism?.joints.map((j) => [j.id, j.type, j.a])).toEqual([["j_np1", "revolute", "np1"], ["j_np1_nut", "slider", "np1_nut"]]);
    expect(d.mechanism?.joints[1]!.limits).toEqual([0, "(spindle) - 15 mm"]);
    // 2 mm per turn.
    expect(d.mechanism?.couplings).toEqual([expect.objectContaining({ driver: "j_np1", driven: "j_np1_nut", ratio: 2 / 360 })]);
    const { report } = (await newSession()).rebuild(d, { mesh: false });
    ok(report);
    for (const j of report.joints) {
      expect(j.error, j.id).toBeUndefined();
      expect(Math.abs(j.axis![2])).toBeCloseTo(1, 6);
    }
  });

  it("takes the joints away again when the moving part is switched off", () => {
    const d = motionDoc({ kind: "lead_screw", size: "Tr8x8", withMoving: true });
    const off = withMotion([{ type: "edit_feature", id: "np1", patch: { withMoving: null } }], d).reduce((x, op) => applyOp(x, op), d);
    expect(off.mechanism?.joints ?? []).toEqual([]);
    expect(off.mechanism?.couplings ?? []).toEqual([]);
  });
});
