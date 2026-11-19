/** Viewport picks as persistent selectors, and selectors in words. */
import { afterEach, describe, expect, it } from "vitest";
import type { BodyMesh } from "@meercad/kernel";
import type { Pick } from "@meercad/viewport";
import {
  axisForPick,
  describeAxis,
  describeEdgeSelector,
  describeFaceSelector,
  describePlane,
  edgeSelectorForPick,
  faceSelectorForPick,
  meshTopology,
  planeSpecForPick,
  PLANE_LABELS,
  setFeatureLabels,
} from "./topology";

/**
 * Faces 0 ("ex1.end_cap") and 1 ("ex1.side"), a face 2 sharing the end cap's tag, a face range with
 * no face (-1); edges 0 (between 0 and 1, three points), 1 (one face only), and an edge range with
 * no edge (-1) or no points.
 */
const mesh = {
  bodyId: "ex1",
  positions: new Float32Array([0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 6, 3, 0, 6, 9, 9, 9]),
  indices: new Uint32Array([0, 1, 2, 3, 4, 5, 0, 1, 5]),
  faceRanges: new Int32Array([0, 3, 0, 3, 3, 1, 6, 3, -1, 6, 3, 2]),
  faceTags: [["ex1.end_cap"], ["ex1.side"], ["ex1.end_cap"]],
  edgeLines: new Float32Array([0, 0, 0, 2, 0, 0, 4, 0, 0, 1, 1, 1]),
  edgeRanges: new Int32Array([0, 3, 0, 3, 1, -1, 3, 0, 1]),
  edgeFaces: [[0, 1], [1]],
} as unknown as BodyMesh;

const face = (more: Partial<Extract<Pick, { kind: "face" }>> = {}): Pick => ({
  kind: "face",
  bodyId: "ex1",
  face: 1,
  tags: ["ex1.side"],
  point: [0, 0, 0],
  normal: [0, 0, 1],
  ...more,
});
const edge = (n: number, bodyId = "ex1"): Pick => ({ kind: "edge", bodyId, edge: n, point: [0, 0, 0] });

describe("meshTopology", () => {
  it("puts sample points on the middle of every edge and on a triangle of every face, once per mesh", () => {
    const topology = meshTopology(mesh);

    expect(topology.edgePoints).toEqual([
      [2, 0, 0],
      [0, 0, 0],
    ]);
    expect(topology.facePoints).toEqual([
      [1, 1, 0],
      [4, 3, 7],
      [4, 3, 3],
    ]);
    expect(topology.bodyId).toBe("ex1");
    expect(meshTopology(mesh)).toBe(topology);
  });
});

describe("selectors for picks", () => {
  it("names an edge by its two faces, or all edges of a face", () => {
    expect(edgeSelectorForPick(edge(0), [mesh])).toEqual({ edge: ["ex1.end_cap", "ex1.side"] });
    expect(edgeSelectorForPick(edge(0, "other"), [mesh])).toBeNull();
    expect(edgeSelectorForPick(face(), [mesh])).toEqual({ select: "edges", where: { face: "ex1.side" } });
    expect(edgeSelectorForPick(face({ tags: [] }), [mesh])).toBeNull();
    expect(edgeSelectorForPick({ kind: "plane", planeId: "origin.XY", point: [0, 0, 0] }, [mesh])).toBeNull();
  });

  it("names a face by its tag, with a point where the tag is shared", () => {
    expect(faceSelectorForPick(face(), [mesh])).toEqual({ face: "ex1.side" });
    expect(faceSelectorForPick(face({ face: 0 }), [mesh])).toEqual({ face: "ex1.end_cap", near: [1, 1, 0] });
    expect(faceSelectorForPick(face({ bodyId: "other" }), [mesh])).toBeNull();
    expect(faceSelectorForPick(edge(0), [mesh])).toBeNull();
  });

  it("takes planes from origin planes and flat faces", () => {
    expect(planeSpecForPick({ kind: "plane", planeId: "pl1", point: [0, 0, 0] }, [mesh])).toEqual({
      ref: "pl1",
    });
    expect(planeSpecForPick(face(), [mesh])).toEqual({ face: { face: "ex1.side" } });
    expect(planeSpecForPick(face({ bodyId: "other" }), [mesh])).toBeNull();
    expect(planeSpecForPick(face({ normal: null }), [mesh])).toBeNull();
    expect(planeSpecForPick(edge(0), [mesh])).toBeNull();
  });

  it("takes axes from sketch lines and edges", () => {
    const line: Pick = { kind: "sketch_curve", sketchId: "sk1", curveId: "l2", point: [0, 0, 0] };

    expect(axisForPick(line, [mesh])).toEqual({ line: "sk1.l2" });
    expect(axisForPick(edge(0), [mesh])).toEqual({ edge: { edge: ["ex1.end_cap", "ex1.side"] } });
    expect(axisForPick(edge(1), [mesh])).toBeNull();
    expect(axisForPick(face(), [mesh])).toBeNull();
  });
});

describe("selectors in words", () => {
  afterEach(() => setFeatureLabels((id) => id));

  it("names faces by feature and kind", () => {
    // Before the store gives names: the feature's id.
    expect(describeFaceSelector({ face: "ex1.side" })).toBe("ex1 · side");
    setFeatureLabels((id) => (id === "ex1" ? "Extrude 1" : id));

    expect(describeFaceSelector({ face: "ex1.end_cap" })).toBe("Extrude 1 · end face");
    expect(describeFaceSelector({ face: "ex1.side[sk1.l2]" })).toBe("Extrude 1 · side l2");
    expect(describeFaceSelector({ face: "ex1.lid_top" })).toContain("lid top");
    expect(describeFaceSelector({ face: "ex1.odd_kind" })).toBe("Extrude 1 · odd kind");
    expect(describeFaceSelector({ face: "loose" })).toBe("loose");
    expect(describeFaceSelector({ select: "faces", where: { normal: "+Z" }, pick: "largest" })).toBe(
      "Faces +Z largest",
    );
    expect(describeFaceSelector({ select: "faces" })).toBe("Faces");
  });

  it("names edges, planes and axes", () => {
    expect(describeEdgeSelector({ edge: ["ex1.end_cap", "ex1.side"] })).toBe(
      "Edge: ex1 · end face / ex1 · side",
    );
    expect(describeEdgeSelector({ select: "edges", where: { face: "ex1.side" } })).toBe(
      "Edges of ex1 · side",
    );
    expect(describeEdgeSelector({ select: "edges", of: "fi1" })).toBe("All edges of fi1");
    expect(describeEdgeSelector({ select: "edges" })).toBe("All edges of ?");

    expect(describePlane({ ref: "origin.XY" })).toBe(`${PLANE_LABELS["origin.XY"]} plane`);
    expect(describePlane({ ref: "origin.UV" })).toBe("origin.UV plane");
    expect(describePlane({ ref: "pl1" })).toBe("pl1");
    expect(describePlane({ face: { face: "ex1.side" } })).toBe("ex1 · side");

    expect(describeAxis({ ref: "origin.Z" })).toBe("Z axis");
    expect(describeAxis({ line: "sk1.l2" })).toBe("sk1 · line l2");
    expect(describeAxis({ line: "sk1" })).toBe("sk1 · line");
    expect(describeAxis({ edge: { select: "edges", of: "fi1" } })).toBe("All edges of fi1");
  });
});
