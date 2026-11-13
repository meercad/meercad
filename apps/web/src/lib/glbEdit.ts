/**
 * Cleaning up a terrain or scanned area (a GLB reference model): removing triangles by a test on
 * their corners (cropped to an outline, erased with a brush, cut above a height) or the loose pieces
 * of a scan. Vertices no triangle uses any more are dropped, so the file shrinks; textures stay.
 * Works on the GLBs meerCAD writes (one buffer, float positions, uint32 or uint16 indices).
 */

type Vec3 = [number, number, number];

interface Gltf {
  buffers: { byteLength: number }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; target?: number }[];
  accessors: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
    min?: number[];
    max?: number[];
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[];
  }[];
  [key: string]: unknown;
}

const SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function parse(glb: Uint8Array): { json: Gltf; bin: Uint8Array } {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");

  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLength))) as Gltf;
  const binStart = 20 + jsonLength + 8;
  const binLength = view.getUint32(20 + jsonLength, true);

  return { json, bin: glb.subarray(binStart, binStart + binLength) };
}

/** An accessor's values as numbers, `size` per element. */
function read(json: Gltf, bin: Uint8Array, index: number): { values: Float64Array; size: number } {
  const a = json.accessors[index]!;
  const v = json.bufferViews[a.bufferView!]!;
  const size = SIZE[a.type]!;
  const bytes = BYTES[a.componentType]!;
  const stride = size * bytes;
  const start = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(bin.buffer, start, a.count * stride);
  const out = new Float64Array(a.count * size);

  for (let i = 0; i < a.count; i++) {
    for (let k = 0; k < size; k++) {
      const o = i * stride + k * bytes;
      out[i * size + k] =
        a.componentType === 5126
          ? dv.getFloat32(o, true)
          : a.componentType === 5125
            ? dv.getUint32(o, true)
            : a.componentType === 5123
              ? dv.getUint16(o, true)
              : a.componentType === 5121
                ? dv.getUint8(o)
                : a.componentType === 5122
                  ? dv.getInt16(o, true)
                  : dv.getInt8(o);
    }
  }

  return { values: out, size };
}

function encode(values: ArrayLike<number>, componentType: number): Uint8Array {
  const bytes = BYTES[componentType]!;
  const out = new Uint8Array(values.length * bytes);
  const dv = new DataView(out.buffer);

  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (componentType === 5126) dv.setFloat32(i * bytes, v, true);
    else if (componentType === 5125) dv.setUint32(i * bytes, v, true);
    else if (componentType === 5123) dv.setUint16(i * bytes, v, true);
    else if (componentType === 5121) dv.setUint8(i * bytes, v);
    else if (componentType === 5122) dv.setInt16(i * bytes, v, true);
    else dv.setInt8(i * bytes, v);
  }

  return out;
}

export interface Triangles {
  /** Corners (xyz) of every triangle of every primitive, in order. */
  corners: Float32Array;
  /** Triangles per primitive. */
  counts: number[];
}

/** All triangles of the model (its node transforms are not applied: meerCAD's GLBs have none). */
export function triangles(glb: Uint8Array): Triangles {
  const { json, bin } = parse(glb);
  const out: number[] = [];
  const counts: number[] = [];

  for (const mesh of json.meshes) {
    for (const p of mesh.primitives) {
      const pos = read(json, bin, p.attributes["POSITION"]!).values;
      const idx =
        p.indices !== undefined
          ? read(json, bin, p.indices).values
          : Float64Array.from({ length: pos.length / 3 }, (_, i) => i);

      for (let k = 0; k < idx.length; k++) {
        out.push(pos[idx[k]! * 3]!, pos[idx[k]! * 3 + 1]!, pos[idx[k]! * 3 + 2]!);
      }

      counts.push(idx.length / 3);
    }
  }

  return { corners: Float32Array.from(out), counts };
}

/**
 * The model with only the triangles `keep` (by their running number, as in `triangles`) says yes
 * to, its unused vertices dropped. Returns null when nothing changes.
 */
export function keepTriangles(
  glb: Uint8Array,
  keep: (t: number) => boolean,
): { glb: Uint8Array; before: number; after: number } | null {
  const { json, bin } = parse(glb);
  const parts: Uint8Array[] = [];
  let offset = 0;
  const views: Gltf["bufferViews"] = [];

  const addView = (data: Uint8Array, target?: number) => {
    while (offset % 4) (parts.push(new Uint8Array(1)), offset++);
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length, ...(target ? { target } : {}) });
    parts.push(data);
    offset += data.length;

    return views.length - 1;
  };

  // Views that hold no vertex data or indices (the pictures) are copied as they are.
  const geometry = new Set<number>();

  for (const mesh of json.meshes) {
    for (const p of mesh.primitives) {
      for (const a of [...Object.values(p.attributes), ...(p.indices !== undefined ? [p.indices] : [])]) {
        geometry.add(json.accessors[a]!.bufferView!);
      }
    }
  }

  const moved = new Map<number, number>();
  json.bufferViews.forEach((v, i) => {
    if (geometry.has(i)) return;

    const start = bin.byteOffset + (v.byteOffset ?? 0);
    moved.set(i, addView(new Uint8Array(bin.buffer.slice(start, start + v.byteLength)), v.target));
  });

  for (const key of ["images"] as const) {
    const list = json[key] as { bufferView?: number }[] | undefined;
    for (const im of list ?? []) if (im.bufferView !== undefined) im.bufferView = moved.get(im.bufferView)!;
  }

  let t = 0,
    before = 0,
    after = 0;
  const accessors: Gltf["accessors"] = [];

  for (const mesh of json.meshes) {
    mesh.primitives = mesh.primitives.flatMap((p) => {
      const pos = read(json, bin, p.attributes["POSITION"]!);
      const idx =
        p.indices !== undefined
          ? read(json, bin, p.indices).values
          : Float64Array.from({ length: pos.values.length / 3 }, (_, i) => i);
      const kept: number[] = [];
      for (let k = 0; k < idx.length; k += 3, t++) if (keep(t)) kept.push(idx[k]!, idx[k + 1]!, idx[k + 2]!);
      before += idx.length / 3;
      after += kept.length / 3;
      if (!kept.length) return [];

      // Renumber the vertices still used.
      const remap = new Map<number, number>();
      const order: number[] = [];
      const newIdx = kept.map((v) => {
        let n = remap.get(v);
        if (n === undefined) ((n = order.length), remap.set(v, n), order.push(v));

        return n;
      });
      const attributes: Record<string, number> = {};

      for (const [name, a] of Object.entries(p.attributes)) {
        const src = json.accessors[a]!;
        const { values, size } = read(json, bin, a);
        const out = new Float64Array(order.length * size);
        order.forEach((v, i) => {
          for (let k = 0; k < size; k++) out[i * size + k] = values[v * size + k]!;
        });

        const acc: Gltf["accessors"][number] = {
          bufferView: addView(encode(out, src.componentType), 34962),
          componentType: src.componentType,
          count: order.length,
          type: src.type,
          ...(src.normalized ? { normalized: true } : {}),
        };

        if (name === "POSITION") {
          const lo = [Infinity, Infinity, Infinity],
            hi = [-Infinity, -Infinity, -Infinity];

          for (let i = 0; i < out.length; i += 3) {
            for (let k = 0; k < 3; k++) {
              ((lo[k] = Math.min(lo[k]!, out[i + k]!)), (hi[k] = Math.max(hi[k]!, out[i + k]!)));
            }
          }

          acc.min = lo;
          acc.max = hi;
        }

        accessors.push(acc);
        attributes[name] = accessors.length - 1;
      }

      accessors.push({
        bufferView: addView(encode(newIdx, 5125), 34963),
        componentType: 5125,
        count: newIdx.length,
        type: "SCALAR",
      });

      return [{ ...p, attributes, indices: accessors.length - 1 }];
    });
  }

  if (after === before) return null;

  while (offset % 4) (parts.push(new Uint8Array(1)), offset++);
  json.accessors = accessors;
  json.bufferViews = views;
  json.buffers = [{ byteLength: offset }];
  json.meshes = json.meshes.filter((m) => m.primitives.length);

  const node = (json["nodes"] as { mesh?: number }[] | undefined) ?? [];
  if (!json.meshes.length) for (const n of node) delete n.mesh;

  return { glb: write(json, parts, offset), before, after };
}

function write(json: Gltf, parts: Uint8Array[], binLength: number): Uint8Array {
  let text = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (text.length % 4)) % 4;
  if (pad) text = Uint8Array.from([...text, ...new Array<number>(pad).fill(0x20)]);

  const out = new Uint8Array(12 + 8 + text.length + 8 + binLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, text.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);

  let o = 20 + text.length;
  dv.setUint32(o, binLength, true);
  dv.setUint32(o + 4, 0x004e4942, true);
  o += 8;
  for (const p of parts) (out.set(p, o), (o += p.length));

  return out;
}

// ---------------------------------------------------------------- the clean-up tools

const centroid = (c: Float32Array, t: number): Vec3 => [
  (c[t * 9]! + c[t * 9 + 3]! + c[t * 9 + 6]!) / 3,
  (c[t * 9 + 1]! + c[t * 9 + 4]! + c[t * 9 + 7]!) / 3,
  (c[t * 9 + 2]! + c[t * 9 + 5]! + c[t * 9 + 8]!) / 3,
];

function inside(x: number, y: number, poly: readonly Vec3[]): boolean {
  let hit = false;

  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!,
      [xj, yj] = poly[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }

  return hit;
}

/** Keeps (or removes) what lies inside an outline seen from above. */
export function crop(glb: Uint8Array, outline: readonly Vec3[], keepInside: boolean) {
  const { corners } = triangles(glb);

  return keepTriangles(glb, (t) => {
    const [x, y] = centroid(corners, t);

    return inside(x, y, outline) === keepInside;
  });
}

/**
 * Removes what lies under a brush stroke: within half its width of the stroke seen from above and
 * near the height it was painted at (so the floor goes, not the ceiling above it).
 */
export function erase(glb: Uint8Array, stroke: readonly Vec3[], width: number) {
  const { corners } = triangles(glb);
  const half = width / 2;
  const reach = Math.max(width, 300);

  return keepTriangles(glb, (t) => {
    const [x, y, z] = centroid(corners, t);

    for (let i = 0; i < stroke.length; i++) {
      const a = stroke[i]!,
        b = stroke[Math.min(i + 1, stroke.length - 1)]!;
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        l2 = dx * dx + dy * dy;
      const u = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
      const px = a[0] + dx * u,
        py = a[1] + dy * u,
        pz = a[2] + (b[2] - a[2]) * u;
      if (Math.hypot(x - px, y - py) <= half && Math.abs(z - pz) <= reach) return false;
    }

    return true;
  });
}

/** Removes everything above (or below) a height. */
export function cutHeight(glb: Uint8Array, height: number, above: boolean) {
  const { corners } = triangles(glb);

  return keepTriangles(glb, (t) => centroid(corners, t)[2] > height !== above);
}

/**
 * Removes the loose pieces of a scan: pieces (triangles joined through shared corners, seams
 * included) smaller than `share` of the largest one's area.
 */
export function removeLoosePieces(glb: Uint8Array, share = 0.02) {
  const { corners } = triangles(glb);
  const n = corners.length / 9;
  const parent = Int32Array.from({ length: n }, (_, i) => i);

  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;

    return i;
  };

  // Corners closer than a millimetre are the same (texture seams split them in the file).
  const owner = new Map<string, number>();

  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const o = t * 9 + k * 3;
      const key = `${Math.round(corners[o]!)},${Math.round(corners[o + 1]!)},${Math.round(corners[o + 2]!)}`;
      const other = owner.get(key);
      if (other === undefined) owner.set(key, t);
      else parent[find(t)] = find(other);
    }
  }

  const area = new Map<number, number>();

  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = corners[o + 3]! - corners[o]!,
      uy = corners[o + 4]! - corners[o + 1]!,
      uz = corners[o + 5]! - corners[o + 2]!;
    const vx = corners[o + 6]! - corners[o]!,
      vy = corners[o + 7]! - corners[o + 1]!,
      vz = corners[o + 8]! - corners[o + 2]!;
    const a = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const r = find(t);
    area.set(r, (area.get(r) ?? 0) + a);
  }

  const largest = Math.max(0, ...area.values());
  const result = keepTriangles(glb, (t) => area.get(find(t))! >= largest * share);

  return result ? { ...result, pieces: [...area.values()].filter((a) => a < largest * share).length } : null;
}
