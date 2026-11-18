/**
 * Which line stays when an angle changes (angleHold.ts): the first one, unless the other is placed
 * more firmly; its ends held as drag targets and written back exactly as they were.
 */
import { describe, expect, it } from "vitest";
import type { SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { Vec2 } from "@meercad/sketch";
import { anchorLine, changedAngle, firmness, holdLine, keepLine } from "./angleHold";

const entities: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 20, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p1", p2: "p3" },
];
const sketch = (constraints: SketchConstraint[]): SketchFeature => ({
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities,
  constraints,
});
const angle: SketchConstraint = { id: "a", type: "angle", a: "l2", b: "l1", value: 30 };

describe("the line that stays", () => {
  it("is the first one of the angle while neither is placed more firmly", () => {
    const s = sketch([angle]);
    expect(firmness(s, "l1", "l2")).toBe(0);
    expect(anchorLine(s, "l2", "l1")).toBe("l2");
    expect(anchorLine(s, "l1", "l2")).toBe("l1");
    expect(firmness(s, "gone", "l1")).toBe(0);
  });

  it("is the other one when the rest of the sketch places it more firmly", () => {
    const s = sketch([
      angle,
      { id: "h", type: "horizontal", line: "l1" },
      { id: "o", type: "coincident", a: "p2", b: "origin" },
      { id: "b", type: "angle", a: "l1", b: "l9", value: 10 },
    ]);
    expect(firmness(s, "l1", "l2")).toBe(3);
    expect(anchorLine(s, "l2", "l1")).toBe("l1");
  });
});

describe("holding it", () => {
  const points = new Map<string, Vec2>([
    ["p1", [0, 0]],
    ["p2", [40, 0]],
  ]);

  it("pulls its ends to where they are", () => {
    expect(holdLine(sketch([]), "l1", points)).toEqual({ p1: [0, 0], p2: [40, 0] });
    expect(holdLine(sketch([]), "l2", points)).toEqual({ p1: [0, 0] });
    expect(holdLine(sketch([]), "gone", points)).toEqual({});
  });

  it("writes its ends back exactly as stored, the rest as solved", () => {
    const solved = entities.map((x) => (x.type === "point" ? { ...x, x: x.x + 1e-12 } : x));
    const kept = keepLine(entities, solved, "l1");
    expect(kept.find((x) => x.id === "p1")).toBe(entities[0]);
    expect(kept.find((x) => x.id === "p2")).toBe(entities[1]);
    expect(kept.find((x) => x.id === "p3")).toBe(solved[2]);
    expect(keepLine(entities, solved, "gone")).toEqual(solved);
  });
});

describe("a changed angle", () => {
  it("is found when one is added or gets another value, not otherwise", () => {
    const before = [angle, { id: "h", type: "horizontal", line: "l1" } as SketchConstraint];
    expect(changedAngle(before, before)).toBeNull();
    expect(changedAngle(before, [{ ...angle, value: 40 } as SketchConstraint])).toEqual(["l2", "l1"]);
    expect(changedAngle([], [angle])).toEqual(["l2", "l1"]);
    expect(changedAngle(before, [{ ...angle, label: [1, 1] } as SketchConstraint])).toBeNull();
  });
});
