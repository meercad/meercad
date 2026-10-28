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
    // The mesh is shown with the file's own triangles, without meshing it again.
    const m = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "plate.stl", data }])).meshes[0]!;
    expect(m.indices.length / 3).toBe(r.bodies[0]!.faces);
    expect(m.edgeRanges.length).toBe(0);
  });

  it("keeps its triangles when moved", async () => {
    const { data } = await stlOf(part);
    const s = await newSession();
    const r = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "plate.stl", data }, { id: "mv1", op: "transform", bodies: ["im1"], translate: [0, 0, 50] }]));
    expect(r.report.features.filter((f) => f.status !== "ok")).toEqual([]);
    const zs = Array.from(r.meshes[0]!.positions).filter((_, i) => i % 3 === 2);
    expect(Math.min(...zs)).toBeCloseTo(50, 3);
    expect(r.meshes[0]!.indices.length / 3).toBe(r.report.bodies[0]!.faces);
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
