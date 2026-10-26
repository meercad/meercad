import { describe, expect, it } from "vitest";
import { evaluateSketch, toWorld } from "./index.js";

describe("evaluateSketch", () => {
  it("names rectangle edges semantically, even with negative size", () => {
    const r = evaluateSketch({
      id: "sk1",
      plane: { ref: "origin.XZ" },
      entities: [{ id: "r1", type: "rectangle", corner: [10, 5], size: [-10, -5] }],
    });
    const loop = r.profiles.get("sk1.r1.region")!.loops[0]!;
    expect(loop.points).toEqual([[0, 0], [10, 0], [10, 5], [0, 5]]);
    expect(loop.edgeNames[2]).toBe("sk1.r1.top");
    expect(toWorld(r.frame, [1, 2])).toEqual([1, 0, 2]);
  });

  it("rejects degenerate rectangles", () => {
    expect(() =>
      evaluateSketch({ id: "s", plane: { ref: "origin.XY" }, entities: [{ id: "r", type: "rectangle", corner: [0, 0], size: [0, 1] }] }),
    ).toThrow(/zero size/);
  });
});
