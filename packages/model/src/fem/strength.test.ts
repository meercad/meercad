/**
 * Strength of materials and parts (strength.ts): every library material has its numbers, an own
 * material takes its base's; the share of strength used follows the equivalent stress along the
 * layers and the weaker layer bond across them; the worst cube sets the safety, cubes where the
 * part is held or pushed left out.
 */
import { describe, expect, it } from "vitest";
import { MATERIALS } from "../materials.js";
import { STRENGTHS, strengthCheck, strengthOf, utilisation, vonMises } from "./strength.js";

const PLA = STRENGTHS.pla!;

describe("materials", () => {
  it("all have a strength, own ones through their base", () => {
    for (const material of MATERIALS) expect(strengthOf(material), material.id).toBeDefined();

    expect(strengthOf({ id: "m1", base: "petg" })).toBe(STRENGTHS.petg);
    expect(strengthOf({ id: "m1" })).toBeUndefined();
    expect(strengthOf({ id: "m1", base: "unknown" })).toBeUndefined();
  });
});

describe("stress", () => {
  it("is weighed as von Mises: a pull counts fully, a shear √3 times, pressure from all sides not", () => {
    expect(vonMises([30, 0, 0, 0, 0, 0])).toBeCloseTo(30);
    expect(vonMises([0, 0, 0, 10, 0, 0])).toBeCloseTo(10 * Math.sqrt(3));
    expect(vonMises([0, 0, 0, 0, 0, 0, -20, -20, -20, 0, 0, 0], 6)).toBeCloseTo(0);
  });

  it("uses more of the strength across the layers than along them", () => {
    const pullZ = [0, 0, 25, 0, 0, 0];

    expect(utilisation(pullZ, 0, PLA, [1, 0, 0])).toBeCloseTo(0.5);
    expect(utilisation(pullZ, 0, PLA, [0, 0, 1])).toBeCloseTo(25 / 30);
    // Pressing the layers together does not open them.
    expect(utilisation([0, 0, -25, 0, 0, 0], 0, PLA, [0, 0, 1])).toBeCloseTo(0.5);
    // Shear between the layers.
    expect(utilisation([0, 0, 0, 0, 10, 0], 0, PLA, [0, 0, 1])).toBeCloseTo((10 * Math.sqrt(3)) / 30);
    expect(utilisation([0, 0, 0, 10, 0, 0], 0, STRENGTHS.steel!, [0, 0, 1])).toBeCloseTo(
      (10 * Math.sqrt(3)) / 235,
    );
  });
});

describe("the check of a part", () => {
  const stress = Float32Array.from([
    10, 0, 0, 0, 0, 0, 40, 0, 0, 0, 0, 0, 99, 0, 0, 0, 0, 0, 25, 0, 0, 0, 0, 0,
  ]);

  it("takes the worst material cube, and leaves out the cubes asked for", () => {
    const all = strengthCheck(stress, [1, 1, 0, 1], PLA, [0, 0, 1]);

    expect(Array.from(all.used)).toEqual([0.2, 0.8, 0, 0.5].map(Math.fround));
    expect(all.worstCell).toBe(1);
    expect(all.safety).toBeCloseTo(1.25);
    expect(strengthCheck(stress, [1, 1, 0, 1], PLA, [0, 0, 1], [1])).toMatchObject({
      worstCell: 3,
      safety: 2,
    });
  });

  it("is infinitely safe without stress, and counts nothing when every cube is left out", () => {
    expect(strengthCheck(new Float32Array(12), [1, 1], PLA, [0, 0, 1])).toMatchObject({
      worst: 0,
      worstCell: 0,
      safety: Infinity,
    });
    expect(strengthCheck(stress, [1, 0, 0, 0], PLA, [0, 0, 1], [0])).toMatchObject({
      worstCell: -1,
      safety: Infinity,
    });
  });
});
