/** Texture coordinates of a mesh part from its file's corners. */
import { describe, expect, it } from "vitest";
import { meshUvs } from "./meshUvs";

const positions = new Float32Array(18);
const uvs = Float32Array.from({ length: 12 }, (_, i) => i);

describe("meshUvs", () => {
  it("copies the file's coordinates, or swaps the last two corners of a flipped mesh", () => {
    expect(Array.from(meshUvs({ source: { flipped: false }, positions }, uvs)!)).toEqual(Array.from(uvs));
    expect(Array.from(meshUvs({ source: { flipped: true }, positions }, uvs)!)).toEqual([
      0, 1, 4, 5, 2, 3, 6, 7, 10, 11, 8, 9,
    ]);
  });

  it("gives none for a changed part or coordinates that do not fit", () => {
    expect(meshUvs({ positions }, uvs)).toBeNull();
    expect(meshUvs({ source: { flipped: false }, positions }, new Float32Array(4))).toBeNull();
  });
});
