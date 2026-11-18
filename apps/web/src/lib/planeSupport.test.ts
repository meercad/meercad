/** Where a sketch lies on a part (planeSupport.ts): faces of the parts in the sketch's plane. */
import { describe, expect, it } from "vitest";
import { inTriangle, planeSupport, type MeshLike, type PlaneFrame } from "./planeSupport";

/** A box 0..50 × 0..30 × 0..12 as its top (z = 12, two triangles) and one side (x = 0). */
const box: MeshLike = {
  positions: [0, 0, 12, 50, 0, 12, 50, 30, 12, 0, 30, 12, 0, 0, 0, 0, 30, 0],
  indices: [0, 1, 2, 0, 2, 3, 0, 3, 5, 0, 5, 4],
};
const top: PlaneFrame = { origin: [10, 5, 12], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] };

describe("planeSupport", () => {
  it("knows the face the sketch lies on, in sketch coordinates", () => {
    const onFace = planeSupport([box], top);
    expect(onFace([0, 0])).toBe(true);
    expect(onFace([39.9, 24.9])).toBe(true);
    // Past the back edge (y = 30 is 25 from the sketch's origin).
    expect(onFace([10, 26])).toBe(false);
    expect(onFace([-11, 0])).toBe(false);
  });

  it("finds the faces once per set of parts and plane", () => {
    const meshes = [box];
    expect(planeSupport(meshes, top)).toBe(planeSupport(meshes, top));
    expect(planeSupport(meshes, { ...top, origin: [0, 0, 11] })).not.toBe(planeSupport(meshes, top));
  });

  it("has no preference for a sketch in the air", () => {
    const air = planeSupport([box], { ...top, origin: [0, 0, 40] });
    expect(air([1000, 1000])).toBe(true);
  });
});

describe("inTriangle", () => {
  const tri = [
    [0, 0],
    [10, 0],
    [0, 10],
  ] as const;

  it("counts the inside and the edges, either way round", () => {
    expect(inTriangle([2, 2], tri)).toBe(true);
    expect(inTriangle([5, 0], tri)).toBe(true);
    expect(inTriangle([2, 2], [tri[0], tri[2], tri[1]])).toBe(true);
    expect(inTriangle([8, 8], tri)).toBe(false);
  });
});
