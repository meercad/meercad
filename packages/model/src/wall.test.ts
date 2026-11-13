/** The openGrid profile table: values between, at and beyond its rows. */
import { describe, expect, it } from "vitest";
import { OPENGRID, openGridNode } from "./wall.js";

describe("reach of the openGrid crossing nodes by depth", () => {
  const [first, second] = OPENGRID.node;
  const last = OPENGRID.node.at(-1)!;

  it("takes the first row before the table and the last row beyond it", () => {
    expect(openGridNode(first![0] - 1)).toBe(first![1]);
    expect(openGridNode(last[0] + 1)).toBe(last[1]);
  });

  it("goes in a straight line between two rows", () => {
    const halfway = (first![0] + second![0]) / 2;

    expect(openGridNode(halfway)).toBeCloseTo((first![1] + second![1]) / 2, 12);
  });
});
