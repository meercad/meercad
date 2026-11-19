/** Grid spacings and drag steps as the view zooms, in millimetres and inches. */
import { describe, expect, it } from "vitest";
import { dragStep, formatStep, gridLevels, MIN_SPACING_PX } from "./grid";

describe("gridLevels", () => {
  it("steps the minor spacing so lines stay apart, majors ten minors apart", () => {
    expect(MIN_SPACING_PX).toBe(12);
    expect(gridLevels(0.1, "mm")).toEqual({ minor: 5, major: 50, snap: 5 });
    expect(gridLevels(0.0001, "mm").minor).toBe(0.01);
    expect(gridLevels(1e6, "mm").minor).toBe(50000);
  });

  it("puts inch majors on whole inches and feet", () => {
    expect(gridLevels(0.1, "in")).toMatchObject({ minor: 25.4 / 16, major: 25.4 });
    expect(gridLevels(5, "in")).toMatchObject({ minor: 3 * 25.4, major: 120 * 25.4 });
    // Zoomed out past every step: the largest minor, still with a major.
    expect(gridLevels(1e6, "in")).toMatchObject({ minor: 1200 * 25.4, major: 12000 * 25.4 });
  });
});

describe("dragStep", () => {
  it("moves about six pixels a step, capped at the largest", () => {
    expect(dragStep(0.1, "mm")).toBe(1);
    expect(dragStep(1e6, "mm")).toBe(1000);
    expect(dragStep(0.1, "in")).toBe(25.4 / 32);
    expect(dragStep(1e6, "in")).toBe(24 * 25.4);
  });
});

describe("formatStep", () => {
  it("writes inch fractions, centimetres from 10 mm and plain values otherwise", () => {
    expect(formatStep(25.4 / 16, "in")).toBe("1/16 in");
    expect(formatStep(25.4 * 0.3, "in")).toBe("0.3 in");
    expect(formatStep(25.4 * 3, "in")).toBe("3 in");
    expect(formatStep(50, "mm")).toBe("5 cm");
    expect(formatStep(2.5, "mm")).toBe("2.5 mm");
  });
});
