/** Holes for heat-set inserts: what is refused, and the default depth. */
import { describe, expect, it } from "vitest";
import { HOLE_SIZES, HoleError, holeShape, INSERT_SIZES, insertDims } from "./holes.js";

describe("holes for heat-set inserts", () => {
  it("are 1 mm deeper than the insert unless a depth is given", () => {
    const insert = insertDims("M3")!;

    expect(holeShape("insert", { size: "M3" }).depth).toBe(insert.length + 1);
    expect(holeShape("insert", { size: "M3", depth: insert.length + 3 }).depth).toBe(insert.length + 3);
  });

  it("refuse an insert length that does not exist", () => {
    expect(() => holeShape("insert", { size: "M3", length: 99 })).toThrow(HoleError);
    expect(() => holeShape("insert", { size: "M3", length: 99 })).toThrow(
      /M3 inserts come .* long, not 99 mm/,
    );
  });

  it("refuse a screw size no insert is made for", () => {
    const sizeWithoutInsert = HOLE_SIZES.find((size) => !INSERT_SIZES.includes(size));

    expect(sizeWithoutInsert).toBeDefined();
    expect(() => holeShape("insert", { size: sizeWithoutInsert })).toThrow(
      `no insert size for ${sizeWithoutInsert}`,
    );
  });

  it("refuse a hole shallower than the insert", () => {
    const insert = insertDims("M3")!;

    expect(() => holeShape("insert", { size: "M3", depth: insert.length - 1 })).toThrow(
      `the hole must be at least as deep as the insert (${insert.length} mm)`,
    );
  });
});
