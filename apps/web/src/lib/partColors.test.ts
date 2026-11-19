/** Part colours: picked, from the material, or the palette. */
import { describe, expect, it } from "vitest";
import type { MeercadDocument } from "@meercad/schema";
import { PART_PALETTE, partColors } from "./partColors";

const doc: MeercadDocument = {
  format: "meercad/1",
  params: {},
  features: [],
  partOrder: ["c", "gone", "a"],
  partColors: { d: "#ff0000" },
  partMaterials: { e: "woodfill" },
  rollback: null,
};

describe("partColors", () => {
  it("takes picked and material colours, then grey for the first part and petrol for the rest", () => {
    const colors = partColors(doc, ["a", "b", "c", "d", "e"], true);

    expect(Object.fromEntries(colors)).toEqual({
      c: PART_PALETTE[0],
      a: PART_PALETTE[1],
      b: PART_PALETTE[1],
      d: "#ff0000",
      e: "#a87d52",
    });
    expect([...colors.keys()]).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("colours only picked and material parts without automatic colours or with a single part", () => {
    expect(Object.fromEntries(partColors(doc, ["a", "d"], false))).toEqual({ d: "#ff0000" });
    expect(partColors({ ...doc, partOrder: undefined, partColors: undefined }, ["a"], true).size).toBe(0);
  });
});
