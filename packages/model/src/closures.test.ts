/** Strain a printed snap may take, by filament. */
import { describe, expect, it } from "vitest";
import { allowedSnapStrain, SNAP_STRAIN } from "./closures.js";

describe("allowed strain of a snap", () => {
  it("is the filament's value", () => {
    expect(allowedSnapStrain("TPU")).toBe(SNAP_STRAIN["TPU"]);
    expect(allowedSnapStrain("PETG")).toBe(SNAP_STRAIN["PETG"]);
  });

  it("is PLA's for an unknown filament or none", () => {
    expect(allowedSnapStrain("Unobtainium")).toBe(SNAP_STRAIN["PLA"]);
    expect(allowedSnapStrain(undefined)).toBe(SNAP_STRAIN["PLA"]);
  });
});
