/**
 * Materials in the app: the looks parts get in the viewport, the filaments of 3MF exports,
 * assigning materials to parts (several at once), own materials, and swatch pictures for the
 * picker.
 */
import { documentMaterials, materialById, newMaterialId, partMaterial, type Material } from "@meercad/model";
import type { CustomMaterial, DocOp, MeercadDocument } from "@meercad/schema";
import type { BodyLook } from "@meercad/viewport";
import { apply, getViewport } from "../store";
import { t } from "./i18n";

/** Finishes of the parts that have a material (by body id). */
export function partLooks(doc: MeercadDocument, bodyIds: readonly string[]): Map<string, BodyLook> {
  const out = new Map<string, BodyLook>();

  for (const id of bodyIds) {
    const material = partMaterial(doc, id);
    if (material) out.set(id, lookOf(material));
  }

  return out;
}

export const lookOf = (material: Material): BodyLook => {
  const { color: _c, ...look } = material.look;

  return look;
};

/** Gives parts a material (or none) in one undo step. */
export function assignMaterial(parts: readonly string[], material: string | null): boolean {
  return apply(...parts.map((part): DocOp => ({ type: "set_material", part, material })));
}

/** Adds an own material (a fresh id when `id` is absent) or changes one; returns its id. */
export function saveOwnMaterial(
  doc: MeercadDocument,
  m: Omit<CustomMaterial, "id"> & { id?: string },
  assignTo: readonly string[] = [],
): string | null {
  const id = m.id ?? newMaterialId(doc);
  const material: CustomMaterial = { ...m, id };

  return apply(
    { type: "define_material", material },
    ...assignTo.map((part): DocOp => ({ type: "set_material", part, material: id })),
  )
    ? id
    : null;
}

export const deleteOwnMaterial = (id: string) => apply({ type: "delete_material", id });

/** Every material for the picker: own ones first, then the library. */
export const pickerMaterials = (doc: MeercadDocument) => documentMaterials(doc);

/** A material's name in the interface language (own materials keep the name the user gave). */
export const materialName = (material: Material) => (material.base ? material.name : t(material.name));

/** Facts about a material, one per line: density, print temperatures, hardness. */
export function materialFacts(material: Material): string[] {
  const facts = [t("{d} g/cm³", { d: material.density })];
  if (material.nozzle) facts.push(t("Nozzle {a}–{b} °C", { a: material.nozzle[0], b: material.nozzle[1] }));
  if (material.bed) facts.push(t("Bed {a}–{b} °C", { a: material.bed[0], b: material.bed[1] }));
  if (material.shore) facts.push(t("Shore {s}", { s: material.shore }));
  if (material.kind === "print" && !material.filament) facts.push(t("Resin printer"));

  return facts;
}

const swatchCache = new Map<string, string>();

/**
 * Sphere pictures of materials, by `${id}|${colour}`: materials without a colour of their own are
 * shown in `fallback` (the part's colour). Drawn once and kept.
 */
export function materialSwatches(materials: readonly Material[], fallback: string): Map<string, string> {
  const key = (material: Material) =>
    `${JSON.stringify(material.look)}|${(material.look.color ?? fallback).toLowerCase()}`;
  const missing = materials.filter((material) => !swatchCache.has(key(material)));
  const viewport = getViewport();

  if (missing.length && viewport) {
    const urls = viewport.swatches(
      missing.map((material) => ({ look: lookOf(material), color: material.look.color ?? fallback })),
      96,
    );
    missing.forEach((material, i) => swatchCache.set(key(material), urls[i]!));
  }

  return new Map(
    materials.flatMap((material) =>
      swatchCache.has(key(material))
        ? [[material.id, swatchCache.get(key(material))!] as [string, string]]
        : [],
    ),
  );
}

/** The material of parts when they all share one, else undefined. */
export function sharedMaterial(doc: MeercadDocument, parts: readonly string[]): Material | undefined {
  const ids = new Set(parts.map((p) => doc.partMaterials?.[p]));

  return ids.size === 1 ? materialById([...ids][0], doc.materials) : undefined;
}
