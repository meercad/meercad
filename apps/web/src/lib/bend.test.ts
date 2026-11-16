/** The Bend tool's defaults and the numbers it shows. */
import { describe, expect, it } from "vitest";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { Feature } from "@meercad/schema";
import { bendDefaults, bendInfo, describeBend, gapProblem, partsBox, unbentBox } from "./bend";

type Bend = Extract<Feature, { op: "bend" }>;

const out = {
  report: {
    bodies: [
      { id: "a", bbox: { min: [0, 0, 0], max: [10, 2, 1] } },
      { id: "b", bbox: { min: [-5, 1, 0], max: [3, 4, 2] } },
      { id: "c", bbox: { min: [100, 100, 100], max: [101, 101, 101] } },
    ],
    features: [{ id: "bd1", info: { radius: 5 } }, { id: "ex1" }],
  },
} as unknown as RebuildOutput;
const strip = { min: [0, 0, 0], max: [100, 20, 2] };

describe("partsBox and bendInfo", () => {
  it("boxes the parts asked for", () => {
    expect(partsBox(out, ["a", "b"])).toEqual({ min: [-5, 0, 0], max: [10, 4, 2] });
    expect(partsBox(out, ["x"])).toBeNull();
    expect(partsBox(null, ["a"])).toBeNull();
  });

  it("reads a bend's report", () => {
    expect(bendInfo(out, "bd1")).toEqual({ radius: 5 });
    expect(bendInfo(out, "ex1")).toBeNull();
    expect(bendInfo(null, "bd1")).toBeNull();
  });
});

describe("bendDefaults", () => {
  it("lays a spiral flat round the thinnest side", () => {
    expect(bendDefaults("spiral", strip)).toEqual({
      mode: "spiral",
      axis: { ref: "origin.Z" },
      radius: 20,
      gap: 1,
      angle: undefined,
    });
    expect(bendDefaults("spiral", { min: [0, 0, 0], max: [50, 4, 1] }).radius).toBe(10);
  });

  it("wraps a strip into a closed ring and bends it round its width", () => {
    expect(bendDefaults("wrap", strip)).toEqual({
      mode: "wrap",
      axis: { ref: "origin.Y" },
      radius: 15.92,
      gap: undefined,
      angle: undefined,
    });
    expect(bendDefaults("bend", strip)).toEqual({
      mode: "bend",
      axis: { ref: "origin.Y" },
      angle: 90,
      radius: undefined,
      gap: undefined,
    });
  });
});

describe("describeBend and gapProblem", () => {
  it("says what each kind of bend comes to", () => {
    const spiral = describeBend("spiral", { turns: 3.25, outerRadius: 20, length: 300, thickness: 2 });

    expect(spiral).toContain("3.3");
    expect(spiral).toContain("40 mm");
    expect(describeBend("wrap", { closed: 1, radius: 10 })).toContain("20 mm");
    expect(describeBend("wrap", { closed: 0, angle: 180, radius: 10 })).toContain("180");
    expect(describeBend("bend", { closed: 1, radius: 12.34 })).toContain("12.3 mm");
    expect(describeBend("bend", { closed: 0, radius: 7 })).toContain("7 mm");
    expect(describeBend("bend", { closed: 0, radius: 7 })).not.toBe(
      describeBend("bend", { closed: 1, radius: 7 }),
    );
  });

  it("warns about spiral turns that overlap or fuse", () => {
    const spiral = { id: "bd1", op: "bend", mode: "spiral" } as Bend;

    expect(gapProblem({ ...spiral, mode: "wrap" }, 0)).toBeNull();
    expect(gapProblem(spiral, undefined)).toBeNull();
    expect(gapProblem(spiral, 0)).toMatchObject({ error: true });
    expect(gapProblem(spiral, NaN)).toMatchObject({ error: true });
    expect(gapProblem(spiral, 0.2)).toMatchObject({ error: false });
    expect(gapProblem(spiral, 1)).toBeNull();
  });
});

describe("unbentBox", () => {
  it("lays length, thickness and width along the axes they ran along", () => {
    // Thickness along Z, width along Y: the length runs along X.
    expect(
      unbentBox({ ox: 0, oy: 0, oz: 1, ax: 0, ay: 1, az: 0, length: 100, thickness: 2, width: 20 }),
    ).toEqual({ min: [0, 0, 0], max: [100, 20, 2] });
  });
});
