import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@leocad/kernel";
import type { Feature } from "@leocad/schema";
import { circle, corpus, doc, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

/** 20×20×5 base with a Ø`d` × 15 shaft on top (a shoulder at z = 5, a free end at z = 20). */
const shaft = (d: number): Feature[] => [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, d / 2)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 15, mode: "join" },
];
/** 20×20×12 block with a Ø`d` through hole. */
const block = (d: number): Feature[] => [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 20, 20), ...circle("c1", 10, 10, d / 2)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 12, mode: "new_body" },
];

describe("thread", () => {
  it("cuts an external M8 thread on a shaft up to its shoulder", async () => {
    const s = await newSession();
    const plain = s.rebuild(doc(shaft(8))).report;
    const { report, meshes } = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" } }]));
    ok(report);
    const removed = plain.bodies[0]!.volume - report.bodies[0]!.volume;
    // Between the minor and major cross-sections over the 15 mm length (ISO M8: d3 ≈ 6.47).
    expect(removed).toBeGreaterThan(15 * 0.15 * Math.PI * (16 - 3.233 ** 2));
    expect(removed).toBeLessThan(15 * Math.PI * (16 - 3.233 ** 2));
    expect(meshes[0]!.faceTags.flat()).toContain("th1.thread");
    // The base is untouched: the thread stops at the shoulder.
    expect(report.bodies[0]!.bbox.min[2]).toBeCloseTo(0, 4);
    expect(report.bodies[0]!.bbox.max[0] - report.bodies[0]!.bbox.min[0]).toBeCloseTo(20, 3);
  });

  it("threads a hole drawn at the nominal size or at the tap drill size alike", async () => {
    const s = await newSession();
    const thread: Feature = { id: "th1", op: "thread", face: { face: "ex1.side[sk1.c1]" } };
    const nominal = s.rebuild(doc([...block(8), thread])).report;
    const tapDrill = s.rebuild(doc([...block(6.8), thread])).report;
    ok(nominal);
    ok(tapDrill);
    // Both end up as the same M8 internal thread.
    expect(nominal.bodies[0]!.volume).toBeCloseTo(tapDrill.bodies[0]!.volume, 0);
    // More material than the plain Ø8 hole, less than a Ø6.647 (minor) bore.
    const full = 20 * 20 * 12;
    expect(nominal.bodies[0]!.volume).toBeGreaterThan(full - Math.PI * 16 * 12);
    expect(nominal.bodies[0]!.volume).toBeLessThan(full - Math.PI * 3.3235 ** 2 * 12 - 20);
    // Left-handed cuts the same amount.
    const left = s.rebuild(doc([...block(8), { ...thread, leftHanded: true } as Feature])).report;
    ok(left);
    expect(left.bodies[0]!.volume).toBeCloseTo(nominal.bodies[0]!.volume, 0);
  });

  it("supports a shorter length, a fine pitch, left-handed threads and clearance", async () => {
    const s = await newSession();
    const base = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" } }])).report;
    const short = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" }, size: "M8", pitch: 1, length: 6, leftHanded: true }])).report;
    ok(short);
    expect(short.bodies[0]!.volume).toBeGreaterThan(base.bodies[0]!.volume);
    const left = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" }, leftHanded: true }])).report;
    expect(left.bodies[0]!.volume).toBeCloseTo(base.bodies[0]!.volume, 0);
    const loose = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" }, clearance: 0.15 }])).report;
    ok(loose);
    expect(loose.bodies[0]!.volume).toBeLessThan(base.bodies[0]!.volume);
  });

  it("threads countersunk holes and chamfered shafts (stopping at the chamfer)", async () => {
    const s = await newSession();
    const plate = corpus("mounting-plate.leocad.json");
    const holes = s.rebuild({ ...plate, features: [...plate.features, { id: "th1", op: "thread", face: { face: "ex2.side[sk2.h2]" } }, { id: "th2", op: "thread", face: { face: "ex2.side[sk2.h1]" }, clearance: 0.1 }] }).report;
    ok(holes);
    const bolt = s.rebuild(doc([...shaft(8), { id: "ch1", op: "chamfer", edges: { edge: ["ex2.end_cap", "ex2.side[sk2.c1]"] }, distance: 1 }, { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" } }])).report;
    ok(bolt);
  });

  it("explains what is wrong with a flat face or an unknown size", async () => {
    const s = await newSession();
    const flat = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.end_cap" } }])).report;
    expect(flat.features.find((f) => f.id === "th1")?.message).toMatch(/round faces/);
    const bad = s.rebuild(doc([...shaft(8), { id: "th1", op: "thread", face: { face: "ex2.side[sk2.c1]" }, size: "M7" }])).report;
    expect(bad.features.find((f) => f.id === "th1")?.message).toMatch(/give a pitch/);
  });
});
