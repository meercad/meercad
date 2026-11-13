/**
 * Variables made from a value (ValueInput.tsx): a free name is found when the plain one is taken, a
 * name that is no identifier is cleaned; a number is stored with its unit, in inches for an inch design.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apply, newProject, setDesignUnits } from "../store";
import { freeParamName, withUnit } from "./ValueInput";

beforeAll(async () => {
  await newProject(undefined, "Value names");
  apply({ type: "set_param", name: "fillet_radius", expr: "2 mm" }, { type: "set_param", name: "fillet_radius2", expr: "3 mm" });
});
afterAll(() => setDesignUnits("mm"));

describe("variables made from a value", () => {
  it("finds a free name, and cleans one that is no identifier", () => {
    expect(freeParamName("fillet_radius")).toBe("fillet_radius3");
    expect(freeParamName("depth")).toBe("depth");
    expect(freeParamName("2 holes")).toBe("_2_holes");
    expect(freeParamName("")).toBe("v");
  });

  it("stores a number with its unit", () => {
    expect(withUnit(12.34567, "mm")).toBe("12.3457 mm");
    expect(withUnit(30, "deg")).toBe("30 deg");
    expect(withUnit(4.00001, "")).toBe(4);
    setDesignUnits("in");
    expect(withUnit(25.4, "mm")).toMatch(/^1(\.0+)? in$/);
  });
});
