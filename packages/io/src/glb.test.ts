import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { objFiles, readGlb, readObj } from "./index.js";

/** A GLB from typed arrays: one primitive per entry, all on one node with `node` as its transform. */
function glb(
  prims: { pos: number[]; idx: number[]; uv?: number[]; color?: number[]; image?: Uint8Array }[],
  node: Record<string, unknown> = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const views: object[] = [];
  const accessors: object[] = [];

  const add = (bytes: Uint8Array) => {
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    chunks.push(bytes);
    offset += bytes.length;

    const pad = (4 - (offset % 4)) % 4;
    if (pad) (chunks.push(new Uint8Array(pad)), (offset += pad));

    return views.length - 1;
  };

  const acc = (data: number[], type: string, componentType: number) => {
    const bytes =
      componentType === 5125
        ? new Uint8Array(Uint32Array.from(data).buffer)
        : new Uint8Array(Float32Array.from(data).buffer);
    accessors.push({
      bufferView: add(bytes),
      componentType,
      count: data.length / { SCALAR: 1, VEC2: 2, VEC3: 3 }[type]!,
      type,
    });

    return accessors.length - 1;
  };

  const images: object[] = [];
  const materials: object[] = [];
  const primitives = prims.map((p) => {
    const attributes: Record<string, number> = { POSITION: acc(p.pos, "VEC3", 5126) };
    if (p.uv) attributes["TEXCOORD_0"] = acc(p.uv, "VEC2", 5126);
    if (p.color) attributes["COLOR_0"] = acc(p.color, "VEC3", 5126);

    const prim: Record<string, unknown> = { attributes, indices: acc(p.idx, "SCALAR", 5125), mode: 4 };

    if (p.image) {
      images.push({ bufferView: add(p.image), mimeType: "image/jpeg" });
      materials.push({ pbrMetallicRoughness: { baseColorTexture: { index: images.length - 1 } } });
      prim["material"] = materials.length - 1;
    }

    return prim;
  });
  const json: Record<string, unknown> = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...node }],
    meshes: [{ primitives }],
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };

  if (images.length) {
    Object.assign(json, { images, textures: images.map((_, i) => ({ source: i })), materials });
  }

  let text = new TextEncoder().encode(JSON.stringify(json));

  if (text.length % 4) {
    text = Uint8Array.from([...text, ...new Array<number>(4 - (text.length % 4)).fill(0x20)]);
  }

  const bin = new Uint8Array(offset);
  let o = 0;
  for (const c of chunks) (bin.set(c, o), (o += c.length));

  const out = new Uint8Array(12 + 8 + text.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  dv.setUint32(20 + text.length, bin.length, true);
  dv.setUint32(24 + text.length, 0x004e4942, true);
  out.set(bin, 28 + text.length);

  return out;
}

const quad = {
  pos: [0, 0, 0, 10, 0, 0, 10, 10, 0, 0, 10, 0],
  idx: [0, 1, 2, 0, 2, 3],
  uv: [0, 1, 1, 1, 1, 0, 0, 0],
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

describe("GLB reading", () => {
  it("reads positions through the node transform, with UVs and the picture", () => {
    const [m] = readGlb(glb([{ ...quad, image: jpeg }], { translation: [100, 0, 5], scale: [2, 2, 2] }));
    expect(Array.from(m!.positions.slice(6, 9))).toEqual([120, 20, 5]);
    expect(Array.from(m!.uvs!)).toEqual(quad.uv);
    expect(Array.from(m!.image!.data)).toEqual(Array.from(jpeg));
    expect(m!.image!.mime).toBe("image/jpeg");
  });

  it("turns linear vertex colours into sRGB", () => {
    const [m] = readGlb(
      glb([{ pos: quad.pos, idx: quad.idx, color: [1, 0, 0, 0.214, 0.214, 0.214, 0, 0, 1, 0, 0, 0] }]),
    );
    expect(m!.colors![0]).toBeCloseTo(1);
    expect(m!.colors![3]).toBeCloseTo(0.5, 2);
  });
});

describe("OBJ with textures", () => {
  it("writes the OBJ, its materials and the picture, with flipped v", () => {
    const [m] = readGlb(glb([{ ...quad, image: jpeg }]));
    const files = objFiles("My area", [
      { ...m!, name: "Area" },
      {
        positions: new Float32Array(quad.pos),
        indices: new Uint32Array(quad.idx),
        name: "Plate",
        color: "#336699",
      },
    ]);
    expect(Object.keys(files).sort()).toEqual(["My_area-1.jpg", "My_area.mtl", "My_area.obj"]);

    const obj = new TextDecoder().decode(files["My_area.obj"]);
    const mtl = new TextDecoder().decode(files["My_area.mtl"]);
    expect(obj).toContain("mtllib My_area.mtl");
    expect(obj).toContain("usemtl Area_1");
    expect(obj.match(/^vt .*/gm)).toEqual(["vt 0 0", "vt 1 0", "vt 1 1", "vt 0 1"]);
    expect(obj).toContain("f 1/1 2/2 3/3");
    // The plate after it has no picture: plain faces, numbered after the area's corners.
    expect(obj).toContain("f 5 6 7");
    expect(mtl).toContain("newmtl Area_1\nKd 1.0000 1.0000 1.0000\nKs 0 0 0\nillum 1\nmap_Kd My_area-1.jpg");
    expect(mtl).toContain("newmtl Plate_2\nKd 0.2000 0.4000 0.6000");
    expect(readObj(obj).indices.length).toBe(12);
  });

  it("keeps a single OBJ when nothing has a picture", () => {
    const files = objFiles("Parts", [
      { positions: new Float32Array(quad.pos), indices: new Uint32Array(quad.idx) },
    ]);
    expect(Object.keys(files)).toEqual(["Parts.obj"]);
  });

  it("exports the drone example with its texture", () => {
    const doc = JSON.parse(
      readFileSync(new URL("../../../tests/fixtures/terrain-drone-park.meercad", import.meta.url), "utf8"),
    ) as { references: { data: string }[] };
    const meshes = readGlb(Buffer.from(doc.references[0]!.data, "base64"));
    expect(meshes.length).toBeGreaterThan(0);
    expect(meshes.every((m) => m.uvs && m.image)).toBe(true);

    const files = objFiles("park", meshes);
    const obj = new TextDecoder().decode(files["park.obj"]);
    const faces = obj.match(/^f .*/gm)!.length;
    expect(faces).toBe(meshes.reduce((n, m) => n + m.indices.length / 3, 0));
    expect(Object.keys(files).filter((f) => f.endsWith(".jpg")).length).toBeGreaterThan(0);
    expect(Array.from(files["park-1.jpg"]!.subarray(0, 2))).toEqual([0xff, 0xd8]);
  });
});
