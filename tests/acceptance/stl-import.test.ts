import { describe, expect, it } from "vitest";
import { exportMeshes } from "@meercad/kernel";
import { writeStl } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

/** A part away from the origin (like a slicer plate export): 55 × 40 × 12 mm block with a Ø10 hole. */
const part: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 100, 110, 55, 40), ...circle("c1", 127, 130, 5)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 12, mode: "new_body" },
];

async function stlOf(features: Feature[], drop = 0): Promise<{ data: string; volume: number }> {
  const s = await newSession();
  const r = s.rebuild(doc(features)).report;
  const meshes = exportMeshes(await getOcct(), s.state!);
  if (drop) meshes[0]!.indices = meshes[0]!.indices.slice(0, meshes[0]!.indices.length - drop * 3);
  return { data: Buffer.from(writeStl(meshes)).toString("base64"), volume: r.bodies[0]!.volume };
}

describe("STL import", () => {
  it("turns a closed mesh into a solid body, wherever it sits", async () => {
    const { data, volume } = await stlOf(part);
    const s = await newSession();
    const r = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "plate.stl", data }])).report;
    expect(r.features.find((f) => f.id === "im1")?.status).toBe("ok");
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeCloseTo(volume, -1);
    expect(r.bodies[0]!.bbox.min[0]).toBeCloseTo(100, 1);
    // Flat sides become single faces; the hole wall stays a ring of narrow flat strips (an STL has no
    // real curves), so far fewer faces than the export's thousands of triangles.
    expect(r.bodies[0]!.faces).toBeLessThan(400);
  });

  it("can be cut like any other body", async () => {
    const { data, volume } = await stlOf(part);
    const s = await newSession();
    const r = s.rebuild(
      doc([
        { id: "im1", op: "import", format: "stl", fileName: "plate.stl", data },
        sketch("sk2", { ref: "origin.XY" }, rect("q", 140, 115, 10, 10)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut" },
      ]),
    ).report;
    expect(r.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(volume - r.bodies[0]!.volume).toBeCloseTo(10 * 10 * 12, -1);
  });

  it("reports an open mesh instead of silently making nothing", async () => {
    const { data } = await stlOf(part, 6);
    const s = await newSession();
    const r = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "open.stl", data }])).report;
    const f = r.features.find((x) => x.id === "im1")!;
    expect(f.status).toBe("error");
    expect(f.message).toMatch(/not a closed solid/);
  });
});
