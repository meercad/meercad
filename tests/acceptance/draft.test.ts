import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const frustum = (a1: number, a2: number, h: number) => (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));
/** 40 × 40 × 20 block standing on XY. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", -20, -20, 40, 40)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];
const sides = ["l1", "l2", "l3", "l4"].map((l) => ({ face: `ex1.side[sk1.${l}]` }));

async function run(features: Feature[]) {
  const s = await newSession();
  return s.rebuild(doc(features)).report;
}

describe("draft", () => {
  it("tilts the side faces inwards from the bottom", async () => {
    const r = await run([...block, { id: "dr1", op: "draft", faces: sides, angle: 5, neutral: { ref: "origin.XY" } }]);
    ok(r);
    // Each side leans in by 20 · tan 5° at the top.
    const top = 40 - 2 * 20 * Math.tan((5 * Math.PI) / 180);
    expect(r.bodies[0]!.volume).toBeCloseTo(frustum(1600, top * top, 20), 2);
    expect(r.bodies[0]!.bbox.max[0]).toBeCloseTo(20, 6);
  });

  it("keeps the top when the neutral plane is the top face, and drafts one face only", async () => {
    const r = await run([...block, { id: "dr1", op: "draft", faces: [sides[0]!], angle: 10, neutral: { face: { face: "ex1.end_cap" } }, flip: true }]);
    ok(r);
    // Pulled downwards, the face leans in towards the bottom: a wedge 20 high, 20 · tan 10° deep, 40 wide comes off.
    const wedge = ((20 * 20 * Math.tan((10 * Math.PI) / 180)) / 2) * 40;
    expect(r.bodies[0]!.volume).toBeCloseTo(32000 - wedge, 2);
    expect(r.bodies[0]!.bbox.max[2]).toBeCloseTo(20, 6);
  });

  it("explains what is wrong", async () => {
    const r = await run([...block, { id: "dr1", op: "draft", faces: sides, angle: 50, neutral: { ref: "origin.XY" } }]);
    expect(status(r, "dr1").message).toMatch(/between 0 and 45/);
  });
});
