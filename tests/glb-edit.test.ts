import { describe, expect, it } from "vitest";
import { crop, cutHeight, erase, removeLoosePieces, triangles } from "../apps/web/src/lib/glbEdit.js";

/** A GLB of squares (each two triangles) with vertex colours and a small picture view, as the app writes them. */
function glb(squares: { x: number; y: number; z: number; s: number }[]): Uint8Array {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (const q of squares) {
    const b = pos.length / 3;
    pos.push(q.x, q.y, q.z, q.x + q.s, q.y, q.z, q.x + q.s, q.y + q.s, q.z, q.x, q.y + q.s, q.z);
    col.push(1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const chunks = [new Uint8Array(Float32Array.from(pos).buffer), new Uint8Array(Float32Array.from(col).buffer), new Uint8Array(Uint32Array.from(idx).buffer), image];
  let offset = 0;
  const views = chunks.map((c) => ({ buffer: 0, byteOffset: (offset += c.length) - c.length, byteLength: c.length }));
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 1] },
      { bufferView: 1, componentType: 5126, count: col.length / 3, type: "VEC3" },
      { bufferView: 2, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    images: [{ bufferView: 3, mimeType: "image/jpeg" }],
    bufferViews: views,
    buffers: [{ byteLength: offset }],
  };
  let text = new TextEncoder().encode(JSON.stringify(json));
  while (text.length % 4) text = Uint8Array.from([...text, 0x20]);
  const out = new Uint8Array(20 + text.length + 8 + offset);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true), dv.setUint32(4, 2, true), dv.setUint32(8, out.length, true), dv.setUint32(12, text.length, true), dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  dv.setUint32(20 + text.length, offset, true), dv.setUint32(24 + text.length, 0x004e4942, true);
  let o = 28 + text.length;
  for (const c of chunks) (out.set(c, o), (o += c.length));
  return out;
}

const json = (g: Uint8Array) => JSON.parse(new TextDecoder().decode(g.subarray(20, 20 + new DataView(g.buffer, g.byteOffset).getUint32(12, true)))) as Record<string, unknown>;

describe("cleaning up a scanned area", () => {
  // A 10 m lawn of 1 m tiles at height 0, a 1 m roof at 2.5 m over one tile, a 10 cm floater far off.
  const tiles = Array.from({ length: 100 }, (_, i) => ({ x: (i % 10) * 1000, y: Math.floor(i / 10) * 1000, z: 0, s: 1000 }));
  const model = glb([...tiles, { x: 2000, y: 2000, z: 2500, s: 1000 }, { x: 30000, y: 30000, z: 0, s: 100 }]);

  it("crops to an outline, either way, and drops the vertices no longer used", () => {
    const square = [[0, 0, 0], [3000, 0, 0], [3000, 3000, 0], [0, 3000, 0]] as [number, number, number][];
    const kept = crop(model, square, true)!;
    expect(kept.before).toBe(204);
    expect(kept.after).toBe(9 * 2 + 2);
    expect((json(kept.glb)["accessors"] as { count: number }[])[0]!.count).toBe(10 * 4);
    // The picture survives.
    expect((json(kept.glb)["images"] as unknown[]).length).toBe(1);
    expect(crop(model, square, false)!.after).toBe(204 - 20);
  });

  it("erases under the brush only near the height it was painted at", () => {
    // A stroke across the lawn under the roof: the roof 2.5 m up stays.
    const r = erase(model, [[0, 2500, 0], [10000, 2500, 0]], 400)!;
    expect(r.after).toBe(204 - 20);
    const left = triangles(r.glb).corners;
    let roof = 0;
    for (let i = 2; i < left.length; i += 3) if (left[i]! > 2000) roof++;
    expect(roof).toBe(6);
  });

  it("cuts above a height and removes loose pieces", () => {
    expect(cutHeight(model, 1000, true)!.after).toBe(202);
    const r = removeLoosePieces(model)!;
    expect(r.after).toBe(200);
    expect(r.pieces).toBe(2);
  });
});
