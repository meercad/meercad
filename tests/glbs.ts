/** GLB files of known shape for the tests of terrains and scans. */

/** A GLB of squares (each two triangles) with vertex colours and a small picture view, as the app writes them. */
export function glb(squares: { x: number; y: number; z: number; s: number }[], colorType: 5126 | 5121 | 5123 | 5120 | 5122 = 5126): Uint8Array {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  for (const q of squares) {
    const b = pos.length / 3;
    pos.push(q.x, q.y, q.z, q.x + q.s, q.y, q.z, q.x + q.s, q.y + q.s, q.z, q.x, q.y + q.s, q.z);
    col.push(1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1, 1);
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const image = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  // Colours as floats, or as normalized integers of the given kind (padded to whole 4 bytes).
  const scale = { 5126: 1, 5121: 255, 5123: 65535, 5120: 127, 5122: 32767 }[colorType];
  const Arr = { 5126: Float32Array, 5121: Uint8Array, 5123: Uint16Array, 5120: Int8Array, 5122: Int16Array }[colorType];
  const colBytes = new Uint8Array(Arr.from(col.map((c) => c * scale)).buffer);
  const padded = new Uint8Array(Math.ceil(colBytes.length / 4) * 4);
  padded.set(colBytes);
  const chunks = [new Uint8Array(Float32Array.from(pos).buffer), padded, new Uint8Array(Uint32Array.from(idx).buffer), image];
  let offset = 0;
  const views = chunks.map((c) => ({ buffer: 0, byteOffset: (offset += c.length) - c.length, byteLength: c.length }));
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, COLOR_0: 1 }, indices: 2, mode: 4 }] }],
    accessors: [
      // The true bounds: readers take the model's box from them.
      { bufferView: 0, componentType: 5126, count: pos.length / 3, type: "VEC3", min: [0, 1, 2].map((a) => Math.min(...pos.filter((_, i) => i % 3 === a))), max: [0, 1, 2].map((a) => Math.max(...pos.filter((_, i) => i % 3 === a))) },
      { bufferView: 1, componentType: colorType, count: col.length / 3, type: "VEC3", ...(colorType === 5126 ? {} : { normalized: true }) },
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

