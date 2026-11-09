import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature, HoleFeature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
/** 40 × 30 × 10 block, top face at z = 10. */
const block: Feature[] = [sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" }];
const hole = (h: Partial<HoleFeature>): HoleFeature => ({ id: "ho1", op: "hole", plane: { face: { face: "ex1.end_cap" } }, points: [[10, 15], [30, 15]], kind: "clearance", size: "M3", ...h });
const PI = Math.PI;
const BLOCK = 40 * 30 * 10;

async function removed(h: Partial<HoleFeature>) {
  const s = await newSession();
  const { report, meshes } = s.rebuild(doc([...block, hole(h)]));
  ok(report);
  expect(report.bodies).toHaveLength(1);
  return { cut: BLOCK - report.bodies[0]!.volume, tags: new Set(meshes[0]!.faceTags.flat()) };
}

describe("hole", () => {
  it("drills clearance holes through, at points on a face", async () => {
    const { cut, tags } = await removed({});
    // ISO 273 medium: Ø3.4 for M3.
    expect(cut).toBeCloseTo(2 * PI * 1.7 ** 2 * 10, 1);
    expect(tags).toContain("ho1.wall");
    const close = await removed({ fit: "close" });
    expect(close.cut).toBeCloseTo(2 * PI * 1.6 ** 2 * 10, 1);
  });

  it("counterbores and countersinks for the screw heads", async () => {
    const cb = await removed({ kind: "counterbore" });
    // Ø6 × 3.4 for the head, Ø3.4 below.
    expect(cb.cut).toBeCloseTo(2 * PI * (3 ** 2 * 3.4 + 1.7 ** 2 * 6.6), 1);
    expect(cb.tags).toContain("ho1.counterbore");
    expect(cb.tags).toContain("ho1.seat");
    const cs = await removed({ kind: "countersink" });
    // 90° cone from Ø7.12 down to Ø3.4 (a frustum), then the bore.
    const R = 7.12 / 2;
    const h = R - 1.7;
    const frustum = (PI * h * (R * R + R * 1.7 + 1.7 * 1.7)) / 3;
    expect(cs.cut).toBeCloseTo(2 * (frustum + PI * 1.7 ** 2 * (10 - h)), 1);
    expect(cs.tags).toContain("ho1.countersink");
  });

  it("makes blind holes for heat-set inserts and simple holes of any size", async () => {
    const ins = await removed({ kind: "insert" });
    // M3 insert: Ø4 × (5.7 + 1).
    expect(ins.cut).toBeCloseTo(2 * PI * 2 ** 2 * 6.7, 1);
    expect(ins.tags).toContain("ho1.bottom");
    const simple = await removed({ kind: "simple", size: undefined, diameter: 5, depth: 4 } as Partial<HoleFeature>);
    expect(simple.cut).toBeCloseTo(2 * PI * 2.5 ** 2 * 4, 1);
    const wide = await removed({ kind: "simple", size: undefined, diameter: 5, allowance: 0.2 } as Partial<HoleFeature>);
    expect(wide.cut).toBeCloseTo(2 * PI * 2.6 ** 2 * 10, 1);
  });

  it("picks the insert's length and places the inserts as parts", async () => {
    // M3 short (4 mm): Ø4 × 5.
    const short = await removed({ kind: "insert", length: 4 });
    expect(short.cut).toBeCloseTo(2 * PI * 2 ** 2 * 5, 1);
    const s = await newSession();
    const { report } = s.rebuild(doc([...block, hole({ kind: "insert", size: "M5", withInserts: true })]));
    expect(report.features.find((f) => f.id === "ho1")).toMatchObject({ status: "ok" });
    const ids = report.bodies.map((b) => b.id).sort();
    expect(ids).toEqual(["ex1", "ho1_insert", "ho1_insert_2"]);
    // M5 × 9.5 in its Ø6.4 hole, around the Ø5 thread, flush with the top.
    const ins = report.bodies.find((b) => b.id === "ho1_insert")!;
    expect(ins.volume).toBeCloseTo(PI * (3.2 ** 2 - 2.5 ** 2) * 9.5, 2);
    expect(ins.bbox.max[2]).toBeCloseTo(10, 6);
    expect(ins.bbox.min[2]).toBeCloseTo(0.5, 6);
    // Hole 6.4 × 10.5 would go through a 10 mm block: it stops at the bottom.
    expect(report.bodies.find((b) => b.id === "ex1")!.volume).toBeCloseTo(BLOCK - 2 * PI * 3.2 ** 2 * 10, 1);
  });

  it("warns where the wall around an insert is too thin", async () => {
    const s = await newSession();
    // M3 needs 1.6 mm around its Ø4 hole: 3.6 mm from the centre to the side.
    const near = s.rebuild(doc([...block, hole({ kind: "insert", points: [[3, 15], [20, 15]] })])).report.features.find((f) => f.id === "ho1")!;
    expect(near.status).toBe("warning");
    expect(near.message).toMatch(/insert 1 is thinner than the 1.6 mm an M3 insert needs/);
    const fine = s.rebuild(doc([...block, hole({ kind: "insert", points: [[4, 15], [20, 15]] })])).report.features.find((f) => f.id === "ho1")!;
    expect(fine.status).toBe("ok");
    // Two inserts too close together share too little wall.
    const pair = s.rebuild(doc([...block, hole({ kind: "insert", points: [[18, 15], [23, 15]] })])).report.features.find((f) => f.id === "ho1")!;
    expect(pair.message).toMatch(/every insert/);
  });

  it("warns where the part is too thin for the insert's length", async () => {
    const s = await newSession();
    const thin: Feature[] = [sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" }];
    const r = s.rebuild(doc([...thin, hole({ kind: "insert", points: [[20, 15]] })])).report.features.find((f) => f.id === "ho1")!;
    expect(r.status).toBe("warning");
    expect(r.message).toMatch(/too thin for the insert: about 4 mm of material, the M3×5.7 insert is 5.7 mm long; use a shorter one \(4 or 3 mm\)/);
    const short = s.rebuild(doc([...thin, hole({ kind: "insert", length: 3, points: [[20, 15]] })])).report.features.find((f) => f.id === "ho1")!;
    expect(short.status).toBe("ok");
  });

  it("threads tapped holes", async () => {
    const t = await removed({ kind: "tapped", depth: 8, points: [[20, 15]] });
    expect(t.tags).toContain("ho1.thread");
    // More than the tap drill (Ø2.5) takes, less than the nominal Ø3.
    expect(t.cut).toBeGreaterThan(PI * 1.25 ** 2 * 8);
    expect(t.cut).toBeLessThan(PI * 1.5 ** 2 * 8);
  });

  it("explains what is wrong", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([...block, hole({ size: "M7" })])).report;
    expect(r.features.find((f) => f.id === "ho1")!.message).toMatch(/unknown size "M7"/);
    const len = s.rebuild(doc([...block, hole({ kind: "insert", length: 7 })])).report;
    expect(len.features.find((f) => f.id === "ho1")!.message).toMatch(/M3 inserts come in 5.7 mm, 4 mm, 3 mm long, not 7 mm/);
    const miss = s.rebuild(doc([...block, hole({ points: [[100, 100]] })])).report;
    expect(miss.features.find((f) => f.id === "ho1")!.message).toMatch(/nothing to cut/);
  });
});
