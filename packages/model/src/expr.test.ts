/**
 * Variables and formulas against values worked out by hand: units, precedence, functions, angles,
 * dependencies between variables, renaming, and everything that must be refused.
 */
import { describe, expect, it } from "vitest";
import { evaluate, referencedNames, renameInExpr, resolveParams } from "./expr.js";

const scope = new Map([
  ["wall", 2],
  ["width", 80],
  ["n", 6],
]);
const ev = (s: string | number) => evaluate(s, scope);

describe("units normalise to mm and degrees", () => {
  it.each([
    ["1 mm", 1],
    ["1 cm", 10],
    ["1 m", 1000],
    ["1 in", 25.4],
    ["1 ft", 304.8],
    ["0.5in", 12.7],
    ["(3/8) * 1in", 9.525],
    ["2.5 cm + 4 mm", 29],
    ["90 deg", 90],
    ["1 rad", 180 / Math.PI],
    ["pi rad", NaN], // a unit only follows a number literal
  ])("%s", (src, want) => {
    if (Number.isNaN(want)) expect(() => ev(src)).toThrow();
    else expect(ev(src)).toBeCloseTo(want, 10);
  });
  it("binds a unit to the number before it only", () => {
    expect(ev("3/8 in")).toBeCloseTo(3 / 203.2, 12);
  });
});

describe("arithmetic follows the usual precedence", () => {
  it.each([
    ["1 + 2 * 3", 7],
    ["(1 + 2) * 3", 9],
    ["10 - 4 - 3", 3],
    ["100 / 10 / 5", 2],
    ["2 ^ 3 ^ 2", 512],
    ["-2 ^ 2", -4],
    ["2 ^ -1", 0.5],
    ["--3", 3],
    ["+4", 4],
    ["width / 2 - wall", 38],
    ["width - 2 * wall", 76],
    ["1e3", 1000],
    ["2.5E-1", 0.25],
    [".5", 0.5],
    ["5.", 5],
    [12.75, 12.75],
  ])("%s = %d", (src, want) => expect(ev(src)).toBeCloseTo(want, 12));
});

describe("functions", () => {
  it.each([
    ["min(3, wall, 9)", 2],
    ["max(wall, 3) ^ 2", 9],
    ["abs(-7.5)", 7.5],
    ["sqrt(2) * sqrt(2)", 2],
    ["round(2.5)", 3],
    ["round(-2.5)", -2],
    ["floor(2.9)", 2],
    ["ceil(2.1)", 3],
    ["360 / n", 60],
    ["pi * 10", Math.PI * 10],
  ])("%s = %d", (src, want) => expect(ev(src)).toBeCloseTo(want, 12));

  it("takes and gives angles in degrees, like every angle in a design", () => {
    expect(ev("sin(30)")).toBeCloseTo(0.5, 12);
    expect(ev("sin(30 deg)")).toBeCloseTo(0.5, 12);
    expect(ev("cos(60)")).toBeCloseTo(0.5, 12);
    expect(ev("tan(45)")).toBeCloseTo(1, 12);
    expect(ev("sin(0.5235987755982988 rad)")).toBeCloseTo(0.5, 12);
    expect(ev("asin(0.5)")).toBeCloseTo(30, 10);
    expect(ev("acos(0)")).toBeCloseTo(90, 10);
    expect(ev("atan(1)")).toBeCloseTo(45, 10);
    expect(ev("atan2(1, -1)")).toBeCloseTo(135, 10);
    // A bolt circle: x of the second of six holes on a 40 mm circle.
    expect(ev("20 * cos(360 / n)")).toBeCloseTo(10, 10);
  });
});

describe("refused input never becomes a silent number", () => {
  it.each([
    "",
    "   ",
    "wall +",
    "(1 + 2",
    "1 + 2)",
    "foo",
    "2 / 0",
    "1 / (wall - 2)",
    "1 $ 2",
    "nope(1)",
    "max()",
    "sqrt(-1)",
    "1 2",
    "wall wall",
    "10 ^ 400",
    "asin(2)",
    "1,2",
  ])("rejects %j", (src) => {
    expect(() => ev(src)).toThrow();
  });
  it("rejects numbers that are not finite", () => {
    expect(() => evaluate(Infinity, scope)).toThrow();
    expect(() => evaluate(NaN, scope)).toThrow();
  });
});

describe("variables depending on variables", () => {
  it("resolves in dependency order whatever order they are listed in", () => {
    const r = resolveParams({
      outer: "inner + 2 * wall",
      inner: "bore + 2 * gap",
      bore: "8 mm",
      gap: "0.2",
      wall: "1.6",
    });
    expect(r.errors.size).toBe(0);
    expect(r.values.get("inner")).toBeCloseTo(8.4, 12);
    expect(r.values.get("outer")).toBeCloseTo(11.6, 12);
  });

  it("reports cycles, self references and everything that depends on them", () => {
    const r = resolveParams({ a: "b", b: "a + 1", c: "a", self: "self + 1", ok: "3" });
    expect([...r.errors.keys()].sort()).toEqual(["a", "b", "c", "self"]);
    expect(r.values.get("ok")).toBe(3);
  });

  it("reports a missing variable by name", () => {
    const r = resolveParams({ a: "missing * 2" });
    expect(r.errors.get("a")).toMatch(/missing/);
  });

  it("lists referenced names without units, constants or functions", () => {
    expect(referencedNames("max(width, 2 mm) * pi + wall / 1in + cos(angle)").sort()).toEqual([
      "angle",
      "wall",
      "width",
    ]);
    expect(referencedNames(5)).toEqual([]);
  });

  it("renames a variable without touching units or longer names", () => {
    expect(renameInExpr("w + width * 2 mm + w2", "w", "breite")).toBe("breite + width * 2 mm + w2");
    // A variable called like a unit is renamed where it is a variable, kept where it is a unit.
    expect(renameInExpr("mm * 2 + 3 mm", "mm", "x")).toBe("x * 2 + 3 mm");
    expect(renameInExpr(4, "w", "x")).toBe(4);
  });
});
