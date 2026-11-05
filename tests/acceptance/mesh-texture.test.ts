import { describe, expect, it } from "vitest";
import { exportMeshes } from "@meercad/kernel";
import { parseStl, writeStl } from "@meercad/io";
import { restored, snapshot } from "../../packages/model/src/versions.js";
import type { Feature, MeercadDocument } from "@meercad/schema";
import { meshUvs } from "../../apps/web/src/lib/meshUvs";
import { doc, getOcct, newSession, rect, sketch } from "./helpers.js";

/** A 40 × 30 × 10 mm block as an STL in base64, its corners in file order, and its triangles turned round or not. */
async function block(reversed = false): Promise<{ data: string; corners: Float32Array }> {
  const s = await newSession();
  s.rebuild(doc([sketch("sk1", { ref: "origin.XY" }, rect("r", 0, 0, 40, 30)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" }]));
  const [m] = exportMeshes(await getOcct(), s.state!);
  const idx = Uint32Array.from(m!.indices);
  if (reversed) for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2]!, idx[t + 1]!];
  const bytes = writeStl([{ positions: m!.positions, indices: idx }]);
  return { data: Buffer.from(bytes).toString("base64"), corners: parseStl(bytes).positions };
}

/** Picture coordinates made from where each file corner is, so a shown vertex can be checked against its place. */
const uvFor = (x: number, y: number, z: number): [number, number] => [x / 40, (y + z) / 40];
const fileUvs = (corners: Float32Array) => Float32Array.from({ length: (corners.length / 3) * 2 }, (_, i) => uvFor(corners[Math.floor(i / 2) * 3]!, corners[Math.floor(i / 2) * 3 + 1]!, corners[Math.floor(i / 2) * 3 + 2]!)[i % 2]!);

/** Every shown vertex carries the coordinates of the file corner it is, `shift` undone. */
function expectFits(mesh: { positions: Float32Array }, uvs: Float32Array, shift: [number, number, number] = [0, 0, 0]) {
  for (let v = 0; v < mesh.positions.length / 3; v++) {
    const [u, w] = uvFor(mesh.positions[v * 3]! - shift[0], mesh.positions[v * 3 + 1]! - shift[1], mesh.positions[v * 3 + 2]! - shift[2]);
    expect(uvs[v * 2]).toBeCloseTo(u, 4);
    expect(uvs[v * 2 + 1]).toBeCloseTo(w, 4);
  }
}

describe("textures on mesh parts", () => {
  for (const reversed of [false, true])
    it(`follow the file's triangles${reversed ? " wound the other way round" : ""}`, async () => {
      const { data, corners } = await block(reversed);
      const s = await newSession();
      const [m] = s.rebuild(doc([{ id: "im1", op: "import", format: "stl", fileName: "block.stl", data }])).meshes;
      expect(m!.source).toEqual({ feature: "im1", flipped: reversed });
      expectFits(m!, meshUvs(m!, fileUvs(corners))!);
    });

  it("move with the part and with its copies", async () => {
    const { data, corners } = await block();
    const s = await newSession();
    const r = s.rebuild(
      doc([
        { id: "im1", op: "import", format: "stl", fileName: "block.stl", data },
        { id: "mv1", op: "transform", bodies: ["im1"], translate: [100, 0, 20] },
        { id: "pt1", op: "linear_pattern", source: { bodies: ["im1"] }, direction: { ref: "origin.Y" }, count: 2, spacing: 50 },
      ] as Feature[]),
    );
    expect(r.report.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(r.meshes.length).toBe(2);
    for (const m of r.meshes) {
      expect(m.source?.feature).toBe("im1");
      const dy = Math.min(...Array.from(m.positions).filter((_, i) => i % 3 === 1));
      expectFits(m, meshUvs(m, fileUvs(corners))!, [100, Math.round(dy), 20]);
    }
  });

  it("are dropped once the part is cut", async () => {
    const { data } = await block();
    const s = await newSession();
    const [m] = s.rebuild(
      doc([
        { id: "im1", op: "import", format: "stl", fileName: "block.stl", data },
        sketch("sk2", { ref: "origin.XY" }, rect("q", 10, 10, 5, 5)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut" },
      ]),
    ).meshes;
    expect(m!.source).toBeUndefined();
  });

  it("are kept once in a version's blobs and come back whole", () => {
    const image = "J".repeat(10_000);
    const uvs = "U".repeat(20_000);
    const d = doc([{ id: "im1", op: "import", format: "stl", fileName: "scan.stl", data: "D".repeat(5000), texture: { image, mime: "image/jpeg", uvs } }]) as MeercadDocument;
    const blobs: Record<string, string> = {};
    const v = snapshot(d, "v1", 0, blobs);
    const kept = v.state.features[0]!;
    expect(kept.op === "import" && kept.texture?.image.startsWith("blob:") && kept.texture.uvs.startsWith("blob:")).toBe(true);
    const back = restored({ ...d, blobs, versions: [v] }, v).features[0]!;
    expect(back.op === "import" && back.texture).toEqual({ image, mime: "image/jpeg", uvs });
  });
});
