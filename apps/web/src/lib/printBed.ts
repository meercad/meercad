/**
 * The printer's build volume and whether a part fits in it. A slicer can turn a part any way it
 * likes, so a part fits when its sizes, smallest to largest, fit the bed's sizes in the same order
 * (turned in right angles only: a part that fits only diagonally still counts as too big).
 */

import { PRINTERS, printerName } from "@meercad/model";

export type Bed = [number, number, number];

/** Build volumes of common printers (mm, width × depth × height), from the model's printer profiles. */
export const BED_PRESETS: { id: string; label: string; size: Bed }[] = PRINTERS.map((p) => ({ id: p.id, label: p.brand === "Other" ? p.bed.join(" × ") : `${printerName(p)} · ${p.bed.join(" × ")}`, size: [...p.bed] as Bed }));
export const DEFAULT_BED: Bed = [256, 256, 256];

export function partSize(bbox: { min: readonly number[]; max: readonly number[] }): Bed {
  return [0, 1, 2].map((i) => bbox.max[i]! - bbox.min[i]!) as Bed;
}

export function fitsBed(size: readonly number[], bed: readonly number[]): boolean {
  const s = [...size].sort((a, b) => a - b);
  const b = [...bed].sort((a, b) => a - b);
  return s.every((v, i) => v <= b[i]! + 1e-6);
}

/** Parts too big for the bed (finite bodies only; an empty bed setting turns the check off). */
export function tooBig<T extends { id: string; bbox: { min: readonly number[]; max: readonly number[] } }>(bodies: readonly T[], bed: Bed | null): T[] {
  if (!bed) return [];
  return bodies.filter((b) => b.bbox.min.every(Number.isFinite) && b.bbox.max.every(Number.isFinite) && !fitsBed(partSize(b.bbox), bed));
}

export function validBed(raw: unknown): Bed | null | undefined {
  if (raw === null) return null;
  if (Array.isArray(raw) && raw.length === 3 && raw.every((v) => typeof v === "number" && v >= 10 && v <= 5000)) return raw as Bed;
  return undefined;
}
