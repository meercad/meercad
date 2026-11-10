import { describe, expect, it } from "vitest";
import { clearances } from "@meercad/kernel";
import type { Feature } from "@meercad/schema";
import { doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const block = (k: number, x: number, w: number): Feature[] => [
  sketch(`sk${k}`, { ref: "origin.XY" }, rect(`r${k}`, x, 0, w, 10)),
  { id: `ex${k}`, op: "extrude", profile: { sketch: `sk${k}` }, extent: "blind", distance: 10, mode: "new_body" },
];

describe("interference of all parts", () => {
  it("finds overlaps and touching parts among every pair", async () => {
    // ex1 0–10, ex2 8–18 (overlaps ex1 by 2 mm), ex3 18–28 (touches ex2), ex4 40–50 (apart).
    const s = await newSession();
    s.rebuild(doc([...block(1, 0, 10), ...block(2, 8, 10), ...block(3, 18, 10), ...block(4, 40, 10)]));
    const pairs = await clearances(await getOcct(), s.state!, ["ex1", "ex2", "ex3", "ex4"], {}, 0);
    const pair = (a: string, b: string) => pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
    expect(pair("ex1", "ex2")!.overlap).toBeCloseTo(2 * 10 * 10, 6);
    expect(pair("ex2", "ex3")!.overlap).toBeLessThan(1e-3);
    expect(pair("ex2", "ex3")!.distance).toBeLessThan(1e-6);
    // Parts far apart are not even compared.
    expect(pair("ex1", "ex4")).toBeUndefined();
    // Parts held together (fixed joints) are left out: they never move against each other.
    const held = await clearances(await getOcct(), s.state!, ["ex1", "ex2", "ex3", "ex4"], {}, 0, [], { ex1: 0, ex2: 0, ex3: 1 });
    expect(held.map((p) => [p.a, p.b])).toEqual([["ex2", "ex3"]]);
  });
});
