import type { TriangleMesh } from "./stl.js";

/** A part for USDZ: its triangles in mm (Z up, as designed) and how its surface looks. */
export interface UsdzMesh extends TriangleMesh {
  name?: string;
  /** Three per vertex; without them the faces are shaded flat-ish by the viewer. */
  normals?: Float32Array;
  /** "#rrggbb" (sRGB). */
  color?: string;
  /** 0–1, default 0. */
  metalness?: number;
  /** 0–1, default 0.5. */
  roughness?: number;
}

/**
 * A USDZ package of parts for AR Quick Look on iPhone and iPad (and Quick Look on the Mac): one
 * mesh per part with its colour, in real size. The design's Z-up millimetres become USD's Y-up
 * metres, and the whole is moved so it stands on its lowest point, centred over the origin: AR
 * Quick Look puts the origin on the table it finds, so the part stands on the table.
 */
export function writeUsdz(meshes: readonly UsdzMesh[]): Uint8Array {
  return storedZip([{ name: "model.usda", data: new TextEncoder().encode(writeUsda(meshes)) }]);
}

/** Valid USD prim names, unique among their siblings. */
function primNames(names: readonly string[]): string[] {
  const seen = new Set<string>();

  return names.map((raw) => {
    let base = raw
      .replace(/[äöüÄÖÜß]/g, (c) => ({ ä: "ae", ö: "oe", ü: "ue", Ä: "Ae", Ö: "Oe", Ü: "Ue", ß: "ss" })[c]!)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^A-Za-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "");
    if (!base) base = "Part";
    if (/^[0-9]/.test(base)) base = `_${base}`;

    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base}_${n}`;
    seen.add(name);

    return name;
  });
}

/** sRGB "#rrggbb" as linear RGB, which UsdPreviewSurface expects for constant colours. */
function linearRgb(hex: string | undefined): [number, number, number] {
  const ok = hex && /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#c4cfdc";

  return [1, 3, 5].map((k) => {
    const c = parseInt(ok.slice(k, k + 2), 16) / 255;

    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

const num = (x: number) => {
  const r = Math.round(x * 1e6) / 1e6;

  return Object.is(r, -0) ? "0" : String(r);
};

const clamp01 = (x: number | undefined, fallback: number) =>
  x === undefined || !Number.isFinite(x) ? fallback : Math.min(1, Math.max(0, x));

/** The USD text (usda) of the parts; see writeUsdz. */
export function writeUsda(meshes: readonly UsdzMesh[]): string {
  // Bounds in design coordinates (mm, Z up), to stand the whole on the table, centred.
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];

  for (const m of meshes) {
    for (let i = 0; i < m.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = m.positions[i + k]!;
        if (v < lo[k]!) lo[k] = v;
        if (v > hi[k]!) hi[k] = v;
      }
    }
  }

  if (!Number.isFinite(lo[0]!)) throw new Error("nothing to show: no triangles");

  const cx = (lo[0]! + hi[0]!) / 2;
  const cy = (lo[1]! + hi[1]!) / 2;
  const floor = lo[2]!;
  // Design (x, y, z) in mm, Z up → USD (x, z, -y) in metres, Y up: a quarter turn about X, so the
  // triangles keep their winding and the part keeps its handedness.
  const point = (p: ArrayLike<number>, i: number) =>
    `(${num((p[i]! - cx) / 1000)}, ${num((p[i + 2]! - floor) / 1000)}, ${num(-(p[i + 1]! - cy) / 1000)})`;
  const normal = (n: ArrayLike<number>, i: number) =>
    `(${num(n[i]!)}, ${num(n[i + 2]!)}, ${num(-n[i + 1]!)})`;

  const names = primNames(meshes.map((m, i) => m.name ?? `Part ${i + 1}`));
  const out: string[] = [
    "#usda 1.0",
    "(",
    '    customLayerData = { string creator = "meerCAD" }',
    '    defaultPrim = "Model"',
    "    metersPerUnit = 1",
    '    upAxis = "Y"',
    ")",
    "",
    'def Xform "Model" (',
    '    assetInfo = { string name = "Model" }',
    '    kind = "component"',
    ")",
    "{",
    '    def Scope "Materials"',
    "    {",
  ];

  for (const [i, m] of meshes.entries()) {
    const [r, g, b] = linearRgb(m.color);
    out.push(
      `        def Material "M_${names[i]}"`,
      "        {",
      `            token outputs:surface.connect = </Model/Materials/M_${names[i]}/Surface.outputs:surface>`,
      '            def Shader "Surface"',
      "            {",
      '                uniform token info:id = "UsdPreviewSurface"',
      `                color3f inputs:diffuseColor = (${num(r)}, ${num(g)}, ${num(b)})`,
      `                float inputs:metallic = ${num(clamp01(m.metalness, 0))}`,
      `                float inputs:roughness = ${num(clamp01(m.roughness, 0.5))}`,
      "                token outputs:surface",
      "            }",
      "        }",
    );
  }

  out.push("    }");

  for (const [i, m] of meshes.entries()) {
    const n = m.positions.length / 3;
    const pts: string[] = [];
    const elo = [Infinity, Infinity, Infinity];
    const ehi = [-Infinity, -Infinity, -Infinity];

    for (let v = 0; v < n; v++) {
      pts.push(point(m.positions, v * 3));

      const u = [
        (m.positions[v * 3]! - cx) / 1000,
        (m.positions[v * 3 + 2]! - floor) / 1000,
        -(m.positions[v * 3 + 1]! - cy) / 1000,
      ];

      for (let k = 0; k < 3; k++) {
        if (u[k]! < elo[k]!) elo[k] = u[k]!;
        if (u[k]! > ehi[k]!) ehi[k] = u[k]!;
      }
    }

    const tris = m.indices.length / 3;
    out.push(
      "",
      `    def Mesh "${names[i]}" (`,
      '        prepend apiSchemas = ["MaterialBindingAPI"]',
      "    )",
      "    {",
      "        uniform bool doubleSided = 0",
      `        float3[] extent = [(${elo.map(num).join(", ")}), (${ehi.map(num).join(", ")})]`,
      `        int[] faceVertexCounts = [${new Array<number>(tris).fill(3).join(", ")}]`,
      `        int[] faceVertexIndices = [${Array.from(m.indices).join(", ")}]`,
      `        rel material:binding = </Model/Materials/M_${names[i]}>`,
    );

    if (m.normals && m.normals.length === m.positions.length) {
      const ns: string[] = [];
      for (let v = 0; v < n; v++) ns.push(normal(m.normals, v * 3));
      out.push(
        `        normal3f[] normals = [${ns.join(", ")}] (`,
        '            interpolation = "vertex"',
        "        )",
      );
    }

    out.push(
      `        point3f[] points = [${pts.join(", ")}]`,
      '        uniform token subdivisionScheme = "none"',
      "    }",
    );
  }

  out.push("}", "");

  return out.join("\n");
}

let crcTable: Uint32Array | undefined;

function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);

    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }

  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);

  return (c ^ 0xffffffff) >>> 0;
}

/**
 * A zip as USDZ wants it: entries stored (not compressed), each file's data starting on a
 * 64-byte boundary (padding in the local header's extra field), so it can be read in place.
 */
export function storedZip(files: readonly { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(f.data);
    const pad = (64 - ((offset + 30 + name.length + 4) % 64)) % 64;
    const local = new Uint8Array(30 + name.length + 4 + pad);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x21, true); // date: 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 4 + pad, true);
    local.set(name, 30);
    lv.setUint16(30 + name.length, 0x1986, true); // padding field, as Pixar's own writer uses
    lv.setUint16(32 + name.length, pad, true);

    const head = new Uint8Array(46 + name.length);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 20, true);
    hv.setUint16(12, 0, true);
    hv.setUint16(14, 0x21, true);
    hv.setUint32(16, crc, true);
    hv.setUint32(20, f.data.length, true);
    hv.setUint32(24, f.data.length, true);
    hv.setUint16(28, name.length, true);
    hv.setUint32(42, offset, true);
    head.set(name, 46);
    parts.push(local, f.data);
    central.push(head);
    offset += local.length + f.data.length;
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;

  for (const p of [...parts, ...central, end]) {
    out.set(p, at);
    at += p.length;
  }

  return out;
}
