import type { TriangleMesh } from "./stl.js";

/** A triangle mesh with texture coordinates and the picture laid on it. */
export interface TexturedMesh extends TriangleMesh {
  /** Two per vertex, glTF convention (v runs down the image). */
  uvs?: Float32Array;
  /** The base colour picture, as stored in the file (JPEG, PNG or WebP). */
  image?: { data: Uint8Array; mime: string };
  /** Three per vertex (sRGB, 0–1), from the file's vertex colours (e.g. a coloured LiDAR scan). */
  colors?: Float32Array;
  /** Base colour "#rrggbb" when the material sets one other than white. */
  color?: string;
}

interface Gltf {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes?: {
    primitives: { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }[];
  }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
    normalized?: boolean;
  }[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  materials?: {
    pbrMetallicRoughness?: {
      baseColorTexture?: { index: number; texCoord?: number };
      baseColorFactor?: number[];
    };
  }[];
  textures?: { source?: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
}

const SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NORM: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/**
 * The triangles of a binary glTF (GLB), each primitive as its own mesh in scene coordinates
 * (node transforms applied), with its texture coordinates and base colour picture. Only what a
 * coloured or textured scan needs: triangle lists, float or normalised UVs, embedded pictures.
 */
export function readGlb(glb: Uint8Array): TexturedMesh[] {
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB file");

  let json: Gltf | undefined;
  let bin: Uint8Array = new Uint8Array(0);

  for (let o = 12; o + 8 <= glb.byteLength;) {
    const length = view.getUint32(o, true);
    const type = view.getUint32(o + 4, true);
    const chunk = glb.subarray(o + 8, o + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk)) as Gltf;
    else if (type === 0x004e4942) bin = chunk;

    o += 8 + length;
  }

  if (!json) throw new Error("GLB without JSON");

  const g = json;

  const bytesOf = (viewIndex: number) => {
    const v = g.bufferViews![viewIndex]!;

    return bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength);
  };

  const read = (index: number): Float64Array => {
    const a = g.accessors![index]!;
    const size = SIZE[a.type]!;
    const bytes = BYTES[a.componentType]!;
    const out = new Float64Array(a.count * size);
    if (a.bufferView === undefined) return out;

    const v = g.bufferViews![a.bufferView]!;
    const stride = v.byteStride ?? size * bytes;
    const base = bin.byteOffset + (v.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const dv = new DataView(bin.buffer, base, (a.count - 1) * stride + size * bytes);
    const norm = a.normalized ? NORM[a.componentType] : undefined;

    for (let i = 0; i < a.count; i++) {
      for (let k = 0; k < size; k++) {
        const o = i * stride + k * bytes;
        const c = a.componentType;
        let x =
          c === 5126
            ? dv.getFloat32(o, true)
            : c === 5125
              ? dv.getUint32(o, true)
              : c === 5123
                ? dv.getUint16(o, true)
                : c === 5121
                  ? dv.getUint8(o)
                  : c === 5122
                    ? dv.getInt16(o, true)
                    : dv.getInt8(o);
        if (norm) x = Math.max(x / norm, -1);

        out[i * size + k] = x;
      }
    }

    return out;
  };

  const out: TexturedMesh[] = [];

  const visit = (nodeIndex: number, parent: number[]) => {
    const node = g.nodes?.[nodeIndex];
    if (!node) return;

    const m = mul(parent, local(node));

    for (const p of node.mesh !== undefined ? (g.meshes?.[node.mesh]?.primitives ?? []) : []) {
      if ((p.mode ?? 4) !== 4 || p.attributes["POSITION"] === undefined) continue;

      const pos = read(p.attributes["POSITION"]);
      const positions = new Float32Array(pos.length);

      for (let i = 0; i < pos.length; i += 3) {
        const [x, y, z] = [pos[i]!, pos[i + 1]!, pos[i + 2]!];
        positions[i] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!;
        positions[i + 1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
        positions[i + 2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
      }

      const indices =
        p.indices !== undefined
          ? Uint32Array.from(read(p.indices))
          : Uint32Array.from({ length: pos.length / 3 }, (_, i) => i);

      // A mirroring transform turns the triangles inside out; flip them back.
      if (det3(m) < 0) {
        for (let t = 0; t < indices.length; t += 3) {
          [indices[t + 1], indices[t + 2]] = [indices[t + 2]!, indices[t + 1]!];
        }
      }

      const mesh: TexturedMesh = { positions, indices };
      const mat = p.material !== undefined ? g.materials?.[p.material]?.pbrMetallicRoughness : undefined;
      const tex = mat?.baseColorTexture;
      const uvIndex = p.attributes[`TEXCOORD_${tex?.texCoord ?? 0}`];
      const source = tex ? g.textures?.[tex.index]?.source : undefined;
      const img = source !== undefined ? g.images?.[source] : undefined;

      if (uvIndex !== undefined && img?.bufferView !== undefined) {
        mesh.uvs = Float32Array.from(read(uvIndex));
        mesh.image = { data: bytesOf(img.bufferView).slice(), mime: img.mimeType ?? "image/jpeg" };
      }

      const colorIndex = p.attributes["COLOR_0"];

      if (colorIndex !== undefined) {
        const size = SIZE[g.accessors![colorIndex]!.type]!;
        const c = read(colorIndex);
        // glTF vertex colours are linear; OBJ viewers show them as sRGB.
        mesh.colors = Float32Array.from({ length: (c.length / size) * 3 }, (_, i) =>
          srgb(c[Math.floor(i / 3) * size + (i % 3)]!),
        );
      }

      const f = mat?.baseColorFactor;

      if (f && (f[0] !== 1 || f[1] !== 1 || f[2] !== 1)) {
        mesh.color = `#${f
          .slice(0, 3)
          .map((c) =>
            Math.round(Math.min(1, Math.max(0, c)) * 255)
              .toString(16)
              .padStart(2, "0"),
          )
          .join("")}`;
      }

      out.push(mesh);
    }

    for (const c of node.children ?? []) visit(c, m);
  };

  const roots = g.scenes?.[g.scene ?? 0]?.nodes ?? (g.nodes ?? []).map((_, i) => i);
  for (const r of roots) visit(r, IDENTITY);

  return out;
}

const srgb = (c: number) =>
  c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.min(1, Math.max(0, c)), 1 / 2.4) - 0.055;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** A node's own transform as a column-major 4×4 matrix. */
function local(n: {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}): number[] {
  if (n.matrix?.length === 16) return n.matrix;

  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];

  return [
    (1 - 2 * (y! * y! + z! * z!)) * sx!,
    2 * (x! * y! + z! * w!) * sx!,
    2 * (x! * z! - y! * w!) * sx!,
    0,
    2 * (x! * y! - z! * w!) * sy!,
    (1 - 2 * (x! * x! + z! * z!)) * sy!,
    2 * (y! * z! + x! * w!) * sy!,
    0,
    2 * (x! * z! + y! * w!) * sz!,
    2 * (y! * z! - x! * w!) * sz!,
    (1 - 2 * (x! * x! + y! * y!)) * sz!,
    0,
    tx!,
    ty!,
    tz!,
    1,
  ];
}

function mul(a: number[], b: number[]): number[] {
  const r = new Array<number>(16).fill(0);

  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      for (let k = 0; k < 4; k++) r[c * 4 + row]! += a[k * 4 + row]! * b[c * 4 + k]!;
    }
  }

  return r;
}

const det3 = (m: number[]) =>
  m[0]! * (m[5]! * m[10]! - m[9]! * m[6]!) -
  m[4]! * (m[1]! * m[10]! - m[9]! * m[2]!) +
  m[8]! * (m[1]! * m[6]! - m[5]! * m[2]!);
