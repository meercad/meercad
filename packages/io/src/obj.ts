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

/** OBJ names may not contain whitespace; keep them readable. */
const objName = (s: string) => s.trim().replace(/\s+/g, "_") || "part";

/**
 * Wavefront OBJ of one or more meshes, one `o` object per part (units: mm, Z up, as in STL).
 * Corners shared by triangles are merged, so the file is small and each part stays watertight.
 * A part's colour ("#rrggbb") goes on its vertices as "v x y z r g b", which Blender, MeshLab
 * and the common slicers read; other tools skip the extra numbers.
 */
export function writeObj(meshes: readonly (TriangleMesh & { name?: string; color?: string })[]): string {
  const out: string[] = ["# meerCAD", "# units: mm"];
  let base = 1;
  for (const [i, m] of meshes.entries()) {
    const rgb = m.color && /^#[0-9a-f]{6}$/i.test(m.color) ? [1, 3, 5].map((k) => (parseInt(m.color!.slice(k, k + 2), 16) / 255).toFixed(4)).join(" ") : "";
    out.push(`o ${objName(m.name ?? `part_${i + 1}`)}`);
    const map = new Map<string, number>();
    const remap = new Uint32Array(m.positions.length / 3);
    for (let v = 0; v < remap.length; v++) {
      const x = m.positions[v * 3]!, y = m.positions[v * 3 + 1]!, z = m.positions[v * 3 + 2]!;
      const key = `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}`;
      let k = map.get(key);
      if (k === undefined) {
        k = map.size;
        map.set(key, k);
        out.push(`v ${fmt(x)} ${fmt(y)} ${fmt(z)}${rgb ? ` ${rgb}` : ""}`);
      }
      remap[v] = k;
    }
    for (let t = 0; t < m.indices.length; t += 3) {
      const a = remap[m.indices[t]!]!, b = remap[m.indices[t + 1]!]!, c = remap[m.indices[t + 2]!]!;
      if (a !== b && b !== c && a !== c) out.push(`f ${a + base} ${b + base} ${c + base}`);
    }
    base += map.size;
  }
  return out.join("\n") + "\n";
}

/** Shortest text for a coordinate, at most 6 decimals (well below a micrometre in mm). */
function fmt(n: number): string {
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}
