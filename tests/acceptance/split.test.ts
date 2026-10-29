import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const PI = Math.PI;
/** 100 × 40 × 20 bar along x with a Ø10 hole through it at x = 30. */
const bar: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 100, 40), ...circle("h", 30, 20, 5)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];
const at60: Feature = { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 60 };
const BAR = 100 * 40 * 20 - PI * 25 * 20;

async function run(features: Feature[]) {
  const s = await newSession();
  return s.rebuild(doc(features)).report;
}
const vol = (r: RebuildReport, id: string) => r.bodies.find((b) => b.id === id)?.volume;

describe("split", () => {
  it("cuts a part in two at a plane; the front piece keeps the part's id", async () => {
    const r = await run([...bar, at60, { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"] }]);
    ok(r);
    expect(r.bodies.map((b) => b.id).sort()).toEqual(["ex1", "sp1"]);
    // The YZ plane's normal is +x: the piece beyond x = 60 keeps the id.
    expect(vol(r, "ex1")).toBeCloseTo(40 * 40 * 20, 3);
    expect(vol(r, "sp1")).toBeCloseTo(60 * 40 * 20 - PI * 25 * 20, 3);
    expect(r.bodies.find((b) => b.id === "ex1")!.bbox.min[0]).toBeCloseTo(60, 6);
  });

  it("keeps one side only, and tags the cut face", async () => {
    const s = await newSession();
    const { report, meshes } = s.rebuild(doc([...bar, at60, { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: [], keep: "back" }]));
    ok(report);
    expect(report.bodies.map((b) => b.id)).toEqual(["ex1"]);
    expect(vol(report, "ex1")).toBeCloseTo(60 * 40 * 20 - PI * 25 * 20, 3);
    expect(meshes[0]!.faceTags.flat()).toContain("sp1.cut");
  });

  it("splits at a face of another part", async () => {
    const r = await run([
      ...bar,
      sketch("sk2", { ref: "origin.XY" }, rect("m", 0, 50, 10, 10)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 8, mode: "new_body" },
      // The top of the small block (z = 8) cuts the bar.
      { id: "sp1", op: "split", plane: { face: { face: "ex2.end_cap" } }, bodies: ["ex1"] },
    ]);
    ok(r);
    expect(vol(r, "ex1")! + vol(r, "sp1")!).toBeCloseTo(BAR, 3);
    expect(vol(r, "sp1")).toBeCloseTo((BAR / 20) * 8, 3);
  });

  it("explains what is wrong", async () => {
    const r = await run([...bar, { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 150 }, { id: "sp1", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"] }]);
    expect(status(r, "sp1").message).toMatch(/does not cross/);
  });
});
