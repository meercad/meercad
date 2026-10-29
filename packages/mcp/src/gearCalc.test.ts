import { describe, expect, it } from "vitest";
import { gearCalc } from "./gearCalc.js";

describe("gear_calc", () => {
  it("sizes a gear and a pair", () => {
    const r = gearCalc({ module: 1.5, teeth: 15, teeth2: 30 });
    expect(r["gear"]).toMatchObject({ pitchDiameter: 22.5, outsideDiameter: 25.5, rootDiameter: 18.75 });
    expect(r["centreDistance"]).toBe(33.75);
    expect(r["ratio"]).toBe(2);
    expect((r["gear"] as { warnings: string[] }).warnings[0]).toMatch(/undercut/);
  });
  it("puts a planet in a ring and a pinion on a rack", () => {
    expect(gearCalc({ module: 1, teeth: 18, teeth2: 60, kind2: "internal" })["centreDistance"]).toBe(21);
    const rack = gearCalc({ module: 1.5, teeth: 16, teeth2: 20, kind2: "rack" });
    expect(rack["travelPerTurn"]).toBeCloseTo(Math.PI * 24, 3);
    expect(rack["mate"]).toMatchObject({ kind: "rack", length: expect.closeTo(20 * Math.PI * 1.5, 3) });
  });
});
