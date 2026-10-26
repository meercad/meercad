import { describe, expect, it } from "vitest";
import { decodeShareFragment, encodeShareFragment, meshVolume, readStl, writeStl } from "./index.js";

describe("STL", () => {
  it("round-trips a tetrahedron with correct volume", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const stl = readStl(writeStl([{ positions, indices }]));
    expect(stl.triangles).toBe(4);
    expect(meshVolume(stl.vertices)).toBeCloseTo(1 / 6);
  });
});

describe("share links", () => {
  it("round-trips and stays URL-safe", async () => {
    const doc = { format: "opencad/1", params: { w: "40 mm" }, features: [], rollback: null };
    const frag = await encodeShareFragment(doc);
    expect(frag).toMatch(/^m1\.[A-Za-z0-9_-]+$/);
    expect(await decodeShareFragment(`#${frag}`)).toEqual(doc);
    await expect(decodeShareFragment("#garbage")).rejects.toThrow();
  });
});
