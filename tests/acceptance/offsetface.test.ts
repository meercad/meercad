import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
/** 40 × 40 × 20 block standing on XY with a 10 mm hole through the middle. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", -20, -20, 40, 40), ...circle("h", 0, 0, 5)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];
const SOLID = 32000 - Math.PI * 25 * 20;

async function build(features: Feature[]) {
  const s = await newSession();

  return s.rebuild(doc(features));
}

const run = async (features: Feature[]) => (await build(features)).report;

describe("offset face", () => {
  it("moves the top up and down, flush with the sides", async () => {
    const up = await run([
      ...block,
      { id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: 5 },
    ]);
    ok(up);
    expect(up.bodies[0]!.volume).toBeCloseTo((SOLID * 25) / 20, 2);
    expect(up.bodies[0]!.bbox.max[2]).toBeCloseTo(25, 6);
    // Still a plain block with a hole: the sides merged, no slivers, and the hole keeps its name.
    expect(up.bodies[0]!.faces).toBe(7);

    const tags = (
      await build([...block, { id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: 5 }])
    ).meshes[0]!.faceTags;
    expect(tags.some((t) => t.includes("ex1.side[sk1.h]"))).toBe(true);

    const down = await run([
      ...block,
      { id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: -5 },
    ]);
    ok(down);
    expect(down.bodies[0]!.volume).toBeCloseTo((SOLID * 15) / 20, 2);
  });

  it("makes a hole tighter or wider by moving its wall", async () => {
    const tighter = await run([
      ...block,
      { id: "of1", op: "offset_face", faces: [{ face: "ex1.side[sk1.h]" }], distance: 1 },
    ]);
    ok(tighter);
    expect(tighter.bodies[0]!.volume).toBeCloseTo(32000 - Math.PI * 16 * 20, 1);
    expect(tighter.bodies[0]!.faces).toBe(7);

    const wider = await run([
      ...block,
      { id: "of1", op: "offset_face", faces: [{ face: "ex1.side[sk1.h]" }], distance: -1 },
    ]);
    ok(wider);
    expect(wider.bodies[0]!.volume).toBeCloseTo(32000 - Math.PI * 36 * 20, 1);
  });

  it("moves a face up to a plane and keeps its name for later steps", async () => {
    const r = await run([
      ...block,
      { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
      { id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: 0, upTo: { ref: "pl1" } },
      // The moved top is still ex1.end_cap: move it again, 2 mm short of the plane.
      { id: "of2", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: 2, upTo: { ref: "pl1" } },
    ]);
    ok(r);
    expect(r.bodies[0]!.bbox.max[2]).toBeCloseTo(28, 6);
    expect(r.bodies[0]!.volume).toBeCloseTo((SOLID * 28) / 20, 2);
  });

  it("explains what is wrong", async () => {
    const zero = await run([
      ...block,
      { id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: 0 },
    ]);
    expect(status(zero, "of1").message).toMatch(/must not be zero/);

    const slanted = await run([
      ...block,
      {
        id: "of1",
        op: "offset_face",
        faces: [{ face: "ex1.end_cap" }],
        distance: 0,
        upTo: { ref: "origin.YZ" },
      },
    ]);
    expect(status(slanted, "of1").message).toMatch(/not parallel/);
  });
});
