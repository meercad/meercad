/** Cleaning up a GLB reference model: triangles read, kept, cropped, erased, cut and pieces removed. */
import { describe, expect, it } from "vitest";
import { crop, cutHeight, erase, keepTriangles, removeLoosePieces, triangles } from "./glbEdit";

type Data = { componentType: number; type: string; values: number[]; normalized?: boolean };

const SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Bytes of values in a component type (little endian). */
function bytesOf(values: number[], componentType: number): Uint8Array {
  const size = BYTES[componentType]!;
  const out = new Uint8Array(values.length * size);
  const view = new DataView(out.buffer);
  const set: Record<number, (offset: number, v: number) => void> = {
    5120: (o, v) => view.setInt8(o, v),
    5121: (o, v) => view.setUint8(o, v),
    5122: (o, v) => view.setInt16(o, v, true),
    5123: (o, v) => view.setUint16(o, v, true),
    5125: (o, v) => view.setUint32(o, v, true),
    5126: (o, v) => view.setFloat32(o, v, true),
  };

  values.forEach((v, i) => set[componentType]!(i * size, v));

  return out;
}

/**
 * A GLB with one buffer: every accessor in a view of its own (at 4 bytes into it), a picture's view
 * after them (or first: `pictureFirst`, or none: `picture: false`), and `extra` JSON (nodes). A view
 * at the buffer's start has no byteOffset.
 */
function glb(
  accessors: Data[],
  meshes: unknown[],
  extra: Record<string, unknown> = {},
  { picture = true, pictureFirst = false } = {},
): Uint8Array {
  const chunks: Uint8Array[] = [];
  const bufferViews: object[] = [];
  let offset = 0;

  const add = (data: Uint8Array) => {
    while (offset % 4) (chunks.push(new Uint8Array(1)), offset++);
    bufferViews.push({ buffer: 0, ...(offset ? { byteOffset: offset } : {}), byteLength: data.length });
    chunks.push(data);
    offset += data.length;
  };

  const pictureView = () => add(Uint8Array.from([1, 2, 3]));

  if (picture && pictureFirst) pictureView();

  const first = bufferViews.length;
  const json = {
    asset: { version: "2.0" },
    accessors: accessors.map((a, i) => {
      add(Uint8Array.from([...new Uint8Array(4), ...bytesOf(a.values, a.componentType)]));

      return {
        bufferView: first + i,
        byteOffset: 4,
        componentType: a.componentType,
        count: a.values.length / SIZE[a.type]!,
        type: a.type,
        ...(a.normalized ? { normalized: true } : {}),
      };
    }),
    meshes,
    ...(picture
      ? {
          images: [
            { bufferView: pictureFirst ? 0 : accessors.length, mimeType: "image/png" },
            { uri: "outside.png" },
          ],
        }
      : {}),
    ...extra,
  };

  if (picture && !pictureFirst) pictureView();

  while (offset % 4) (chunks.push(new Uint8Array(1)), offset++);

  const text = new TextEncoder().encode(
    JSON.stringify({ ...json, bufferViews, buffers: [{ byteLength: offset }] }),
  );
  const padded = Uint8Array.from([...text, ...new Array<number>((4 - (text.length % 4)) % 4).fill(0x20)]);
  const out = new Uint8Array(20 + padded.length + 8 + offset);
  const view = new DataView(out.buffer);

  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, padded.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(padded, 20);
  view.setUint32(20 + padded.length, offset, true);
  view.setUint32(24 + padded.length, 0x004e4942, true);

  let o = 28 + padded.length;

  for (const chunk of chunks) (out.set(chunk, o), (o += chunk.length));

  return out;
}

/** The GLB's JSON. */
const jsonOf = (file: Uint8Array) => {
  const length = new DataView(file.buffer, file.byteOffset).getUint32(12, true);

  return JSON.parse(new TextDecoder().decode(file.subarray(20, 20 + length)));
};

/**
 * Two squares of two triangles each, side by side at heights 0 and 100, plus a far-off small
 * triangle: indexed (uint16) with texture coordinates in every integer type, and a primitive
 * without indices.
 */
const square = (x: number, z: number, size = 10) => [x, 0, z, x + size, 0, z, x + size, size, z, x, size, z];
const positions = [...square(0, 0), ...square(10, 100)];
const model = glb(
  [
    { componentType: 5126, type: "VEC3", values: positions },
    { componentType: 5123, type: "SCALAR", values: [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7] },
    { componentType: 5121, type: "VEC2", values: Array.from({ length: 16 }, (_, i) => i), normalized: true },
    { componentType: 5122, type: "VEC2", values: Array.from({ length: 16 }, (_, i) => -i) },
    { componentType: 5120, type: "VEC2", values: Array.from({ length: 16 }, (_, i) => i - 8) },
    { componentType: 5123, type: "SCALAR", values: [1, 1, 1, 1, 2, 2, 2, 2] },
    { componentType: 5126, type: "VEC3", values: [500, 500, 0, 501, 500, 0, 500, 501, 0] },
  ],
  [
    {
      primitives: [
        {
          attributes: { POSITION: 0, TEXCOORD_0: 2, TEXCOORD_1: 3, TEXCOORD_2: 4, _PART: 5 },
          indices: 1,
          material: 0,
        },
      ],
    },
    { primitives: [{ attributes: { POSITION: 6 } }] },
  ],
  { nodes: [{ mesh: 0 }, { mesh: 1 }] },
);

describe("triangles", () => {
  it("lists every triangle's corners, indexed or not", () => {
    const { corners, counts } = triangles(model);

    expect(counts).toEqual([4, 1]);
    expect(Array.from(corners.subarray(0, 9))).toEqual([0, 0, 0, 10, 0, 0, 10, 10, 0]);
    expect(Array.from(corners.subarray(36))).toEqual([500, 500, 0, 501, 500, 0, 500, 501, 0]);
  });

  it("refuses what is not a GLB", () => {
    expect(() => triangles(new Uint8Array(32))).toThrow("not a GLB file");
  });
});

describe("keepTriangles", () => {
  it("keeps the triangles asked for, drops unused vertices and keeps the rest of the file", () => {
    const result = keepTriangles(model, (t) => t === 2 || t === 3)!;

    expect(result).toMatchObject({ before: 5, after: 2 });

    const json = jsonOf(result.glb);
    const primitive = json.meshes[0].primitives[0];
    const position = json.accessors[primitive.attributes.POSITION];

    expect(json.meshes).toHaveLength(1);
    expect(position).toMatchObject({ count: 4, min: [10, 0, 100], max: [20, 10, 100] });
    expect(json.accessors[primitive.attributes.TEXCOORD_0]).toMatchObject({
      componentType: 5121,
      normalized: true,
    });
    expect(json.accessors[primitive.indices]).toMatchObject({ componentType: 5125, count: 6 });
    expect(json.images[0].bufferView).toBe(0);
    expect(json.bufferViews[0].byteLength).toBe(3);
    expect(primitive.material).toBe(0);
    expect(Array.from(triangles(result.glb).corners.subarray(0, 3))).toEqual([10, 0, 100]);

    // The integer coordinates come through unchanged.
    const again = keepTriangles(result.glb, (t) => t === 0)!;
    const uv = jsonOf(again.glb).accessors;

    expect(uv.map((a: { componentType: number }) => a.componentType).sort()).toEqual([
      5120, 5121, 5122, 5123, 5125, 5126,
    ]);
  });

  it("gives null when nothing changes and drops meshes that lose every triangle", () => {
    expect(keepTriangles(model, () => true)).toBeNull();

    const none = keepTriangles(model, () => false)!;

    expect(none.after).toBe(0);
    expect(jsonOf(none.glb).meshes).toEqual([]);
    expect(jsonOf(none.glb).nodes).toEqual([{}, {}]);

    const triangle = [{ componentType: 5126, type: "VEC3", values: square(0, 0).slice(0, 9) }];
    const meshes = [{ primitives: [{ attributes: { POSITION: 0 } }] }];
    const plain = glb(triangle, meshes, {}, { picture: false });
    const pictureFirst = glb(triangle, meshes, {}, { pictureFirst: true });

    expect(keepTriangles(plain, () => false)!.after).toBe(0);
    expect(jsonOf(keepTriangles(pictureFirst, () => false)!.glb).bufferViews[0].byteLength).toBe(3);
  });
});

describe("clean-up tools", () => {
  it("crops to an outline seen from above, either side", () => {
    const outline: [number, number, number][] = [
      [-1, -1, 0],
      [11, -1, 0],
      [11, 11, 0],
      [-1, 11, 0],
    ];

    expect(crop(model, outline, true)).toMatchObject({ after: 2 });
    expect(crop(model, outline, false)).toMatchObject({ after: 3 });
  });

  it("erases under a brush stroke near its height", () => {
    // Along the first square at height 0: the second square lies 100 higher but within reach.
    expect(
      erase(
        model,
        [
          [0, 5, 0],
          [30, 5, 0],
        ],
        20,
      ),
    ).toMatchObject({ after: 1 });
    // A single point far above: out of reach.
    expect(erase(model, [[5, 5, 1000]], 20)).toBeNull();
  });

  it("cuts above or below a height", () => {
    expect(cutHeight(model, 50, true)).toMatchObject({ after: 3 });
    expect(cutHeight(model, 50, false)).toMatchObject({ after: 2 });
  });

  it("removes pieces much smaller than the largest", () => {
    expect(removeLoosePieces(model)).toMatchObject({ before: 5, after: 4, pieces: 1 });
    expect(removeLoosePieces(model, 0)).toBeNull();
  });
});
