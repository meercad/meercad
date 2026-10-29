import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { TriangleMesh } from "./stl.js";

/**
 * 3MF package with one object per mesh (units: mm). Duplicate vertices are merged. A mesh's
 * `color` ("#rrggbb") becomes a base material with that display colour.
 */
export function write3mf(meshes: readonly (TriangleMesh & { name?: string; color?: string })[]): Uint8Array {
  const colored = meshes.filter((m) => m.color);
  const matId = meshes.length + 1;
  const materials = colored.length ? `<basematerials id="${matId}">${colored.map((m, k) => `<base name="${escapeXml(m.name ?? `Color ${k + 1}`)}" displaycolor="${m.color!.toUpperCase()}FF"/>`).join("")}</basematerials>` : "";
  const objects = meshes
    .map((m, i) => {
      const map = new Map<string, number>();
      const verts: string[] = [];
      const remap = new Uint32Array(m.positions.length / 3);
      for (let v = 0; v < remap.length; v++) {
        const x = m.positions[v * 3]!, y = m.positions[v * 3 + 1]!, z = m.positions[v * 3 + 2]!;
        const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`;
        let idx = map.get(key);
        if (idx === undefined) {
          idx = verts.length;
          map.set(key, idx);
          verts.push(`<vertex x="${x}" y="${y}" z="${z}"/>`);
        }
        remap[v] = idx;
      }
      const tris: string[] = [];
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [remap[m.indices[t]!]!, remap[m.indices[t + 1]!]!, remap[m.indices[t + 2]!]!];
        if (a !== b && b !== c && a !== c) tris.push(`<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
      }
      const k = colored.indexOf(m);
      const material = k >= 0 ? ` pid="${matId}" pindex="${k}"` : "";
      return `<object id="${i + 1}" type="model" name="${escapeXml(m.name ?? `Body ${i + 1}`)}"${material}><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`;
    })
    .join("");
  const items = meshes.map((_, i) => `<item objectid="${i + 1}"/>`).join("");
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${materials}${objects}</resources><build>${items}</build></model>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ),
    "3D/3dmodel.model": strToU8(model),
  });
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

const UNIT_MM: Record<string, number> = { micron: 0.001, millimeter: 1, centimeter: 10, inch: 25.4, foot: 304.8, meter: 1000 };
type Mat = number[];
const IDENTITY: Mat = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
/** 3MF transform "m00 m01 m02 m10 m11 m12 m20 m21 m22 m30 m31 m32" (row vectors: p' = p·M + t). */
const parseMat = (s: string | undefined): Mat => {
  const n = (s ?? "").trim().split(/\s+/).map(Number);
  return n.length === 12 && n.every(Number.isFinite) ? n : IDENTITY;
};
/** a then b. */
const mul = (a: Mat, b: Mat): Mat => {
  const r: Mat = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) r.push((i < 3 ? 0 : b[9 + j]!) + a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!);
  return r;
};
const attr = (tag: string, name: string) => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(tag)?.[1];

interface ModelObject {
  name?: string;
  mesh?: { vertices: number[]; triangles: number[] };
  components: { file: string; id: string; transform: Mat }[];
}

/**
 * Meshes of a 3MF package, one per object placed on the build plate (units: mm). Follows
 * components and their transforms, also into other model files (as slicers write them).
 */
export function read3mf(data: Uint8Array): (TriangleMesh & { name: string })[] {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch {
    throw new Error("not a 3MF file (it is not a zip package)");
  }
  const models = new Map<string, { scale: number; objects: Map<string, ModelObject>; build: { id: string; transform: Mat }[] }>();
  const norm = (p: string) => p.replace(/^\//, "");
  for (const [path, bytes] of Object.entries(files)) {
    if (!path.toLowerCase().endsWith(".model")) continue;
    const xml = strFromU8(bytes);
    const scale = UNIT_MM[attr(/<model\b[^>]*>/.exec(xml)?.[0] ?? "", "unit") ?? "millimeter"] ?? 1;
    const objects = new Map<string, ModelObject>();
    for (const m of xml.matchAll(/<object\b([^>]*)>([\s\S]*?)<\/object>/g)) {
      const [head, body] = [m[1]!, m[2]!];
      const obj: ModelObject = { components: [] };
      const name = attr(head, "name");
      if (name) obj.name = name;
      if (/<mesh\b/.test(body)) {
        const vertices: number[] = [];
        for (const v of body.matchAll(/<vertex\b([^>]*)\/?>/g)) vertices.push(Number(attr(v[1]!, "x")), Number(attr(v[1]!, "y")), Number(attr(v[1]!, "z")));
        const triangles: number[] = [];
        for (const t of body.matchAll(/<triangle\b([^>]*)\/?>/g)) triangles.push(Number(attr(t[1]!, "v1")), Number(attr(t[1]!, "v2")), Number(attr(t[1]!, "v3")));
        obj.mesh = { vertices, triangles };
      }
      for (const c of body.matchAll(/<component\b([^>]*)\/?>/g)) {
        obj.components.push({ file: norm(attr(c[1]!, "p:path") ?? path), id: attr(c[1]!, "objectid") ?? "", transform: parseMat(attr(c[1]!, "transform")) });
      }
      objects.set(attr(head, "id") ?? "", obj);
    }
    const build: { id: string; transform: Mat }[] = [];
    for (const it of xml.matchAll(/<item\b([^>]*)\/?>/g)) build.push({ id: attr(it[1]!, "objectid") ?? "", transform: parseMat(attr(it[1]!, "transform")) });
    models.set(norm(path), { scale, objects, build });
  }
  const root = [...models.entries()].find(([, m]) => m.build.length) ?? [...models.entries()][0];
  if (!root) throw new Error("the 3MF package contains no model");
  const out: (TriangleMesh & { name: string })[] = [];
  root[1].build.forEach((item, k) => {
    const pos: number[] = [];
    const idx: number[] = [];
    let name: string | undefined;
    const visit = (file: string, id: string, t: Mat, depth: number) => {
      const model = models.get(file);
      const obj = model?.objects.get(id);
      if (!model || !obj || depth > 16) return;
      name ??= obj.name;
      if (obj.mesh) {
        const base = pos.length / 3;
        const v = obj.mesh.vertices;
        for (let i = 0; i < v.length; i += 3) {
          const [x, y, z] = [v[i]! * model.scale, v[i + 1]! * model.scale, v[i + 2]! * model.scale];
          pos.push(x * t[0]! + y * t[3]! + z * t[6]! + t[9]! * model.scale, x * t[1]! + y * t[4]! + z * t[7]! + t[10]! * model.scale, x * t[2]! + y * t[5]! + z * t[8]! + t[11]! * model.scale);
        }
        for (const i of obj.mesh.triangles) idx.push(base + i);
      }
      for (const c of obj.components) visit(c.file, c.id, mul(c.transform, t), depth + 1);
    };
    visit(root[0], item.id, item.transform, 0);
    if (idx.length) out.push({ name: name ?? `Object ${k + 1}`, positions: Float32Array.from(pos), indices: Uint32Array.from(idx) });
  });
  if (!out.length) throw new Error("the 3MF file contains no meshes");
  return out;
}
