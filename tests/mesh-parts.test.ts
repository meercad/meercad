import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { meshBodyIds } from "../apps/web/src/lib/meshParts";

describe("mesh parts", () => {
  const features = [
    { id: "im1", op: "import", format: "stl", fileName: "vase.stl", data: "" },
    { id: "im2", op: "import", format: "step", fileName: "bracket.step", data: "" },
  ] as Feature[];

  it("are the parts whose faces still come from a mesh import, also after a cut or move", () => {
    const ids = meshBodyIds(features, [
      { bodyId: "im1", faceTags: [["im1.face[0]"], ["ex1.side[sk1.l1]"]] },
      { bodyId: "mv1_im1", faceTags: [["im1.face[3]@mv1"]] },
      { bodyId: "im2", faceTags: [["im2.face[0]"]] },
      { bodyId: "ex1", faceTags: [["ex1.end_cap"]] },
    ]);
    expect([...ids].sort()).toEqual(["im1", "mv1_im1"]);
  });
});
