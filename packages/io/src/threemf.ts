import { strToU8, zipSync } from "fflate";
import type { TriangleMesh } from "./stl.js";

/** 3MF package with one object per mesh (units: mm). Duplicate vertices are merged. */
export function write3mf(meshes: readonly (TriangleMesh & { name?: string })[]): Uint8Array {
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
      return `<object id="${i + 1}" type="model" name="${escapeXml(m.name ?? `Body ${i + 1}`)}"><mesh><vertices>${verts.join("")}</vertices><triangles>${tris.join("")}</triangles></mesh></object>`;
    })
    .join("");
  const items = meshes.map((_, i) => `<item objectid="${i + 1}"/>`).join("");
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objects}</resources><build>${items}</build></model>`;
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
