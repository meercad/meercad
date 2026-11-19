/** Whether parts fit the printer's build volume. */
import { describe, expect, it } from "vitest";
import { BED_PRESETS, DEFAULT_BED, fitsBed, partSize, tooBig, validBed } from "./printBed";

const body = (id: string, max: number[], min = [0, 0, 0]) => ({ id, bbox: { min, max } });

describe("print bed", () => {
  it("measures a part and fits it turned in right angles", () => {
    expect(partSize({ min: [1, 2, 3], max: [11, 7, 4] })).toEqual([10, 5, 1]);
    expect(fitsBed([300, 10, 200], [220, 220, 310])).toBe(true);
    expect(fitsBed([300, 300, 10], [220, 220, 310])).toBe(false);
    expect(BED_PRESETS.find((preset) => preset.id === "256")!.size).toEqual(DEFAULT_BED);
  });

  it("lists finite parts too big for the bed, none without a bed", () => {
    const bodies = [
      body("small", [10, 10, 10]),
      body("large", [400, 10, 10]),
      body("endless", [Infinity, 1, 1]),
      body("open", [1, 1, 1], [-Infinity, 0, 0]),
    ];

    expect(tooBig(bodies, DEFAULT_BED).map((b) => b.id)).toEqual(["large"]);
    expect(tooBig(bodies, null)).toEqual([]);
  });

  it("accepts stored beds of three sensible sizes, or none", () => {
    expect(validBed(null)).toBeNull();
    expect(validBed([200, 200, 200])).toEqual([200, 200, 200]);
    expect(validBed([200, 200])).toBeUndefined();
    expect(validBed([200, 200, 5])).toBeUndefined();
    expect(validBed([200, 200, 6000])).toBeUndefined();
    expect(validBed([200, 200, "200"])).toBeUndefined();
    expect(validBed("256")).toBeUndefined();
  });
});
