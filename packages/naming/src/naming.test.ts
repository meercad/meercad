import { describe, expect, it } from "vitest";
import {
  edgeSelectorFor,
  propagateTags,
  resolveEdges,
  resolveFaces,
  ResolveError,
  selectorForEdge,
  type Topology,
} from "./index.js";

// Box: 0 bottom, 1 top, 2..5 sides (bottom,right,top,left). 12 edges.
const sides = ["bottom", "right", "top", "left"];
const box: Topology = {
  bodyId: "ex1",
  faceTags: [["ex1.start_cap"], ["ex1.end_cap"], ...sides.map((s) => [`ex1.side[sk1.r1.${s}]`])],
  edgeFaces: [
    ...sides.map((_, i) => [0, 2 + i]),
    ...sides.map((_, i) => [1, 2 + i]),
    ...sides.map((_, i) => [2 + i, 2 + ((i + 1) % 4)]),
  ],
  faceInfo: [
    { planar: true, normal: [0, 0, -1], area: 800 },
    { planar: true, normal: [0, 0, 1], area: 800 },
    { planar: true, normal: [0, -1, 0], area: 400 },
    { planar: true, normal: [1, 0, 0], area: 200 },
    { planar: true, normal: [0, 1, 0], area: 400 },
    { planar: true, normal: [-1, 0, 0], area: 200 },
  ],
};

describe("resolveEdges", () => {
  it("finds the edge between two faces", () => {
    expect(resolveEdges([{ edge: ["ex1.end_cap", "ex1.side[sk1.r1.top]"] }], [box])).toEqual({
      body: "ex1",
      edges: [6],
    });
  });
  it("finds all edges of a face relative to a feature", () => {
    expect(resolveEdges([{ select: "edges", of: "ex1", where: { face: "end_cap" } }], [box]).edges).toEqual([
      4, 5, 6, 7,
    ]);
    expect(resolveEdges([{ select: "edges", of: "ex1" }], [box]).edges).toHaveLength(12);
    expect(resolveEdges([{ edge: ["ex1.end_cap", "ex1.side[*]"] }], [box]).edges).toEqual([4, 5, 6, 7]);
  });
  it("errors instead of guessing", () => {
    expect(() => resolveEdges([{ edge: ["ex1.end_cap", "ex1.start_cap"] }], [box])).toThrow(ResolveError);
    expect(() => resolveEdges([{ edge: ["ex1.end_cap", "ex9.x"] }], [box])).toThrow(/no edge/);

    const twin = { ...box, bodyId: "ex2" };
    expect(() => resolveEdges([{ edge: ["ex1.end_cap", "ex1.side[sk1.r1.top]"] }], [box, twin])).toThrow(
      /ambiguous|several/,
    );
  });
});

describe("resolveFaces", () => {
  it("filters by normal and picks largest", () => {
    expect(resolveFaces({ select: "faces", where: { planar: true, normal: "+Z" } }, [box])).toEqual([
      { body: "ex1", faces: [1] },
    ]);
    expect(() => resolveFaces({ select: "faces", pick: "largest" }, [box])).toThrow(/ambiguous/);
    expect(resolveFaces({ select: "faces", where: { normal: "+X" }, pick: "largest" }, [box])).toEqual([
      { body: "ex1", faces: [3] },
    ]);
  });
});

describe("tags", () => {
  it("builds order-independent edge selectors", () => {
    expect(edgeSelectorFor(["b"], ["a"])).toEqual({ edge: ["a", "b"] });
    expect(edgeSelectorFor(["a"], ["a"])).toBeNull();
  });
  it("propagates through modify/delete/generate and flags untagged faces", () => {
    const r = propagateTags(
      [["a"], ["b"], ["c"]],
      4,
      { descendants: [[0], [], [1]], generated: [{ face: 2, tag: "fi1.round[x]" }] },
      "fi1",
    );
    expect(r.tags).toEqual([["a"], ["c"], ["fi1.round[x]"], ["fi1.face[3]"]]);
    expect(r.untagged).toEqual([3]);
  });
});

describe("near disambiguation", () => {
  // Two edges share the same face pair (e.g. a side face split by a slot).
  const topo: Topology = {
    bodyId: "b",
    faceTags: [["a"], ["s"]],
    edgeFaces: [
      [0, 1],
      [0, 1],
    ],
    edgePoints: [
      [0, 0, 0],
      [10, 0, 0],
    ],
    facePoints: [
      [0, 0, 0],
      [5, 5, 0],
    ],
  };
  it("picks the nearest edge and only adds near when needed", () => {
    expect(() => resolveEdges([{ edge: ["a", "s"] }], [topo])).toThrow(/ambiguous/);
    expect(resolveEdges([{ edge: ["a", "s"], near: [9, 0, 0] }], [topo]).edges).toEqual([1]);
    expect(selectorForEdge(topo, 1)).toEqual({ edge: ["a", "s"], near: [10, 0, 0] });
    expect(selectorForEdge(box, 6)).toEqual({ edge: ["ex1.end_cap", "ex1.side[sk1.r1.top]"] });
  });
});
