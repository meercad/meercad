import type { TriangleMesh } from "./stl.js";

/**
 * Triangles of a Wavefront OBJ file (polygons are fanned; textures and normals are ignored). Units as
 * written, taken as mm.
 */
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

  if (!idx.length || v.some((n) => !Number.isFinite(n)) || idx.some((i) => i < 0 || i >= v.length / 3)) {
    throw new Error("no usable faces in the OBJ file");
  }

  return { positions: Float32Array.from(v), indices: Uint32Array.from(idx) };
}

/** OBJ names may not contain whitespace; keep them readable. */
const objName = (s: string) => s.trim().replace(/\s+/g, "_") || "part";

/** A mesh for OBJ: a part (with its colour) or a scan or terrain (with texture or vertex colours). */
export interface ObjMesh extends TriangleMesh {
  name?: string;
  /** "#rrggbb" for the whole mesh. */
  color?: string;
  /** Three per vertex (sRGB, 0–1); wins over `color`. */
  colors?: Float32Array;
  /** Two per vertex, glTF convention (v runs down the image). Needs `texture`. */
  uvs?: Float32Array;
  /** File name of the picture laid on the mesh, next to the OBJ. */
  texture?: string;
}

const hexRgb = (c?: string) =>
  c && /^#[0-9a-f]{6}$/i.test(c) ? [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16) / 255) : undefined;
const materialName = (mesh: ObjMesh, i: number) => `${objName(mesh.name ?? `part_${i + 1}`)}_${i + 1}`;

/**
 * Wavefront OBJ of one or more meshes, one `o` object per part (units: mm, Z up, as in STL).
 * Corners shared by triangles are merged, so the file is small and each part stays watertight
 * (corners on a texture seam stay apart, as their picture positions differ).
 * Colours go on the vertices as "v x y z r g b", which Blender, MeshLab and the common slicers
 * read; other tools skip the extra numbers. With `mtllib`, every mesh also gets its material
 * (colour and texture) from that file, see writeMtl.
 */
export function writeObj(meshes: readonly ObjMesh[], opts: { mtllib?: string } = {}): string {
  const out: string[] = ["# meerCAD", "# units: mm"];
  if (opts.mtllib) out.push(`mtllib ${opts.mtllib}`);

  let base = 1;
  let uvBase = 1;

  for (const [i, mesh] of meshes.entries()) {
    const flat = hexRgb(mesh.color);
    const textured = !!(mesh.uvs && mesh.texture);
    out.push(`o ${objName(mesh.name ?? `part_${i + 1}`)}`);
    if (opts.mtllib) out.push(`usemtl ${materialName(mesh, i)}`);

    const map = new Map<string, number>();
    const remap = new Uint32Array(mesh.positions.length / 3);
    const uvLines: string[] = [];

    for (let v = 0; v < remap.length; v++) {
      const x = mesh.positions[v * 3]!,
        y = mesh.positions[v * 3 + 1]!,
        z = mesh.positions[v * 3 + 2]!;
      const rgb = mesh.colors
        ? [mesh.colors[v * 3]!, mesh.colors[v * 3 + 1]!, mesh.colors[v * 3 + 2]!]
        : flat;
      const uv = textured ? [mesh.uvs![v * 2]!, 1 - mesh.uvs![v * 2 + 1]!] : undefined;
      const key = `${x.toFixed(5)} ${y.toFixed(5)} ${z.toFixed(5)}${uv ? ` ${uv[0]!.toFixed(6)} ${uv[1]!.toFixed(6)}` : ""}${mesh.colors ? ` ${rgb!.map((c) => c.toFixed(3)).join(" ")}` : ""}`;
      let k = map.get(key);

      if (k === undefined) {
        k = map.size;
        map.set(key, k);
        out.push(`v ${fmt(x)} ${fmt(y)} ${fmt(z)}${rgb ? ` ${rgb.map((c) => c.toFixed(4)).join(" ")}` : ""}`);
        if (uv) uvLines.push(`vt ${fmt(uv[0]!)} ${fmt(uv[1]!)}`);
      }

      remap[v] = k;
    }

    out.push(...uvLines);

    for (let t = 0; t < mesh.indices.length; t += 3) {
      const a = remap[mesh.indices[t]!]!,
        b = remap[mesh.indices[t + 1]!]!,
        c = remap[mesh.indices[t + 2]!]!;
      if (a === b || b === c || a === c) continue;

      out.push(
        textured
          ? `f ${a + base}/${a + uvBase} ${b + base}/${b + uvBase} ${c + base}/${c + uvBase}`
          : `f ${a + base} ${b + base} ${c + base}`,
      );
    }

    base += map.size;
    if (textured) uvBase += map.size;
  }

  return out.join("\n") + "\n";
}

/**
 * The materials of writeObj's meshes: the part colour, or the texture picture. Scans and terrains
 * already hold their light in the picture, so the materials have no shine (illum 1).
 */
export function writeMtl(meshes: readonly ObjMesh[]): string {
  const out: string[] = ["# meerCAD"];

  for (const [i, mesh] of meshes.entries()) {
    const rgb = (mesh.texture && mesh.uvs ? undefined : hexRgb(mesh.color)) ?? [1, 1, 1];
    out.push(
      "",
      `newmtl ${materialName(mesh, i)}`,
      `Kd ${rgb.map((c) => c.toFixed(4)).join(" ")}`,
      "Ks 0 0 0",
      "illum 1",
    );
    if (mesh.texture && mesh.uvs) out.push(`map_Kd ${mesh.texture}`);
  }

  return out.join("\n") + "\n";
}

/** Shortest text for a number, at most 6 decimals (well below a micrometre in mm). */
function fmt(n: number): string {
  const s = n.toFixed(6).replace(/\.?0+$/, "");

  return s === "-0" ? "0" : s;
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/**
 * Everything an OBJ needs to look right elsewhere: just `<name>.obj` when no mesh has a picture,
 * otherwise also `<name>.mtl` and the pictures (`<name>-1.jpg`, …), named without spaces so every
 * reader finds them. Meshes sharing one picture share its file.
 */
export function objFiles(
  name: string,
  meshes: readonly (ObjMesh & { image?: { data: Uint8Array; mime: string } })[],
): Record<string, Uint8Array> {
  const enc = new TextEncoder();
  const file = objName(name);

  if (!meshes.some((m) => m.image && m.uvs)) {
    return { [`${file}.obj`]: enc.encode(writeObj(meshes.map(({ uvs: _u, texture: _t, ...m }) => m))) };
  }

  const files: Record<string, Uint8Array> = {};
  const named = new Map<Uint8Array, string>();
  const withTextures = meshes.map(({ image, ...m }) => {
    if (!image || !m.uvs) return { ...m, texture: undefined };

    let tex = named.get(image.data);

    if (!tex) {
      tex = `${file}-${named.size + 1}.${EXT[image.mime] ?? "jpg"}`;
      named.set(image.data, tex);
      files[tex] = image.data;
    }

    return { ...m, texture: tex };
  });
  files[`${file}.obj`] = enc.encode(writeObj(withTextures, { mtllib: `${file}.mtl` }));
  files[`${file}.mtl`] = enc.encode(writeMtl(withTextures));

  return files;
}
