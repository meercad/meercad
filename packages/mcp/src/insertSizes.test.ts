import { describe, expect, it } from "vitest";
import { insertSizes } from "./insertSizes.js";

describe("insert_sizes", () => {
  it("lists every size with hole, wall and boss", () => {
    const all = insertSizes({}).inserts;
    expect(all.map((x) => x.size)).toEqual(["M2", "M2.5", "M3", "M4", "M5", "M6", "M8", "M10"]);
    const m3 = insertSizes({ size: "M3" }).inserts[0]!;
    expect(m3).toMatchObject({ lengths: [5.7, 4, 3], hole: 4, outer: 4.6, minWall: 1.6, holeDepth: [6.7, 5, 4], minBossDiameter: 7.2, minEdgeDistance: 3.6, minSpacing: 5.6 });
  });

  it("names the sizes there are", () => {
    expect(() => insertSizes({ size: "M7" })).toThrow(/use one of M2, M2.5/);
  });
});
