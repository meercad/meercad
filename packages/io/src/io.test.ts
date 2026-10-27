import { describe, expect, it } from "vitest";
import { decodeShareFragment, encodeShareFragment, meshVolume, readStl, writeStl } from "./index.js";

describe("STL", () => {
  it("round-trips a tetrahedron with correct volume", () => {
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const stl = readStl(writeStl([{ positions, indices }]));
    expect(stl.triangles).toBe(4);
    expect(meshVolume(stl.vertices)).toBeCloseTo(1 / 6);
  });
});

describe("share links", () => {
  it("round-trips and stays URL-safe", async () => {
    const doc = { format: "meercad/1", params: { w: "40 mm" }, features: [], rollback: null };
    const frag = await encodeShareFragment(doc);
    expect(frag).toMatch(/^m1\.[A-Za-z0-9_-]+$/);
    expect(await decodeShareFragment(`#${frag}`)).toEqual(doc);
    await expect(decodeShareFragment("#garbage")).rejects.toThrow();
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
  });
});
