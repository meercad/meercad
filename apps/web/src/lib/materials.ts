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
    const m = partMaterial(doc, id);
    if (m) out.set(id, lookOf(m));
  }

  return out;
}

export const lookOf = (m: Material): BodyLook => {
  const { color: _c, ...look } = m.look;

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
export const materialName = (m: Material) => (m.base ? m.name : t(m.name));

/** Facts about a material, one per line: density, print temperatures, hardness. */
export function materialFacts(m: Material): string[] {
  const facts = [t("{d} g/cm³", { d: m.density })];
  if (m.nozzle) facts.push(t("Nozzle {a}–{b} °C", { a: m.nozzle[0], b: m.nozzle[1] }));
  if (m.bed) facts.push(t("Bed {a}–{b} °C", { a: m.bed[0], b: m.bed[1] }));
  if (m.shore) facts.push(t("Shore {s}", { s: m.shore }));
  if (m.kind === "print" && !m.filament) facts.push(t("Resin printer"));

  return facts;
}

const swatchCache = new Map<string, string>();

/**
 * Sphere pictures of materials, by `${id}|${colour}`: materials without a colour of their own are
 * shown in `fallback` (the part's colour). Drawn once and kept.
 */
export function materialSwatches(materials: readonly Material[], fallback: string): Map<string, string> {
  const key = (m: Material) => `${JSON.stringify(m.look)}|${(m.look.color ?? fallback).toLowerCase()}`;
  const missing = materials.filter((m) => !swatchCache.has(key(m)));
  const vp = getViewport();

  if (missing.length && vp) {
    const urls = vp.swatches(
      missing.map((m) => ({ look: lookOf(m), color: m.look.color ?? fallback })),
      96,
    );
    missing.forEach((m, i) => swatchCache.set(key(m), urls[i]!));
  }

  return new Map(
    materials.flatMap((m) =>
      swatchCache.has(key(m)) ? [[m.id, swatchCache.get(key(m))!] as [string, string]] : [],
    ),
  );
}

/** The material of parts when they all share one, else undefined. */
export function sharedMaterial(doc: MeercadDocument, parts: readonly string[]): Material | undefined {
  const ids = new Set(parts.map((p) => doc.partMaterials?.[p]));

  return ids.size === 1 ? materialById([...ids][0], doc.materials) : undefined;
}
