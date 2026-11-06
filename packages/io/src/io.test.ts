import { describe, expect, it } from "vitest";
import { meshVolume, readStl, writeStl } from "./index.js";

describe("STL", () => {
  it("round-trips a tetrahedron with correct volume", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const stl = readStl(writeStl([{ positions, indices }]));
    expect(stl.triangles).toBe(4);
    expect(meshVolume(stl.vertices)).toBeCloseTo(1 / 6);
  });
});

import { readDxf, write3mf, writeDxf, writeSvg } from "./index.js";
import { unzipSync, strFromU8 } from "fflate";

describe("DXF / SVG / 3MF", () => {
  const curves = [
    { kind: "line" as const, a: [0, 0] as [number, number], b: [10, 0] as [number, number] },
    { kind: "circle" as const, center: [5, 5] as [number, number], radius: 2 },
    { kind: "arc" as const, center: [0, 0] as [number, number], radius: 10, a0: 0, a1: Math.PI / 2 },
  ];
  it("round-trips DXF", () => {
    const back = readDxf(writeDxf(curves));
    expect(back).toHaveLength(3);
    expect(back[2]).toMatchObject({ kind: "arc", radius: 10 });
    expect((back[2] as { a1: number }).a1).toBeCloseTo(Math.PI / 2);
  });
  it("reads LWPOLYLINE bulges as arcs", () => {
    // Closed slot: two straight edges and two half circles (bulge 1 = 180°).
    const dxf = ["0", "SECTION", "2", "ENTITIES", "0", "LWPOLYLINE", "90", "4", "70", "1", "10", "0", "20", "0", "42", "0", "10", "10", "20", "0", "42", "1", "10", "10", "20", "4", "42", "0", "10", "0", "20", "4", "42", "1", "0", "ENDSEC", "0", "EOF"].join("\n");
    const c = readDxf(dxf);
    expect(c.map((x) => x.kind)).toEqual(["line", "arc", "line", "arc"]);
    expect((c[1] as { radius: number }).radius).toBeCloseTo(2);
    expect((c[1] as { center: number[] }).center[0]).toBeCloseTo(10);
  });
  it("writes SVG in mm and a valid 3MF package", () => {
    expect(writeSvg(curves)).toMatch(/width="\d+(\.\d+)?mm"/);
    const zip = unzipSync(write3mf([{ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }]));
    const model = strFromU8(zip["3D/3dmodel.model"]!);
    expect(model).toContain('unit="millimeter"');
    expect(model.match(/<vertex /g)).toHaveLength(3);
    // A coloured mesh points at a base material with its display colour.
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const coloured = strFromU8(unzipSync(write3mf([{ ...tri, name: "a" }, { ...tri, name: "b", color: "#e8c39e" }]))["3D/3dmodel.model"]!);
    expect(coloured).toContain('<basematerials id="3"><base name="b" displaycolor="#E8C39EFF"/></basematerials>');
    expect(coloured).toContain('<object id="2" type="model" name="b" pid="3" pindex="0">');
    expect(coloured).toContain('<object id="1" type="model" name="a"><mesh>');
  });
});

import { filamentSlots, read3mf, readObj, writeObj } from "./index.js";
import { strToU8, zipSync } from "fflate";

describe("3MF / OBJ import", () => {
  const cube = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]), indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) };

  it("reads back what it writes", () => {
    const [m] = read3mf(write3mf([{ ...cube, name: "Cube" }]));
    expect(m!.name).toBe("Cube");
    expect(m!.indices.length).toBe(36);
    expect(meshVolume(expand(m!))).toBeCloseTo(1);
  });

  it("follows slicer-style components into other files, with transforms and units", () => {
    const mesh = `<mesh><vertices>${Array.from({ length: 8 }, (_, i) => `<vertex x="${cube.positions[i * 3]}" y="${cube.positions[i * 3 + 1]}" z="${cube.positions[i * 3 + 2]}"/>`).join("")}</vertices><triangles>${Array.from({ length: 12 }, (_, t) => `<triangle v1="${cube.indices[t * 3]}" v2="${cube.indices[t * 3 + 1]}" v3="${cube.indices[t * 3 + 2]}"/>`).join("")}</triangles></mesh>`;
    const part = `<model unit="inch"><resources><object id="1" type="model">${mesh}</object></resources><build/></model>`;
    const root = `<model unit="inch" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources><object id="2" name="Plate part"><components><component p:path="/3D/Objects/part.model" objectid="1" transform="2 0 0 0 1 0 0 0 1 0 0 0"/></components></object></resources><build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build></model>`;
    const [m] = read3mf(zipSync({ "3D/3dmodel.model": strToU8(root), "3D/Objects/part.model": strToU8(part) }));
    expect(m!.name).toBe("Plate part");
    // 1 in cube stretched ×2 in x, moved 10 in: 2 × 1 × 1 in, starting at x = 254 mm.
    expect(meshVolume(expand(m!))).toBeCloseTo(2 * 25.4 ** 3, 0);
    expect(Math.min(...Array.from(m!.positions).filter((_, i) => i % 3 === 0))).toBeCloseTo(254);
  });

  it("reads OBJ quads and negative indices", () => {
    const obj = ["v 0 0 0", "v 1 0 0", "v 1 1 0", "v 0 1 0", "f 1/1/1 2/2/2 3/3/3 4/4/4", "f -4 -2 -1"].join("\n");
    const m = readObj(obj);
    expect(Array.from(m.indices)).toEqual([0, 1, 2, 0, 2, 3, 0, 2, 3]);
  });
});

describe("OBJ export", () => {
  const cube = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]), indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) };
  /** The same cube with three own corners per triangle, as tessellators hand them out. */
  const soup = (dx: number) => {
    const e = expand(cube);
    for (let i = 0; i < e.length; i += 3) e[i] = e[i]! + dx;
    return { positions: e, indices: Uint32Array.from({ length: e.length / 3 }, (_, i) => i) };
  };

  it("writes one object per part, merges corners and reads back with the same volume", () => {
    const obj = writeObj([{ ...soup(0), name: "Base plate" }, { ...soup(5), name: "Lid" }]);
    expect(obj.match(/^o .*/gm)).toEqual(["o Base_plate", "o Lid"]);
    expect(obj.match(/^v /gm)).toHaveLength(16);
    expect(obj.match(/^f /gm)).toHaveLength(24);
    // The second part's faces point at its own corners (9–16), not the first part's.
    const lid = obj.slice(obj.indexOf("o Lid"));
    expect(Math.min(...[...lid.matchAll(/^f (\d+) (\d+) (\d+)/gm)].flatMap((m) => [1, 2, 3].map((k) => Number(m[k]))))).toBe(9);
    const back = readObj(obj);
    expect(meshVolume(expand(back))).toBeCloseTo(2);
  });

  it("puts a part's colour on its vertices", () => {
    const obj = writeObj([{ ...cube, color: "#ff8000" }, { ...cube }]);
    const lines = obj.split("\n").filter((l) => l.startsWith("v "));
    expect(lines[0]).toBe("v 0 0 0 1.0000 0.5020 0.0000");
    expect(lines[8]).toBe("v 0 0 0");
  });
});

/** Positions of every triangle corner in order, as meshVolume expects. */
function expand(m: { positions: Float32Array; indices: Uint32Array }): Float32Array {
  return Float32Array.from(Array.from(m.indices).flatMap((i) => [m.positions[i * 3]!, m.positions[i * 3 + 1]!, m.positions[i * 3 + 2]!]));
}

describe("3MF for multi-colour printing", () => {
  it("assigns one extruder per colour for slicers", () => {
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const zip = unzipSync(write3mf([{ ...tri, name: "Base", color: "#c4cfdc", filament: "#c4cfdc" }, { ...tri, name: "Lid", color: "#e8c39e", filament: "#e8c39e" }, { ...tri, name: "Knob", color: "#C4CFDC", filament: "#C4CFDC" }]));
    const prusa = strFromU8(zip["Metadata/Slic3r_PE_model.config"]!);
    const bambu = strFromU8(zip["Metadata/model_settings.config"]!);
    expect(prusa).toContain('<object id="2" instances_count="1"><metadata type="object" key="name" value="Lid"/><metadata type="object" key="extruder" value="2"/>');
    // The same colour (any case) shares an extruder.
    expect(bambu).toContain('<object id="3"><metadata key="name" value="Knob"/><metadata key="extruder" value="1"/>');
    // Colours alone (the automatic display colours) and a single filament assign nothing.
    expect(unzipSync(write3mf([{ ...tri, color: "#c4cfdc" }, { ...tri, color: "#e8c39e" }]))["Metadata/model_settings.config"]).toBeUndefined();
    expect(unzipSync(write3mf([{ ...tri, filament: "#c4cfdc" }, tri]))["Metadata/model_settings.config"]).toBeUndefined();
  });
});

describe("zip", () => {
  it("packs files that unpack again", async () => {
    const { unzipSync, strFromU8 } = await import("fflate");
    const { writeZip } = await import("./zip.js");
    const files = unzipSync(writeZip({ "a-Pipe 25.stl": new Uint8Array([1, 2, 3]), "b.txt": "hello" }));
    expect(Object.keys(files)).toEqual(["a-Pipe 25.stl", "b.txt"]);
    expect([...files["a-Pipe 25.stl"]!]).toEqual([1, 2, 3]);
    expect(strFromU8(files["b.txt"]!)).toBe("hello");
  });
});

describe("3MF with materials", () => {
  const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
  const petg = { color: "#3366cc", material: "PETG", look: { roughness: 0.18, metalness: 0 }, filament: { color: "#3366cc", material: "PETG", type: "PETG" } };
  const tpu = { color: "#222222", material: "TPU 95A", look: { roughness: 0.6, metalness: 0 }, filament: { color: "#222222", material: "TPU 95A", type: "TPU" } };

  it("names base materials after the material, once per material and colour, with their finish", () => {
    const zip = unzipSync(write3mf([{ ...tri, name: "Body", ...petg }, { ...tri, name: "Grip", ...tpu }, { ...tri, name: "Cap", ...petg }]));
    const model = strFromU8(zip["3D/3dmodel.model"]!);
    expect(model).toContain('xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02"');
    expect(model).toContain('<m:pbmetallicdisplayproperties id="5"><m:pbmetallic name="PETG" metallicness="0" roughness="0.18"/><m:pbmetallic name="TPU 95A" metallicness="0" roughness="0.6"/></m:pbmetallicdisplayproperties>');
    expect(model).toContain('<basematerials id="4" displaypropertiesid="5"><base name="PETG" displaycolor="#3366CCFF"/><base name="TPU 95A" displaycolor="#222222FF"/></basematerials>');
    expect(model).toContain('<object id="3" type="model" name="Cap" pid="4" pindex="0">');
    expect(model).toContain('<object id="2" type="model" name="Grip" pid="4" pindex="1">');
  });

  it("puts different materials on different filaments, even in the same colour", () => {
    const black = { ...tpu, filament: { ...tpu.filament, color: "#3366CC" }, color: "#3366cc" };
    const { filaments, slot } = filamentSlots([petg, black, { filament: "#3366cc" }, {}, petg]);
    expect(filaments).toEqual([{ color: "#3366CC", material: "PETG", type: "PETG" }, { color: "#3366CC", material: "TPU 95A", type: "TPU" }, { color: "#3366CC" }]);
    expect(slot).toEqual([1, 2, 3, 1, 1]);
  });

  it("gives the per-object settings each object's triangles, so slicers load the meshes", () => {
    const cube = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]), indices: new Uint32Array([0, 1, 2, 1, 3, 2]) };
    const zip = unzipSync(write3mf([{ ...cube, name: "Body", ...petg }, { ...tri, name: "Grip", ...tpu }]));
    const prusa = strFromU8(zip["Metadata/Slic3r_PE_model.config"]!);
    expect(prusa).toContain('<object id="1" instances_count="1"><metadata type="object" key="name" value="Body"/><metadata type="object" key="extruder" value="1"/><volume firstid="0" lastid="1">');
    expect(prusa).toContain('<metadata type="object" key="extruder" value="2"/><volume firstid="0" lastid="0">');
    expect(strFromU8(zip["Metadata/model_settings.config"]!)).toContain('<object id="2"><metadata key="name" value="Grip"/><metadata key="extruder" value="2"/></object>');
    // A single material assigns nothing.
    expect(unzipSync(write3mf([{ ...tri, ...petg }, { ...tri, ...petg }]))["Metadata/Slic3r_PE_model.config"]).toBeUndefined();
  });
});
