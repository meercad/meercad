/**
 * Faces for the strength check (strengthFaces.ts): the triangles of chosen faces; a force along an
 * axis, into a flat face, and down where the faces face all ways.
 */
import { describe, expect, it } from "vitest";
import { faceTriangles, LOAD_DIRECTIONS, loadForce } from "./strengthFaces";

// A square in the plane z = 0 facing up (face 7) and a triangle facing +x (face 9).
const positions = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0, 5, 0, 0, 5, 1, 0, 5, 0, 1];
const mesh = {
  indices: Uint32Array.from([0, 1, 2, 0, 2, 3, 4, 5, 6]),
  faceRanges: Int32Array.from([0, 6, 7, 6, 3, 9]),
};

describe("face triangles", () => {
  it("are those of the chosen faces, in order", () => {
    expect(Array.from(faceTriangles(mesh, [9]))).toEqual([4, 5, 6]);
    expect(Array.from(faceTriangles(mesh, [9, 7]))).toEqual([0, 1, 2, 0, 2, 3, 4, 5, 6]);
    expect(faceTriangles(mesh, [1]).length).toBe(0);
  });
});

describe("the force on faces", () => {
  it("goes along the chosen axis", () => {
    expect(loadForce(positions, [0, 1, 2], 10, "+x")).toEqual([10, 0, 0]);
    expect(loadForce(positions, [0, 1, 2], 10, "-y")).toEqual([0, -10, 0]);
    expect(loadForce(positions, [0, 1, 2], 10, "-z")).toEqual([0, 0, -10]);
    expect(LOAD_DIRECTIONS).toHaveLength(7);
  });

  it("goes into a flat face, against the way it faces", () => {
    expect(loadForce(positions, [0, 1, 2, 0, 2, 3], 10, "into").map((value) => value + 0)).toEqual([
      0, 0, -10,
    ]);
    expect(loadForce(positions, [4, 5, 6], 4, "into").map((value) => value + 0)).toEqual([-4, 0, 0]);
  });

  it("goes down where the faces face all ways, or there are none", () => {
    // The square once facing up and once facing down.
    expect(loadForce(positions, [0, 1, 2, 0, 2, 1], 10, "into")).toEqual([0, 0, -10]);
    expect(loadForce(positions, [], 3, "into")).toEqual([0, 0, -3]);
  });
});
