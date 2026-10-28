import { describe, expect, it } from "vitest";
import { validateDocument } from "@meercad/schema";
import { evaluate } from "@meercad/model";
import { convertMmText, fmtLen, isLengthParam, lengthExpr, lengthText, lengthValue, setUnitSource } from "../apps/web/src/lib/units";

setUnitSource(() => "in");

describe("inch designs", () => {
  it("store typed plain numbers with their unit, so the model stays in mm", () => {
    expect(lengthExpr("2")).toBe("2 in");
    expect(evaluate(lengthExpr("2"), new Map())).toBeCloseTo(50.8);
    expect(lengthExpr("wall * 2")).toBe("wall * 2");
    expect(lengthExpr("3", "mm")).toBe(3);
  });

  it("show millimetre values in inches", () => {
    expect(fmtLen(25.4)).toBe("1 in");
    expect(lengthText(12.7)).toBe("0.5");
    expect(lengthText("0.25 in")).toBe("0.25 in");
    expect(lengthValue(6.35)).toBe("0.25 in");
    expect(convertMmText("Distance 25.4 mm · area 645.16 mm²")).toBe("Distance 1 in · area 1 in²");
  });

  it("tell length variables from counts", () => {
    const params = { wall: "0.125 in", gap: "wall * 2", count: 4, ratio: "count / 2" };
    expect(isLengthParam("wall", params)).toBe(true);
    expect(isLengthParam("gap", params)).toBe(true);
    expect(isLengthParam("count", params)).toBe(false);
    expect(isLengthParam("ratio", params)).toBe(false);
  });

  it("is a valid document field", () => {
    expect(validateDocument({ format: "meercad/1", params: {}, features: [], rollback: null, units: "in" }).ok).toBe(true);
    expect(validateDocument({ format: "meercad/1", params: {}, features: [], rollback: null, units: "ft" }).ok).toBe(false);
  });
});
