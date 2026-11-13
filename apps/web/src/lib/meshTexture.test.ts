/**
 * A scan's picture on its part (meshTexture.ts) with the real kernel: a 10 × 10 × 10 cube imported
 * with texture coordinates u = x / 10, v = y / 10 at every corner shows them at every vertex of the
 * part (the same spot of the picture at the same spot of the part); the picture goes out with OBJ;
 * the part menu switches it off and on.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { writeStl } from "@meercad/io";
import type { MeshTexture } from "@meercad/schema";
import { prism } from "../../../../tests/acceptance/meshes";
import { currentDoc, newProject, rebuildNow, useApp } from "../store";
import { importFile, meshExportFiles } from "../components/io";
import { bodyTextures, exportTexture, partTexture, textureToggle } from "./meshTexture";

const b64 = (u: Uint8Array) => btoa(Array.from(u, (c) => String.fromCharCode(c)).join(""));
let body = "";

beforeAll(async () => {
  await newProject(undefined, "Textured");

  const corners = prism(
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ],
    10,
  );
  const stl = writeStl([
    {
      positions: Float32Array.from(corners),
      indices: Uint32Array.from(corners.subarray(0, corners.length / 3), (_, i) => i),
    },
  ]);
  const uv = new Float32Array((corners.length / 3) * 2);

  for (let i = 0; i < corners.length / 3; i++) {
    [uv[i * 2], uv[i * 2 + 1]] = [corners[i * 3]! / 10, corners[i * 3 + 1]! / 10];
  }

  const texture: MeshTexture = {
    uvs: b64(new Uint8Array(uv.buffer)),
    image: b64(new Uint8Array([0xff, 0xd8, 0xff, 0xd9])),
    mime: "image/jpeg",
  };
  expect(await importFile(new File([stl as BlobPart], "cube.stl"), { texture })).toBe(true);
  body = currentDoc().features.find((f) => f.op === "import")!.id;
  await rebuildNow();
});

describe("a scan's picture", () => {
  it("lays the picture's spot for each corner at that corner of the part", () => {
    const meshes = useApp.getState().output!.meshes;
    const [tex] = bodyTextures(currentDoc().features, meshes);
    expect(tex!.bodyId).toBe(body);

    const m = meshes.find((x) => x.bodyId === body)!;
    expect(tex!.uvs.length).toBe((m.positions.length / 3) * 2);

    for (let i = 0; i < m.positions.length / 3; i++) {
      expect(tex!.uvs[i * 2]).toBeCloseTo(m.positions[i * 3]! / 10, 5);
      expect(tex!.uvs[i * 2 + 1]).toBeCloseTo(m.positions[i * 3 + 1]! / 10, 5);
    }
  });

  it("goes out with the part as an OBJ, its picture beside it", async () => {
    const m = useApp.getState().output!.meshes.find((x) => x.bodyId === body)!;
    expect(exportTexture(currentDoc().features, m)!.image).toMatchObject({ mime: "image/jpeg" });

    const { files } = await meshExportFiles("obj");
    expect(Object.keys(files).some((n) => /\.jpe?g$/.test(n))).toBe(true);
    expect(Object.keys(files).some((n) => n.endsWith(".mtl"))).toBe(true);

    const obj = new TextDecoder().decode(files[Object.keys(files).find((n) => n.endsWith(".obj"))!]!);
    expect(obj).toMatch(/^vt /m);
  });

  it("is switched off and on from the part's menu", async () => {
    expect(partTexture(currentDoc().features, useApp.getState().output!.meshes, body)).toMatchObject({
      shown: true,
    });

    const sw = textureToggle(body)!;
    expect(sw.label).toBe("Show without texture");
    sw.onClick();
    await rebuildNow();
    expect(bodyTextures(currentDoc().features, useApp.getState().output!.meshes)).toEqual([]);
    expect(textureToggle(body)!.label).toBe("Show texture");
    textureToggle(body)!.onClick();
    expect(textureToggle("nope")).toBeNull();
  });
});
