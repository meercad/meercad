import { describe, expect, it } from "vitest";
import { stagedRequests } from "./protocol.js";

describe("staged exports", () => {
  it("groups small files and splits big ones into pieces of at most the piece size", () => {
    const r = stagedRequests({ "a.xml": 3, "b.stl": 25, "c.stl": 4, "empty.stl": 0 }, 10);
    expect(r).toEqual([
      [{ name: "a.xml", offset: 0, length: 3 }],
      [{ name: "b.stl", offset: 0, length: 10 }],
      [{ name: "b.stl", offset: 10, length: 10 }],
      [
        { name: "b.stl", offset: 20, length: 5 },
        { name: "c.stl", offset: 0, length: 4 },
        { name: "empty.stl", offset: 0, length: 0 },
      ],
    ]);
    for (const batch of r) expect(batch.reduce((n, p) => n + p.length, 0)).toBeLessThanOrEqual(10);
  });
  it("covers every byte of every file once", () => {
    const sizes = { x: 1000, y: 1, z: 333 };
    const got: Record<string, number> = {};
    for (const p of stagedRequests(sizes, 64).flat()) {
      expect(p.offset).toBe(got[p.name] ?? 0);
      got[p.name] = p.offset + p.length;
    }
    expect(got).toEqual(sizes);
  });
});
