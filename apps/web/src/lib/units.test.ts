/** Lengths in millimetre and inch designs. */
import { afterEach, describe, expect, it } from "vitest";
import {
  convertMmText,
  docUnit,
  fmtLen,
  fmtVolume,
  hasLengthUnit,
  inUnit,
  isLengthParam,
  lengthExpr,
  lengthText,
  lengthValue,
  setUnitSource,
} from "./units";

afterEach(() => setUnitSource(() => "mm"));

describe("units", () => {
  it("takes the design's unit from its source", () => {
    expect(docUnit()).toBe("mm");
    setUnitSource(() => "in");
    expect(docUnit()).toBe("in");
    expect(fmtLen(25.4)).toBe("1 in");
  });

  it("shows lengths and volumes in the unit", () => {
    expect(inUnit(12.34567)).toBe(12.346);
    expect(inUnit(12.5, "in")).toBe(0.4921);
    expect(fmtLen(12.5, "mm")).toBe("12.5 mm");
    expect(fmtVolume(500, "mm")).toBe("500 mm³");
    expect(fmtVolume(2500, "mm")).toBe("2.5 cm³");
    expect(fmtVolume(25.4 ** 3, "in")).toBe("1 in³");
    expect(fmtVolume(12 * 25.4 ** 3, "in")).toBe("12 in³");
  });

  it("writes values for editing and reads typed values back", () => {
    expect(lengthText(undefined)).toBe("");
    expect(lengthText(25.4, "in")).toBe("1");
    expect(lengthText("w / 2", "in")).toBe("w / 2");
    expect(lengthExpr(" 2 ", "in")).toBe("2 in");
    expect(lengthExpr("-3.5", "mm")).toBe(-3.5);
    expect(lengthExpr(" w + 1 ")).toBe("w + 1");
    expect(lengthValue(1.234567, "mm")).toBe(1.2346);
    expect(lengthValue(50.8, "in")).toBe("2 in");
  });

  it("tells lengths from plain numbers", () => {
    expect(hasLengthUnit("3 mm")).toBe(true);
    expect(hasLengthUnit("2in")).toBe(true);
    expect(hasLengthUnit("3")).toBe(false);
    expect(hasLengthUnit(3)).toBe(false);
  });

  it("converts the millimetres in a text", () => {
    expect(convertMmText("12.7 mm", "mm")).toBe("12.7 mm");
    expect(convertMmText("12.7 mm, 645.16 mm², -16387.064 mm³", "in")).toBe("0.5 in, 1 in², -1 in³");
  });

  it("finds length variables through the variables they use", () => {
    const params = { w: "40 mm", half: "w / 2", n: 4, twice: "n * 2", loop: "loop2", loop2: "loop" };

    expect(isLengthParam("w", params)).toBe(true);
    expect(isLengthParam("half", params)).toBe(true);
    expect(isLengthParam("n", params)).toBe(false);
    expect(isLengthParam("twice", params)).toBe(false);
    expect(isLengthParam("loop", params)).toBe(false);
    expect(isLengthParam("missing", params)).toBe(false);
  });
});
