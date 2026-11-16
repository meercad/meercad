/** Which parts come from an imported mesh, without the kernel. */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { FACE_TOOLS, meshBodyIds, meshHint } from "./meshParts";

const features = [
  { id: "im1", op: "import", format: "stl" },
  { id: "im2", op: "import", format: "step" },
  { id: "ex1", op: "extrude" },
] as unknown as Feature[];

describe("meshBodyIds", () => {
  it("finds parts with a face from a mesh import", () => {
    const meshes = [
      { bodyId: "im1", faceTags: [["im1.f1"]] },
      { bodyId: "cut", faceTags: [["ex1.side"], ["ex1.end_cap", "im1.f7"]] },
      { bodyId: "step", faceTags: [["im2.f1"]] },
      { bodyId: "ex1", faceTags: [] },
    ];

    expect([...meshBodyIds(features, meshes)]).toEqual(["im1", "cut"]);
    expect(meshBodyIds(features.slice(1), meshes).size).toBe(0);
  });

  it("names the face tools mesh parts lack and how to get editable faces", () => {
    expect(FACE_TOOLS.has("fillet")).toBe(true);
    expect(meshHint()).toMatch(/\S/);
  });
});
