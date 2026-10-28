import { describe, expect, it } from "vitest";
import { formatStep, gridLevels } from "../apps/web/src/lib/grid";

describe("grid", () => {
  it("writes spacings in the chosen unit, inches as ruler fractions", () => {
    expect(formatStep(5, "mm")).toBe("5 mm");
    expect(formatStep(10, "mm")).toBe("1 cm");
    expect(formatStep(25.4 / 16, "in")).toBe("1/16 in");
    expect(formatStep(50.8, "in")).toBe("2 in");
  });

  it("steps 1 → 5 → 10 mm as you zoom out, snapping to the fine lines", () => {
    // mm per screen pixel → minor spacing at least 12 px apart
    expect(gridLevels(0.05, "mm")).toEqual({ minor: 1, major: 10, snap: 1 });
    expect(gridLevels(0.1, "mm")).toEqual({ minor: 5, major: 50, snap: 5 });
    expect(gridLevels(0.5, "mm")).toEqual({ minor: 10, major: 100, snap: 10 });
    expect(gridLevels(1, "mm")).toEqual({ minor: 50, major: 500, snap: 50 });
  });

  it("uses ruler fractions with major lines on whole inches", () => {
    expect(gridLevels(0.1, "in")).toEqual({ minor: 25.4 / 16, major: 25.4, snap: 25.4 / 16 });
    expect(gridLevels(0.5, "in")).toEqual({ minor: 25.4 / 4, major: 25.4 * 12, snap: 25.4 / 4 });
  });
});
