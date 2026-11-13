/**
 * New features and names (features.ts), the corners other tests leave: a bin for a full baseplate and
 * a holder for a full board start at the first cell; holders are named by what they hold; a rail's
 * second carriage and a carriage of a size there is none of are named sensibly.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, type Feature, type MeercadDocument } from "@meercad/schema";
import { draftFeature, featureName, partName } from "./features";

const doc = (features: unknown[]): MeercadDocument => ({ ...emptyDocument(), features: features as Feature[] });

describe("new features and names", () => {
  it("starts a bin or a holder at the first cell when everything is taken", () => {
    const plate = { id: "gf1", op: "gridfinity", kind: "baseplate", units: [1, 1] };
    const bin = { id: "gf2", op: "gridfinity", kind: "bin", units: [1, 1], baseplate: "gf1", cell: [0, 0] };
    expect((draftFeature("gridfinity", doc([plate, bin])) as { cell: number[] }).cell).toEqual([0, 0]);
    const board = { id: "wa1", op: "wall", system: "opengrid", kind: "board", units: [1, 1] };
    const hook = { id: "wa2", op: "wall", system: "opengrid", kind: "holder", units: [1, 1], board: "wa1", cell: [0, 0] };
    expect((draftFeature("wall", doc([board, hook])) as { cell: number[] }).cell).toEqual([0, 0]);
  });

  it("names holders by what they hold", () => {
    expect(featureName({ id: "wa2", op: "wall", system: "pegboard", kind: "holder", units: [2, 1] } as never)).toMatch(/ 2×1$/);
    expect(featureName({ id: "wa3", op: "wall", system: "pegboard", kind: "board", units: [6, 4] } as never)).toBe("Pegboard 6×4");
  });

  it("names a rail's carriages, and falls back for a size there is none of", () => {
    const rail = { id: "sp1", op: "standard_part", kind: "rail", size: "MGN12", length: 200 } as unknown as Feature;
    expect(partName("sp1_2_carriage", [rail])).toMatch(/carriage \(2\)$/i);
    const odd = { ...rail, size: "MGN99" } as unknown as Feature;
    expect(partName("sp1_carriage", [odd])).not.toBe("sp1_carriage");
  });
});
