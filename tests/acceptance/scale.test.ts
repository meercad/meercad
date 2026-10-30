import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
/** 20 × 10 × 5 block at x 10–30 with a Ø4 hole. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 10, 0, 20, 10), ...circle("h", 20, 5, 2)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
];
async function run(f: Partial<Feature>) {
  const s = await newSession();
  return s.rebuild(doc([...block, { id: "sc1", op: "scale", bodies: ["ex1"], factor: 2, ...f } as Feature])).report;
}

describe("scale", () => {
  it("scales a part about its centre, keeping it in place", async () => {
    const r = await run({});
    const b = r.bodies[0]!;
    expect(b.volume).toBeCloseTo((200 - Math.PI * 4) * 5 * 8, 3);
    expect(b.bbox.min[0]).toBeCloseTo(0, 6);
    expect(b.bbox.max[0]).toBeCloseTo(40, 6);
    expect(b.bbox.min[2]).toBeCloseTo(-2.5, 6);
  });

  it("scales about the origin, and to a measured size", async () => {
    const o = await run({ center: "origin" });
    expect(o.bodies[0]!.bbox.min[0]).toBeCloseTo(20, 6);
    // A scan measured 20.4 long that should be 20: factor 20 / 20.4.
    const fix = await run({ factor: "20 / 20.4" });
    const b = fix.bodies[0]!.bbox;
    expect(b.max[0] - b.min[0]).toBeCloseTo((20 * 20) / 20.4, 6);
  });

  it("explains what is wrong", async () => {
    expect(status(await run({ factor: 0 }), "sc1").message).toMatch(/greater than zero/);
  });
});
