import type { TriangleMesh } from "./stl.js";

/** Triangles of a Wavefront OBJ file (polygons are fanned; textures and normals are ignored). Units as written, taken as mm. */
export function readObj(text: string): TriangleMesh {
  const v: number[] = [];
  const idx: number[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.split(/\s+/);
      v.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith("f ")) {
      const count = v.length / 3;
      // "f 1/2/3 4//6 -1": the vertex index comes first; negative counts back from the last vertex.
      const ids = line
        .split(/\s+/)
        .slice(1)
        .map((t) => Number(t.split("/")[0]))
        .map((n) => (n < 0 ? count + n : n - 1));
      for (let i = 1; i + 1 < ids.length; i++) idx.push(ids[0]!, ids[i]!, ids[i + 1]!);
    }
  }
  if (!idx.length || v.some((n) => !Number.isFinite(n)) || idx.some((i) => i < 0 || i >= v.length / 3)) throw new Error("no usable faces in the OBJ file");
  return { positions: Float32Array.from(v), indices: Uint32Array.from(idx) };
}
