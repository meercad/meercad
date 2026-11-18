/**
 * The rules for dragging a sketch line on the model (sketchDrag.ts): which dimensions a drag
 * changes, what they measure afterwards, and where the dragged points are pulled to.
 */
import { describe, expect, it } from "vitest";
import type { SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { Vec2 } from "@meercad/sketch";
import {
  across,
  freedDimensions,
  measure,
  movingPoints,
  pointIdOf,
  pointsMeasured,
  shiftedTargets,
  withMeasured,
} from "./sketchDrag";

const entities: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 0, y: 50 },
  { id: "p3", type: "point", x: 50, y: 50 },
  { id: "p4", type: "point", x: 50, y: 0 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "l3", type: "line", p1: "p3", p2: "p4" },
  { id: "l4", type: "line", p1: "p4", p2: "p1" },
  { id: "c", type: "point", x: 20, y: 20 },
  { id: "k", type: "circle", center: "c", radius: 3 },
];
const sketch = (constraints: SketchConstraint[]): SketchFeature => ({
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities,
  constraints,
});
const points = new Map<string, Vec2>([
  ["p1", [0, 0]],
  ["p2", [0, 50]],
  ["p3", [55, 50]],
  ["p4", [55, 0]],
  ["c", [20, 20]],
]);

describe("point references", () => {
  it("name a point directly, through its line, or the origin", () => {
    const s = sketch([]);
    expect(pointIdOf("p3", s)).toBe("p3");
    expect(pointIdOf("l3.p2", s)).toBe("p4");
    expect(pointIdOf("k.center", s)).toBe("c");
    expect(pointIdOf("origin", s)).toBe("origin");
    expect(pointIdOf("origin.x", s)).toBe("origin.x");
    expect(pointIdOf("gone.p1", s)).toBe("gone.p1");
    expect(pointIdOf("k.radius", s)).toBe("k.radius");
  });
});

describe("dimensions a drag changes", () => {
  const constraints: SketchConstraint[] = [
    { id: "width", type: "length", line: "l2", value: 50 },
    { id: "own", type: "length", line: "l3", value: 50 },
    { id: "named", type: "length", line: "l4", value: "w" },
    { id: "across", type: "distance", a: "p1", b: "l3.p1", value: 50, axis: "x" },
    { id: "toLine", type: "distance", a: "p1", b: "l3", value: 50 },
    { id: "still", type: "distance", a: "p1", b: "p2", value: 50 },
    { id: "hole", type: "distance", a: "c", b: "origin", value: 28 },
    { id: "h", type: "horizontal", line: "l2" },
    { id: "dia", type: "diameter", curve: "k", value: 6 },
    { id: "broken", type: "length", line: "k", value: 4 },
  ];

  it("are lengths and plain-number distances from a moving to a still point", () => {
    const freed = freedDimensions(sketch(constraints), new Set(movingPoints(sketch(constraints), "l3")));
    expect(freed.map((x) => x.id)).toEqual(["width", "across", "toLine"]);
  });

  it("measure between the points of a line, across one axis, or straight to a line", () => {
    const s = sketch(constraints);
    const byId = (id: string) => constraints.find((x) => x.id === id) as Parameters<typeof measure>[0];
    expect(measure(byId("width"), s, points)).toBeCloseTo(55, 9);
    expect(measure(byId("across"), s, points)).toBeCloseTo(55, 9);
    expect(measure(byId("toLine"), s, points)).toBeCloseTo(55, 9);
    expect(measure(byId("still"), s, points)).toBeCloseTo(50, 9);
    expect(measure(byId("hole"), s, points)).toBeCloseTo(Math.hypot(20, 20), 9);
    expect(pointsMeasured(byId("broken"), s)).toEqual([]);
    expect(measure(byId("broken"), s, points)).toBeNull();
    expect(measure(byId("still"), s, new Map())).toBeNull();
  });

  it("measure along y, and from a point to a line of no length", () => {
    const s = sketch([]);
    const alongY: SketchConstraint = { id: "y", type: "distance", a: "p1", b: "p3", value: 1, axis: "y" };
    expect(measure(alongY as Parameters<typeof measure>[0], s, points)).toBeCloseTo(50, 9);

    const dot = new Map(points).set("p3", [55, 0]);
    const toPoint: SketchConstraint = { id: "d", type: "distance", a: "p1", b: "l3", value: 1 };
    expect(measure(toPoint as Parameters<typeof measure>[0], s, dot)).toBeCloseTo(0, 9);
  });

  it("are set to what they measure, rounded; the rest stays as it was", () => {
    const s = sketch(constraints);
    const freed = freedDimensions(s, new Set(["p3", "p4"]));
    const odd = new Map(points).set("p3", [55.123, 50]).set("p4", [55.123, 0]);
    const out = withMeasured(s, freed, odd);
    expect(out.find((x) => x.id === "width")).toMatchObject({ value: 55.12 });
    expect(out.find((x) => x.id === "own")).toBe(constraints[1]);
    expect(withMeasured(s, freed, new Map()).find((x) => x.id === "width")).toBe(constraints[0]);
  });
});

describe("the dragged line", () => {
  it("moves its two ends, across itself", () => {
    const s = sketch([]);
    expect(movingPoints(s, "l3")).toEqual(["p3", "p4"]);
    expect(movingPoints(s, "k")).toEqual([]);

    const normal = across([50, 50], [50, 0]);
    expect(normal[0]).toBeCloseTo(1, 9);
    expect(normal[1]).toBeCloseTo(0, 9);
    expect(across([1, 1], [1, 1])).toEqual([-0, 0]);

    const targets = shiftedTargets(["p3", "p4", "gone"], points, normal, 5);
    expect(targets["p3"]![0]).toBeCloseTo(60, 9);
    expect(targets["p4"]![1]).toBeCloseTo(0, 9);
    expect(targets).not.toHaveProperty("gone");
  });
});
