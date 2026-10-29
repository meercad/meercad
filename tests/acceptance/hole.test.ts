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
    const miss = s.rebuild(doc([...block, hole({ points: [[100, 100]] })])).report;
    expect(miss.features.find((f) => f.id === "ho1")!.message).toMatch(/nothing to cut/);
  });
});
