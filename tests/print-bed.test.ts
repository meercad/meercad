import { describe, expect, it } from "vitest";
import { fitsBed, tooBig } from "../apps/web/src/lib/printBed";

describe("print bed", () => {
  it("a part fits when it fits turned in right angles", () => {
    expect(fitsBed([250, 10, 200], [256, 256, 256])).toBe(true);
    expect(fitsBed([300, 10, 10], [256, 256, 256])).toBe(false);
    // 240 tall fits a 250 × 210 × 220 bed lying on its side.
    expect(fitsBed([100, 100, 240], [250, 210, 220])).toBe(true);
    expect(fitsBed([230, 230, 100], [250, 210, 220])).toBe(false);
  });
  it("lists the parts that are too big; no bed, no warning", () => {
    const bodies = [
      { id: "a", bbox: { min: [0, 0, 0], max: [100, 40, 20] } },
      { id: "b", bbox: { min: [-150, 0, 0], max: [150, 40, 20] } },
    ];
    expect(tooBig(bodies, [256, 256, 256]).map((b) => b.id)).toEqual(["b"]);
    expect(tooBig(bodies, null)).toEqual([]);
  });
});
