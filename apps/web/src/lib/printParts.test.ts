/** 3MF parts: names, colours, materials and filaments from the document. */
import { describe, expect, it } from "vitest";
import type { Feature, MeercadDocument } from "@meercad/schema";
import { partFilament, threeMfParts } from "./printParts";
import { PART_PALETTE } from "./partColors";

const features = [
  {
    id: "ex1",
    op: "extrude",
    name: "Base",
    profile: { sketch: "sk1" },
    extent: "blind",
    distance: 5,
    mode: "new_body",
  },
] as Feature[];
const doc: MeercadDocument = {
  format: "meercad/1",
  params: {},
  features,
  partMaterials: { ex1: "pla", ex1_2: "placf", ex1_3: "aluminium" },
  partColors: { ex1_4: "#ff0000" },
  rollback: null,
};
const mesh = (bodyId: string) => ({
  bodyId,
  positions: new Float32Array(9),
  indices: new Uint32Array([0, 1, 2]),
});

describe("partFilament", () => {
  it("prints with the material and its colour, or the colour picked alone", () => {
    expect(partFilament(doc, "ex1", "#123456")).toEqual({ color: "#123456", material: "PLA", type: "PLA" });
    expect(partFilament(doc, "ex1", undefined)).toEqual({
      color: PART_PALETTE[0],
      material: "PLA",
      type: "PLA",
    });
    expect(partFilament(doc, "ex1_2", undefined)).toMatchObject({ color: "#2c2e31", type: "PLA-CF" });
    expect(partFilament(doc, "ex1_3", undefined)).toEqual({ color: "#c8ccd1", material: "Aluminium" });
    expect(partFilament(doc, "ex1_4", undefined)).toEqual({ color: "#ff0000" });
    expect(partFilament(doc, "ex1_5", undefined)).toBeUndefined();
  });
});

describe("threeMfParts", () => {
  const colors = new Map([["ex1", "#00ff00"]]);

  it("names the parts and adds colour, material, finish and filament", () => {
    const [first, plain] = threeMfParts(doc, [mesh("ex1"), mesh("ex1_5")], colors);

    expect(first).toMatchObject({
      name: "Base",
      color: "#00ff00",
      material: "PLA",
      look: { roughness: 0.42, metalness: 0 },
      filament: { color: "#00ff00", material: "PLA", type: "PLA" },
    });
    expect(Object.keys(plain!).sort()).toEqual(["indices", "name", "positions"]);
  });

  it("leaves materials and colours out when asked", () => {
    expect(Object.keys(threeMfParts(doc, [mesh("ex1")], colors, false)[0]!).sort()).toEqual([
      "indices",
      "name",
      "positions",
    ]);
  });
});
