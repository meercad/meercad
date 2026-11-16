/** Holes placed beside an edge, far enough in for the wall to hold. */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { edgeInset, holeBesideEdge, type EdgeMesh } from "./holes";

type Hole = Extract<Feature, { op: "hole" }>;

const hole = (more: Partial<Hole>): Hole =>
  ({
    id: "ho1",
    op: "hole",
    plane: { ref: "origin.XY" },
    points: [],
    kind: "clearance",
    size: "M3",
    ...more,
  }) as Hole;

describe("edgeInset", () => {
  it("leaves 1½ diameters to the edge for screws, the insert's wall for inserts", () => {
    expect(edgeInset(hole({ kind: "simple", diameter: 5 }))).toBeCloseTo(7.5);
    expect(edgeInset(hole({ kind: "clearance" }))).toBeCloseTo(5.1);
    expect(edgeInset(hole({ kind: "counterbore" }))).toBeCloseTo(6.4);
    expect(edgeInset(hole({ kind: "countersink" }))).toBeCloseTo(6.96);
    expect(edgeInset(hole({ kind: "insert" }))).toBeCloseTo(3.6);
  });

  it("is not known while the size is not", () => {
    expect(edgeInset(hole({ kind: "simple", diameter: "d" }))).toBeUndefined();
    expect(edgeInset(hole({ size: "M99" }))).toBeUndefined();
  });
});

/**
 * A 10 × 10 square face 0 ("top", z = 0) with a degenerate triangle, a bent face 1, and edges:
 * 0 along y = 0 (with a zero-length piece, then down from x = 10), 1 along y = 10, 2 bordering only
 * the bent face, 3 with no faces, 4 along y = 0 the other way.
 */
const edgeMesh: EdgeMesh = {
  positions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0, 0, 0, 5, 10, 0, 5, 0, 10, 10]),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3, 0, 0, 1, 4, 5, 6, 4, 6, 0]),
  faceRanges: new Int32Array([0, 9, 0, 9, 6, 1]),
  edgeLines: new Float32Array([
    0, 0, 0, 0, 0, 0, 10, 0, 0, 10, 0, -50, 0, 10, 0, 10, 10, 0, 0, 0, 5, 10, 0, 5, 7, 7, 7, 8, 8, 8, 10, 0,
    0, 0, 0, 0,
  ]),
  edgeRanges: new Int32Array([0, 4, 0, 4, 2, 1, 6, 2, 2, 8, 2, 3, 10, 2, 4]),
  faceTags: [["top"], ["bent"]],
  edgeFaces: [[1, 0], [0], [1], [], [0]],
};

describe("holeBesideEdge", () => {
  it("goes inset into the flat face, across from the point of the edge nearest the tap", () => {
    const result = holeBesideEdge(edgeMesh, 0, [4, -1, 0], 3)!;

    expect(result.normal).toEqual([0, 0, 1]);
    expect(result.point[0]).toBeCloseTo(4);
    expect(result.point[1]).toBeCloseTo(3);
    // Along the far edge the same way: inwards is the other side.
    expect(holeBesideEdge(edgeMesh, 1, [20, 11, 0], 2)!.point).toEqual([10, 8, 0]);
    expect(holeBesideEdge(edgeMesh, 4, [4, -1, 0], 3)!.point).toEqual([4, 3, 0]);
  });

  it("takes the face named when it borders the edge", () => {
    expect(holeBesideEdge(edgeMesh, 0, [4, 0, 0], 3, "top")!.normal).toEqual([0, 0, 1]);
    expect(holeBesideEdge(edgeMesh, 0, [4, 0, 0], 3, "elsewhere")!.normal).toEqual([0, 0, 1]);
    expect(holeBesideEdge({ ...edgeMesh, faceTags: [] }, 0, [4, 0, 0], 3, "top")!.normal).toEqual([0, 0, 1]);
  });

  it("gives null without a flat face or without the edge", () => {
    expect(holeBesideEdge(edgeMesh, 2, [5, 0, 5], 3)).toBeNull();
    expect(holeBesideEdge(edgeMesh, 3, [7, 7, 7], 3)).toBeNull();
    expect(holeBesideEdge(edgeMesh, 9, [0, 0, 0], 3)).toBeNull();
    expect(holeBesideEdge({ ...edgeMesh, edgeFaces: [] }, 0, [4, -1, 0], 3)).toBeNull();
  });
});
