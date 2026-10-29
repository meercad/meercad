import { describe, expect, it } from "vitest";
import { applyOp, motion } from "@meercad/model";
import { validateDocument, type Feature, type Joint, type MeercadDocument } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

/** A 40 × 20 × 5 base and a 30 × 10 × 3 lever on top, pinned through a Ø5 hole at the origin. */
const hinge: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", -20, -10, 40, 20)),
  { id: "ex1", op: "extrude", name: "Base", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 5 },
  sketch("sk2", { ref: "pl1" }, [...rect("m", -5, -5, 30, 10), ...circle("c1", 0, 0, 2.5)]),
  { id: "ex2", op: "extrude", name: "Lever", profile: { sketch: "sk2" }, extent: "blind", distance: 3, mode: "new_body" },
];
const pin: Joint = { id: "j1", type: "revolute", a: "ex2", b: "ex1", anchor: { axisOf: { face: "ex2.side[sk2.c1]" } }, limits: [-90, 90] };
const withJoints = (features: Feature[], joints: Joint[], couplings: { id: string; driver: string; driven: string; ratio: number }[] = []): MeercadDocument => ({ ...doc(features), mechanism: { joints, couplings } });

const near = (a: number[], b: number[], tol = 1e-6) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, -Math.log10(tol)));

describe("joints", () => {
  it("finds a joint's axis in a hole and turns the part about it", async () => {
    const s = await newSession();
    const { report } = s.rebuild(withJoints(hinge, [pin]));
    const f = report.joints[0]!;
    expect(f.error).toBeUndefined();
    near(f.origin, [0, 0, 6.5]);
    expect(Math.abs(f.axis[2])).toBeCloseTo(1, 9);
    const m = new motion.Mechanism([{ ...pin, limits: [-90, 90], origin: f.origin, axis: f.axis }]);
    const values = m.values({ j1: 120 });
    // Held at the limit.
    expect(values["j1"]).toBe(90);
    const pose = m.poses(values).get("ex2")!;
    const tip = motion.transformPoint(pose, [25, 0, 6.5]);
    // A quarter turn about ±Z: the lever's end swings onto the Y axis, 25 mm out.
    expect(Math.hypot(tip[0], tip[1])).toBeCloseTo(25, 9);
    expect(tip[0]).toBeCloseTo(0, 9);
    near(motion.transformPoint(pose, [0, 0, 6.5]), [0, 0, 6.5]);
    // The base does not move.
    expect(m.poses(values).has("ex1")).toBe(false);
  });

  it("follows the model when the hole moves, and says when it is gone", async () => {
    const s = await newSession();
    const moved = hinge.map((f) => (f.id === "sk2" ? sketch("sk2", { ref: "pl1" }, [...rect("m", -5, -5, 30, 10), ...circle("c1", 4, 0, 2.5)]) : f));
    near(s.rebuild(withJoints(moved, [pin])).report.joints[0]!.origin, [4, 0, 6.5]);
    const gone = hinge.map((f) => (f.id === "sk2" ? sketch("sk2", { ref: "pl1" }, rect("m", -5, -5, 30, 10)) : f));
    expect(s.rebuild(withJoints(gone, [pin])).report.joints[0]!.error).toMatch(/no face tagged/);
  });

  it("slides along an edge and keeps coupled gears in step", async () => {
    const s = await newSession();
    const slide: Joint = { id: "j1", type: "slider", a: "ex2", b: "ground", anchor: { edge: { edge: ["ex1.side[sk1.l1]", "ex1.end_cap"] } }, limits: [0, 15] };
    const f = s.rebuild(withJoints(hinge, [slide])).report.joints[0]!;
    expect(f.error).toBeUndefined();
    expect(Math.abs(f.axis[0])).toBeCloseTo(1, 9);
    const m = new motion.Mechanism([{ ...slide, limits: [0, 15], origin: f.origin, axis: f.axis }]);
    const p = motion.transformPoint(m.poses(m.values({ j1: 40 })).get("ex2")!, [0, 0, 0]);
    expect(Math.abs(p[0])).toBeCloseTo(15, 9);

    // Two gears turning on their axes, coupled by their teeth.
    const gears: Feature[] = [
      { id: "gr1", op: "gear", kind: "spur", module: 1, teeth: 20, width: 5, mode: "new_body" },
      { id: "gr2", op: "gear", kind: "spur", teeth: 40, width: 5, meshWith: { gear: "gr1" }, mode: "new_body" },
    ];
    const joints: Joint[] = [
      { id: "j1", type: "revolute", a: "gr1", b: "ground", anchor: { gear: "gr1" } },
      { id: "j2", type: "revolute", a: "gr2", b: "ground", anchor: { gear: "gr2" } },
    ];
    const r = s.rebuild(withJoints(gears, joints, [{ id: "c1", driver: "j1", driven: "j2", ratio: -0.5 }])).report;
    expect(r.gears.map((g) => [g.id, g.teeth, g.radius, g.meshWith])).toEqual([
      ["gr1", 20, 10, undefined],
      ["gr2", 40, 20, "gr1"],
    ]);
    near(r.joints[1]!.origin, [30, 0, 2.5]);
    const gm = new motion.Mechanism(
      joints.map((j, i) => ({ id: j.id, type: j.type, a: j.a, b: j.b, origin: r.joints[i]!.origin, axis: r.joints[i]!.axis })),
      [{ driver: "j1", driven: "j2", ratio: -0.5 }],
    );
    // Ten turns of the pinion: the big gear turns five the other way, without drift.
    expect(gm.values({ j1: 3600 })["j2"]).toBeCloseTo(-1800, 9);
    // Dragging the driven gear moves its driver.
    expect(gm.rootValueFor("j2", 90)).toEqual({ root: "j1", value: -180 });
  });

  it("checks joints and couplings in the document", () => {
    const d = withJoints(hinge, [pin, { ...pin, id: "j2" }]);
    expect(validateDocument(d).ok).toBe(false);
    expect(validateDocument(withJoints(hinge, [pin], [{ id: "c1", driver: "j1", driven: "j9", ratio: 1 }])).ok).toBe(false);
    let next = applyOp(doc(hinge), { type: "set_joint", joint: pin });
    next = applyOp(next, { type: "set_joint", joint: { ...pin, id: "j2", a: "ex1", b: "ground", type: "fixed" } });
    next = applyOp(next, { type: "set_coupling", coupling: { id: "c1", driver: "j1", driven: "j2", ratio: 1 } });
    expect(next.mechanism!.joints).toHaveLength(2);
    next = applyOp(next, { type: "delete_joint", id: "j2" });
    expect(next.mechanism!.couplings ?? []).toEqual([]);
    next = applyOp(next, { type: "delete_joint", id: "j1" });
    expect(next.mechanism).toBeUndefined();
  });
});
