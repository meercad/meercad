import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { AlignFeature, Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
/**
 * Base: 40 × 40 × 10 with a Ø8 hole at (20, 20); a 10 × 10 × 5 block lying around at (60, 0, 0); a Ø8 × 30
 * pin lying along x at y = -30.
 */
const scene: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("b", 0, 0, 40, 40), ...circle("h", 20, 20, 4)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, rect("k", 60, 0, 10, 10)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 5, mode: "new_body" },
  { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 60 },
  sketch("sk3", { ref: "pl1" }, circle("p", -30, 4, 4)),
  { id: "ex3", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 30, mode: "new_body" },
];

async function run(a: Partial<AlignFeature>) {
  const s = await newSession();

  return s.rebuild(
    doc([
      ...scene,
      {
        id: "al1",
        op: "align",
        from: { face: { face: "ex2.start_cap" } },
        to: { face: { face: "ex1.end_cap" } },
        ...a,
      } as AlignFeature,
    ]),
  ).report;
}

const bb = (r: RebuildReport, id: string) => r.bodies.find((b) => b.id === id)!.bbox;

describe("align", () => {
  it("sets a part's face onto another's: the block's bottom onto the base's top", async () => {
    const r = await run({});
    ok(r);

    const b = bb(r, "ex2");
    expect(b.min[2]).toBeCloseTo(10, 6);
    expect(b.max[2]).toBeCloseTo(15, 6);
    // It keeps its place within the plane.
    expect(b.min[0]).toBeCloseTo(60, 6);
  });

  it("leaves a gap, turns the part, and lies flush", async () => {
    const gap = await run({ offset: 2, angle: 90 });
    ok(gap);
    expect(bb(gap, "ex2").min[2]).toBeCloseTo(12, 6);

    // Its top onto the base's top, flush: the block now sits from z = 5 to 10.
    const flush = await run({ from: { face: { face: "ex2.end_cap" } }, flip: true });
    ok(flush);
    expect(bb(flush, "ex2").max[2]).toBeCloseTo(10, 6);
    expect(bb(flush, "ex2").min[2]).toBeCloseTo(5, 6);
  });

  it("puts a pin into a hole by their axes", async () => {
    const r = await run({
      bodies: ["ex3"],
      from: { axisOf: { face: "ex3.side[sk3.p]" } },
      to: { axisOf: { face: "ex1.side[sk1.h]" } },
    });
    ok(r);

    const b = bb(r, "ex3");
    // Standing upright on the hole's axis.
    expect((b.min[0] + b.max[0]) / 2).toBeCloseTo(20, 6);
    expect((b.min[1] + b.max[1]) / 2).toBeCloseTo(20, 6);
    expect(b.max[2] - b.min[2]).toBeCloseTo(30, 6);
  });

  it("explains what is wrong", async () => {
    const r = await run({
      from: { face: { face: "ex2.start_cap" } },
      to: { axisOf: { face: "ex1.side[sk1.h]" } },
    });
    expect(status(r, "al1").message).toMatch(/two flat faces or two round faces/);
  });
});
