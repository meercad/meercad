/**
 * Materials end to end: a body and a grip built by the kernel, given PETG and an own black TPU
 * through ops, weighed, and exported as a 3MF that a multi-material slicer reads with the two
 * parts on two filaments. The 3MF is read back (unzipped) and checked.
 */
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { applyOp, massOf, partMaterial } from "@meercad/model";
import { filamentSlots, read3mf, write3mf } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { partColors } from "../../apps/web/src/lib/partColors";
import { threeMfParts } from "../../apps/web/src/lib/printParts";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** A 40 × 20 × 10 body and a 10 × 20 × 10 grip next to it, and a 10 × 10 × 5 cap. */
const parts: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, rect("b", 50, 0, 10, 20)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk3", { ref: "origin.XY" }, rect("c", 70, 0, 10, 10)),
  { id: "ex3", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 5, mode: "new_body" },
];

describe("materials for a two-material print", () => {
  it("weighs the parts and puts PETG and TPU on two filaments in the 3MF", async () => {
    const s = await newSession();
    let d = doc(parts);
    d = applyOp(d, {
      type: "define_material",
      material: { id: "own1", name: "Black TPU", base: "tpu", color: "#1c1c1c" },
    });
    d = applyOp(d, { type: "set_material", part: "ex1", material: "petg" });
    d = applyOp(d, { type: "set_material", part: "ex2", material: "own1" });
    d = applyOp(d, { type: "set_material", part: "ex3", material: "petg" });
    d = { ...d, partColors: { ex1: "#2f6fd6", ex3: "#2f6fd6" } };

    const out = s.rebuild(d);
    const vol = (id: string) => out.report.bodies.find((b) => b.id === id)!.volume;

    // 8 cm³ of PETG (1.27 g/cm³) and 2 cm³ of TPU (1.21 g/cm³), solid.
    expect(massOf(vol("ex1"), partMaterial(d, "ex1")!)).toBeCloseTo(8 * 1.27, 4);
    expect(massOf(vol("ex2"), partMaterial(d, "ex2")!)).toBeCloseTo(2 * 1.21, 4);

    // The own material brings its colour; the PETG parts keep the colour picked for them.
    const colors = partColors(
      d,
      out.meshes.map((m) => m.bodyId),
      true,
    );
    expect(colors.get("ex2")).toBe("#1c1c1c");

    const meshParts = threeMfParts(d, out.meshes, colors);
    expect(filamentSlots(meshParts).filaments).toEqual([
      { color: "#2F6FD6", material: "PETG", type: "PETG" },
      { color: "#1C1C1C", material: "Black TPU", type: "TPU" },
    ]);

    const file = write3mf(meshParts);
    const zip = unzipSync(file);
    const model = strFromU8(zip["3D/3dmodel.model"]!);
    expect(model).toContain(
      '<base name="PETG" displaycolor="#2F6FD6FF"/><base name="Black TPU" displaycolor="#1C1C1CFF"/>',
    );
    expect(model).toMatch(/<m:pbmetallic name="PETG" metallicness="0" roughness="0\.18"\/>/);

    const prusa = strFromU8(zip["Metadata/Slic3r_PE_model.config"]!);
    const bambu = strFromU8(zip["Metadata/model_settings.config"]!);
    const extruders = (xml: string) =>
      [...xml.matchAll(/key="extruder" value="(\d)"/g)].map((m) => Number(m[1]));
    expect(extruders(prusa)).toEqual([1, 2, 1]);
    expect(extruders(bambu)).toEqual([1, 2, 1]);

    // Every object's triangle range covers its mesh, so the slicer loads it whole.
    const ranges = [...prusa.matchAll(/<volume firstid="0" lastid="(\d+)">/g)].map((m) => Number(m[1]) + 1);
    const tris = [...model.matchAll(/<triangles>([\s\S]*?)<\/triangles>/g)].map(
      (m) => m[1]!.match(/<triangle /g)!.length,
    );
    expect(ranges).toEqual(tris);
    expect(tris.every((n) => n >= 12)).toBe(true);

    // And it reads back as the same three parts.
    const back = read3mf(file);
    expect(back.map((m) => m.name)).toEqual(meshParts.map((m) => m.name));

    // Without materials (the app's default): plain named parts, nothing for a slicer to map.
    const plainParts = threeMfParts(d, out.meshes, colors, false);
    expect(filamentSlots(plainParts).filaments).toEqual([]);

    const plain = unzipSync(write3mf(plainParts));
    const plainModel = strFromU8(plain["3D/3dmodel.model"]!);
    expect(plainModel).not.toContain("basematerials");
    expect(plainModel).not.toContain("pid=");
    expect(plain["Metadata/Slic3r_PE_model.config"]).toBeUndefined();
    expect(plain["Metadata/model_settings.config"]).toBeUndefined();
    expect(read3mf(write3mf(plainParts)).map((m) => m.name)).toEqual(meshParts.map((m) => m.name));
  });
});
