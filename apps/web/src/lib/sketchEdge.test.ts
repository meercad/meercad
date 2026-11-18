/**
 * Edges of a part traced back to the sketch curve they were swept from (sketchEdge.ts), and the
 * dimensions that size one curve of a sketch.
 */
import { describe, expect, it } from "vitest";
import type { Feature, SketchConstraint, SketchEntity, SketchFeature } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import {
  constraintRefs,
  constraintsOfCurve,
  curveOfEdge,
  curveOfFace,
  curveOfPick,
  needsSize,
  pointsOf,
  sideTag,
  type EdgeTopology,
} from "./sketchEdge";

const entities: SketchEntity[] = [
  { id: "p1", type: "point", x: 0, y: 0 },
  { id: "p2", type: "point", x: 40, y: 0 },
  { id: "p3", type: "point", x: 40, y: 20 },
  { id: "l1", type: "line", p1: "p1", p2: "p2" },
  { id: "l2", type: "line", p1: "p2", p2: "p3" },
  { id: "c0", type: "point", x: 10, y: 10 },
  { id: "k1", type: "circle", center: "c0", radius: 3 },
  { id: "k2", type: "circle", center: "c0", radius: 5 },
  { id: "a0", type: "point", x: 30, y: 10 },
  { id: "a1", type: "point", x: 32, y: 10 },
  { id: "a2", type: "point", x: 30, y: 12 },
  { id: "r1", type: "arc", center: "a0", start: "a1", end: "a2" },
];
const sketch = (constraints: SketchConstraint[] = []): SketchFeature => ({
  id: "sk1",
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities,
  constraints,
});
const features: Feature[] = [
  sketch(),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "ex2", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "join" },
];
/** A part whose edge k lies between the faces with the tags `edges[k]`. */
const mesh = (...edges: [string[], string[]][]): EdgeTopology => ({
  bodyId: "ex1",
  faceTags: edges.flat(),
  edgeFaces: edges.map((_, k) => [2 * k, 2 * k + 1]),
});

describe("side face tags", () => {
  it("name the step, the sketch and the curve, also on a copy or one face of several", () => {
    expect(sideTag("ex1.side[sk1.l1]")).toEqual({ featureId: "ex1", sketchId: "sk1", curveId: "l1" });
    expect(sideTag("ex1.side[sk1.l1:2]")?.curveId).toBe("l1");
    expect(sideTag("ex1.side[sk1.l1]@lp1.1")?.curveId).toBe("l1");
    expect(sideTag("ex1.end_cap")).toBeNull();
    expect(sideTag("ex1.side[3]")).toBeNull();
  });

  it("give the curve of a face swept by a given step from a given sketch", () => {
    const tags = ["ex9.side[sk1.l1]", "ex1.side[sk2.l1]", "ex1.end_cap", "ex1.side[sk1.l2:1]"];
    expect(curveOfFace(tags, "ex1", "sk1")).toBe("l2");
    expect(curveOfFace(tags, "ex1", "sk3")).toBeNull();
  });
});

describe("edges of a part", () => {
  it("between a side and an end of the same step are the sketch curve", () => {
    const part = mesh(
      [["ex1.side[sk1.l1]"], ["ex1.end_cap"]],
      [["ex1.start_cap@lp1.2"], ["ex1.side[sk1.l2]"]],
    );
    expect(curveOfEdge(part, 0, features)).toEqual({ featureId: "ex1", sketchId: "sk1", curveId: "l1" });
    expect(curveOfEdge(part, 1, features)?.curveId).toBe("l2");
  });

  it("between two sides of a step are drawn by the sweep, not a curve", () => {
    const part = mesh([["ex1.side[sk1.l1]"], ["ex1.side[sk1.l2]"]]);
    expect(curveOfEdge(part, 0, features)).toEqual({ featureId: "ex1", sketchId: "sk1", curveId: null });
  });

  it("belong to the latest step that made them, a curve before a sweep's edge", () => {
    const part = mesh([
      ["ex1.side[sk1.l1]", "ex2.side[sk1.l2]"],
      ["ex1.end_cap", "ex2.side[sk1.l1]"],
    ]);
    expect(curveOfEdge(part, 0, features)).toEqual({ featureId: "ex2", sketchId: "sk1", curveId: null });

    const both = mesh([
      ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"],
      ["ex1.end_cap", "ex1.side[sk1.l1:1]"],
    ]);
    expect(curveOfEdge(both, 0, features)?.curveId).toBe("l1");
  });

  it("are not traced to steps or sketches the design no longer has, or to faces of other steps", () => {
    expect(curveOfEdge(mesh([["ex7.side[sk1.l1]"], ["ex7.end_cap"]]), 0, features)).toBeNull();
    expect(curveOfEdge(mesh([["ex1.side[sk7.l1]"], ["ex1.end_cap"]]), 0, features)).toBeNull();
    expect(curveOfEdge(mesh([["ex1.side[sk1.l1]"], ["ex2.end_cap", "f1.round[0]"]]), 0, features)).toBeNull();
    expect(curveOfEdge(mesh([["f1.round[0]"], ["ex1.end_cap"]]), 0, features)).toBeNull();
  });

  it("with one face or an unknown index have no curve", () => {
    const open: EdgeTopology = { bodyId: "ex1", faceTags: [["ex1.side[sk1.l1]"]], edgeFaces: [[0], [0, 5]] };
    expect(curveOfEdge(open, 0, features)).toBeNull();
    expect(curveOfEdge(open, 1, features)).toBeNull();
    expect(curveOfEdge(open, 9, features)).toBeNull();
  });
});

describe("picks", () => {
  const point: [number, number, number] = [0, 0, 0];
  const part = mesh([["ex1.side[sk1.l1]"], ["ex1.end_cap"]]);

  it("of a sketch curve name it, of an edge the curve it was swept from", () => {
    const curvePick: Pick = { kind: "sketch_curve", sketchId: "sk1", curveId: "l2", point };
    expect(curveOfPick(curvePick, [], features)).toEqual({
      featureId: "sk1",
      sketchId: "sk1",
      curveId: "l2",
    });

    const edgePick: Pick = { kind: "edge", bodyId: "ex1", edge: 0, point };
    expect(curveOfPick(edgePick, [part], features)?.curveId).toBe("l1");
    expect(curveOfPick({ ...edgePick, bodyId: "gone" }, [part], features)).toBeNull();
  });

  it("of anything else have none", () => {
    const facePick: Pick = { kind: "face", bodyId: "ex1", face: 0, tags: [], point, normal: null };
    expect(curveOfPick(facePick, [part], features)).toBeNull();
  });
});

describe("dimensions of a curve", () => {
  it("bounding points of each kind of entity", () => {
    expect(entities.map((entity) => pointsOf(entity).join())).toEqual([
      "",
      "",
      "",
      "p1,p2",
      "p2,p3",
      "",
      "c0",
      "c0",
      "",
      "",
      "",
      "a0,a1,a2",
    ]);
  });

  it("refer to entities, not to values, axes or labels", () => {
    const distance: SketchConstraint = {
      id: "d1",
      type: "distance",
      a: "l1.p1",
      b: "p3",
      value: "w",
      axis: "x",
      label: [1, 2],
    };
    expect(constraintRefs(distance)).toEqual(["l1", "p3"]);
  });

  it("are those on the curve, between its own ends and sizes of an equal partner", () => {
    const constraints: SketchConstraint[] = [
      { id: "len", type: "length", line: "l1", value: 40 },
      { id: "across", type: "distance", a: "p1", b: "p2", value: 40, axis: "x" },
      { id: "h", type: "horizontal", line: "l1" },
      { id: "home", type: "distance", a: "p1", b: "origin", value: 2 },
      { id: "other", type: "length", line: "l2", value: 20 },
      { id: "far", type: "distance", a: "p2", b: "p3", value: 20 },
      { id: "eq", type: "equal", a: "k2", b: "k1" },
      { id: "dia", type: "diameter", curve: "k2", value: 10 },
      { id: "fix", type: "fix", point: "origin" },
    ];
    expect([...constraintsOfCurve(sketch(constraints), "l1")].sort()).toEqual(["across", "h", "home", "len"]);
    expect([...constraintsOfCurve(sketch(constraints), "k1")].sort()).toEqual(["dia", "eq"]);
    expect([...constraintsOfCurve(sketch(constraints), "gone")]).toEqual([]);
  });

  it("are missing while nothing sizes the curve", () => {
    expect(needsSize(sketch(), "l1")).toBe(true);
    expect(needsSize(sketch([{ id: "h", type: "horizontal", line: "l1" }]), "l1")).toBe(true);
    expect(needsSize(sketch([{ id: "len", type: "length", line: "l1", value: 4 }]), "l1")).toBe(false);
    expect(needsSize(sketch([{ id: "d", type: "distance", a: "p1", b: "p2", value: 4 }]), "l1")).toBe(false);
    expect(needsSize(sketch([{ id: "eq", type: "equal", a: "k1", b: "k2" }]), "k1")).toBe(false);
    expect(needsSize(sketch([{ id: "r", type: "radius", curve: "r1", value: 2 }]), "r1")).toBe(false);
  });
});
