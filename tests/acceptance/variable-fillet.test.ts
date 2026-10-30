import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** 60 × 30 × 20 block; the long top edge along x is rounded. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 60, 30)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];
const edge = { edge: ["ex1.end_cap", "ex1.side[sk1.l1]"] as [string, string] };
async function volume(f: Partial<Feature>) {
  const s = await newSession();
  const { report } = s.rebuild(doc([...block, { id: "fi1", op: "fillet", edges: edge, radius: 2, ...f } as Feature]));
  expect(report.features.filter((x) => x.status === "error").map((x) => x.message)).toEqual([]);
  return report.bodies[0]!.volume;
}

describe("variable fillet", () => {
  it("rounds from one radius to another along the edge", async () => {
    const full = 60 * 30 * 20;
    // A constant round of r takes away (1 − π/4) r² along the 60 mm edge.
    const cut = (r: number) => (1 - Math.PI / 4) * r * r * 60;
    const small = await volume({ radius: 2 });
    const big = await volume({ radius: 6 });
    const vary = await volume({ radius: 2, radius2: 6 });
    expect(small).toBeCloseTo(full - cut(2), 1);
    expect(big).toBeCloseTo(full - cut(6), 1);
    // In between, close to the average of r² along the edge (linear radius: mean r² = (r1² + r1 r2 + r2²) / 3).
    expect(vary).toBeLessThan(small);
    expect(vary).toBeGreaterThan(big);
    expect(vary).toBeCloseTo(full - (1 - Math.PI / 4) * ((4 + 12 + 36) / 3) * 60, -1);
  });
});
