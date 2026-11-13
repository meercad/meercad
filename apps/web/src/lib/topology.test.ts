/**
 * Picks into selectors and selectors into words (topology.ts): a picked face gives the edges of that
 * face, a pick of nothing usable gives nothing; a sketch line or an edge is an axis, a face is not;
 * edge, face, plane and axis selectors read as words.
 */
import { describe, expect, it } from "vitest";
import type { Pick } from "@meercad/viewport";
import { axisForPick, describeAxis, describeEdgeSelector, describeFaceSelector, describePlane, edgeSelectorForPick } from "./topology";

const face = { kind: "face", bodyId: "ex1", tags: ["ex1.end_cap"] } as unknown as Pick;

describe("picks into selectors", () => {
  it("gives the edges of a picked face, and nothing for what has no edges", () => {
    expect(edgeSelectorForPick(face, [])).toEqual({ select: "edges", where: { face: "ex1.end_cap" } });
    expect(edgeSelectorForPick({ ...face, tags: [] } as unknown as Pick, [])).toBeNull();
    expect(edgeSelectorForPick({ kind: "edge", bodyId: "gone", edge: 0 } as unknown as Pick, [])).toBeNull();
    expect(edgeSelectorForPick({ kind: "sketch_point", sketchId: "sk1", pointId: "p1" } as unknown as Pick, [])).toBeNull();
  });

  it("makes axes of sketch lines and edges, not of faces", () => {
    expect(axisForPick({ kind: "sketch_curve", sketchId: "sk1", curveId: "l2" } as unknown as Pick, [])).toEqual({ line: "sk1.l2" });
    expect(axisForPick({ kind: "edge", bodyId: "gone", edge: 0 } as unknown as Pick, [])).toBeNull();
    expect(axisForPick(face, [])).toBeNull();
  });
});

describe("selectors in words", () => {
  it("reads edges, faces, planes and axes", () => {
    expect(describeEdgeSelector({ select: "edges", where: { face: "ex1.end_cap" } } as never)).toBe("Edges of ex1 · end face");
    expect(describeEdgeSelector({ select: "edges", of: "ex1" } as never)).toBe("All edges of ex1");
    expect(describeEdgeSelector({ select: "edges" } as never)).toBe("All edges of ?");
    expect(describeFaceSelector({ select: "faces", where: { normal: "+Z" }, pick: "max" } as never)).toBe("Faces +Z max");
    expect(describeFaceSelector({ select: "faces" } as never)).toBe("Faces");
    expect(describeFaceSelector({ face: "ex1.side[sk1.l2]" } as never)).toBe("ex1 · side l2");
    expect(describeFaceSelector({ face: "odd tag" } as never)).toBe("odd tag");
    expect(describePlane({ ref: "pl1" })).toBe("pl1");
    expect(describePlane({ face: { face: "ex1.lid_bead" } } as never)).toBe("ex1 · face::lid bead".replace("face::", ""));
    expect(describeAxis({ line: "sk1.l3" })).toBe("sk1 · line l3");
    expect(describeAxis({ ref: "origin.Z" } as never)).toBe("Z axis");
    expect(describeAxis({ edge: { select: "edges", of: "ex1" } } as never)).toBe("All edges of ex1");
  });
});
