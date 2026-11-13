/**
 * Parts for a 3MF export, from the document alone (no app state, so tests use it as it is):
 * names, display colours, materials with their finish, and the filament each part prints with.
 */
import { partMaterial } from "@meercad/model";
import type { Filament, Mesh3mf, TriangleMesh } from "@meercad/io";
import type { MeercadDocument } from "@meercad/schema";
import { partName } from "./features";
import { PART_PALETTE } from "./partColors";

/**
 * The filament a part prints with: its material and colour when it has a material or a colour the
 * user picked; otherwise none (it prints with the first filament).
 */
export function partFilament(
  doc: MeercadDocument,
  id: string,
  color: string | undefined,
): Filament | undefined {
  const material = partMaterial(doc, id);
  const picked = doc.partColors?.[id];
  if (!material) return picked ? { color: picked } : undefined;

  return {
    color: color ?? material.look.color ?? PART_PALETTE[0],
    material: material.name,
    ...(material.filament ? { type: material.filament } : {}),
  };
}

/**
 * `colors`: each part's display colour (partColors). `materials: false` leaves materials, colours
 * and filaments out: plain named parts, which slicers import without asking to map filaments.
 */
export function threeMfParts(
  doc: MeercadDocument,
  meshes: readonly (TriangleMesh & { bodyId: string })[],
  colors: ReadonlyMap<string, string>,
  materials = true,
): Mesh3mf[] {
  return meshes.map((m) => {
    if (!materials) {
      return { positions: m.positions, indices: m.indices, name: partName(m.bodyId, doc.features) };
    }

    const mat = partMaterial(doc, m.bodyId);
    const filament = partFilament(doc, m.bodyId, colors.get(m.bodyId));

    return {
      positions: m.positions,
      indices: m.indices,
      name: partName(m.bodyId, doc.features),
      ...(colors.get(m.bodyId) ? { color: colors.get(m.bodyId)! } : {}),
      ...(mat
        ? { material: mat.name, look: { roughness: mat.look.roughness, metalness: mat.look.metalness } }
        : {}),
      ...(filament ? { filament } : {}),
    };
  });
}
