/**
 * Face and edge selectors pick exactly what they name, and refuse rather than guess: by normal,
 * by flatness, the largest or smallest face, the nearest of several, across parts.
 */
import { describe, expect, it } from "vitest";
import { resolveEdges, resolveFaces, ResolveError, selectorForEdge, selectorForFace, type Topology } from "./index.js";

const sides = ["bottom", "right", "top", "left"];
const box = (id: string, w = 40, d = 20): Topology => ({
  bodyId: id,
  faceTags: [[`${id}.start_cap`], [`${id}.end_cap`], ...sides.map((s) => [`${id}.side[sk1.r1.${s}]`])],
  edgeFaces: [...sides.map((_, i) => [0, 2 + i]), ...sides.map((_, i) => [1, 2 + i]), ...sides.map((_, i) => [2 + i, 2 + ((i + 1) % 4)])],
  faceInfo: [
    { planar: true, normal: [0, 0, -1], area: w * d },
    { planar: true, normal: [0, 0, 1], area: w * d },
    { planar: true, normal: [0, -1, 0], area: w * 10 },
    { planar: true, normal: [1, 0, 0], area: d * 10 },
    { planar: true, normal: [0, 1, 0], area: w * 10 },
    { planar: true, normal: [-1, 0, 0], area: d * 10 },
  ],
  facePoints: [[w / 2, d / 2, 0], [w / 2, d / 2, 10], [w / 2, 0, 5], [w, d / 2, 5], [w / 2, d, 5], [0, d / 2, 5]],
  edgePoints: Array.from({ length: 12 }, (_, e) => [e, 0, 0] as [number, number, number]),
});

describe("faces", () => {
  const b = box("ex1");
  it("by normal and flatness", () => {
    expect(resolveFaces({ select: "faces", of: "ex1", where: { normal: "+Z" } }, [b])).toEqual([{ body: "ex1", faces: [1] }]);
    expect(resolveFaces({ select: "faces", of: "ex1", where: { normal: "-X" } }, [b])).toEqual([{ body: "ex1", faces: [5] }]);
    expect(resolveFaces({ select: "faces", of: "ex1", where: { planar: true } }, [b])[0]!.faces).toHaveLength(6);
    expect(() => resolveFaces({ select: "faces", of: "ex1", where: { planar: false } }, [b])).toThrow(/no face matches/);
  });
  it("the largest or smallest, and refuses a tie", () => {
    expect(() => resolveFaces({ select: "faces", of: "ex1", pick: "largest" }, [b])).toThrow(/ambiguous \(2 faces/);
    expect(resolveFaces({ select: "faces", of: "ex1", where: { normal: "+Z" }, pick: "largest" }, [b])).toEqual([{ body: "ex1", faces: [1] }]);
    const odd = { ...b, faceInfo: b.faceInfo!.map((f, i) => ({ ...f, area: i === 3 ? 1 : f.area + i })) };
    expect(resolveFaces({ select: "faces", of: "ex1", pick: "smallest" }, [odd])).toEqual([{ body: "ex1", faces: [3] }]);
  });
  it("a tag shared by several faces: the one nearest to a point", () => {
    const two = [box("ex1"), { ...box("ex2"), faceTags: box("ex2").faceTags.map((t) => t.map((x) => x.replace("ex2", "ex1"))), facePoints: box("ex2").facePoints!.map((p) => [p[0] + 100, p[1], p[2]] as [number, number, number]) }];
    expect(resolveFaces({ face: "ex1.end_cap" }, two)).toHaveLength(2);
    expect(resolveFaces({ face: "ex1.end_cap", near: [120, 10, 10] }, two)).toEqual([{ body: "ex2", faces: [1] }]);
    expect(() => resolveFaces({ face: "ex9.end_cap" }, two)).toThrow(/no face tagged "ex9.end_cap"/);
  });
  it("a selector for a face adds a point only when its name is shared", () => {
    expect(selectorForFace(b, 1)).toEqual({ face: "ex1.end_cap" });
    const shared = { ...b, faceTags: b.faceTags.map((t, i) => (i < 2 ? ["ex1.cap"] : t)) };
    expect(selectorForFace(shared, 1)).toEqual({ face: "ex1.cap", near: [20, 10, 10] });
    expect(selectorForFace({ ...b, faceTags: [[], ...b.faceTags.slice(1)] }, 0)).toBeNull();
  });
});

describe("edges", () => {
  it("refuses edges of two parts at once, nothing, and a face pair without an edge", () => {
    expect(() => resolveEdges([{ select: "edges", of: "ex1" }, { select: "edges", of: "ex2" }], [box("ex1"), box("ex2")])).toThrow(/span several bodies/);
    expect(() => resolveEdges([], [box("ex1")])).toThrow(/no edges selected/);
    expect(() => resolveEdges([{ edge: ["ex1.start_cap", "ex1.end_cap"] }], [box("ex1")])).toThrow(/no edge between faces/);
    expect(() => resolveEdges([{ select: "edges", of: "ex9" }], [box("ex1")])).toThrow(/no edges on faces matching "ex9.\[\*\]"/);
    expect(() => resolveEdges([{ select: "edges" } as never], [box("ex1")])).toThrow(/needs `of` or `where.face`/);
  });
  it("an ambiguous face pair takes the edge nearest to its point, a wildcard takes them all", () => {
    // Two boxes merged into one body with the same tags: the top-front edge exists twice.
    const a = box("ex1");
    const merged: Topology = {
      bodyId: "ex1",
      faceTags: [...a.faceTags, ...a.faceTags],
      edgeFaces: [...a.edgeFaces, ...a.edgeFaces.map((f) => f.map((x) => x + 6))],
      edgePoints: Array.from({ length: 24 }, (_, e) => [e, 0, 0] as [number, number, number]),
    };
    const sel = { edge: ["ex1.end_cap", "ex1.side[sk1.r1.top]"] as [string, string] };
    expect(() => resolveEdges([sel], [merged])).toThrow(/ambiguous \(2 edges match\)/);
    expect(resolveEdges([{ ...sel, near: [18.2, 0, 0] }], [merged])).toEqual({ body: "ex1", edges: [18] });
    expect(resolveEdges([{ edge: ["ex1.end_cap", "ex1.[*]"] }], [merged]).edges).toEqual([4, 5, 6, 7, 16, 17, 18, 19]);
    // The selector made for such an edge carries its point.
    expect(selectorForEdge(merged, 18)).toEqual({ ...sel, near: [18, 0, 0] });
    expect(selectorForEdge(merged, 99)).toBeNull();
  });
});
