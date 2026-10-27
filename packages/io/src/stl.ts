export interface TriangleMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

/** Binary STL of one or more indexed triangle meshes (units: mm). Facet normals are computed from winding. */
export function writeStl(meshes: readonly TriangleMesh[], header = "meerCAD"): Uint8Array {
  const triangles = meshes.reduce((n, m) => n + m.indices.length / 3, 0);
  const out = new Uint8Array(84 + triangles * 50);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(header.slice(0, 80)));
  view.setUint32(80, triangles, true);
  let o = 84;
  for (const { positions: p, indices: idx } of meshes) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t]! * 3;
      const b = idx[t + 1]! * 3;
      const c = idx[t + 2]! * 3;
      const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
      const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len; ny /= len; nz /= len;
      for (const v of [nx, ny, nz]) { view.setFloat32(o, v, true); o += 4; }
      for (const i of [a, b, c]) {
        view.setFloat32(o, p[i]!, true);
        view.setFloat32(o + 4, p[i + 1]!, true);
        view.setFloat32(o + 8, p[i + 2]!, true);
        o += 12;
      }
      o += 2; // attribute byte count
    }
  }
  return out;
}

/** Reads a binary STL back into triangles (used for tests and later as reference-mesh import). */
export function readStl(data: Uint8Array): { triangles: number; vertices: Float32Array } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const triangles = view.getUint32(80, true);
  if (data.byteLength !== 84 + triangles * 50) throw new Error("not a binary STL (size mismatch)");
  const vertices = new Float32Array(triangles * 9);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 9; k++) vertices[t * 9 + k] = view.getFloat32(84 + t * 50 + 12 + k * 4, true);
  }
  return { triangles, vertices };
}

/** Signed volume enclosed by a closed triangle soup (divergence theorem). */
export function meshVolume(vertices: Float32Array): number {
  let v = 0;
  for (let i = 0; i < vertices.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = vertices.subarray(i, i + 9) as unknown as number[];
    v += (ax! * (by! * cz! - bz! * cy!) - ay! * (bx! * cz! - bz! * cx!) + az! * (bx! * cy! - by! * cx!)) / 6;
  }
  return v;
}

/** Parses binary or ASCII STL into an indexed mesh (vertices are not merged). */
export function parseStl(data: Uint8Array): TriangleMesh {
  const head = new TextDecoder().decode(data.subarray(0, Math.min(data.length, 512))).trimStart();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const isBinary = data.byteLength >= 84 && data.byteLength === 84 + view.getUint32(80, true) * 50;
  let vertices: Float32Array;
  if (isBinary || !head.startsWith("solid")) {
    vertices = readStl(data).vertices;
  } else {
    const text = new TextDecoder().decode(data);
    const nums: number[] = [];
    const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
    for (let m = re.exec(text); m; m = re.exec(text)) nums.push(Number(m[1]), Number(m[2]), Number(m[3]));
    if (nums.length % 9 !== 0 || nums.some((n) => !Number.isFinite(n))) throw new Error("malformed ASCII STL");
    vertices = Float32Array.from(nums);
  }
  return { positions: vertices, indices: Uint32Array.from({ length: vertices.length / 3 }, (_, i) => i) };
}
