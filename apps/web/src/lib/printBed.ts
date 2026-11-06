/**
 * The printer's build volume and whether a part fits in it. A slicer can turn a part any way it
 * likes, so a part fits when its sizes, smallest to largest, fit the bed's sizes in the same order
 * (turned in right angles only: a part that fits only diagonally still counts as too big).
 */

export type Bed = [number, number, number];

/** Common build volumes (mm, width × depth × height). */
export const BED_PRESETS: { id: string; label: string; size: Bed }[] = [
  { id: "256", label: "256 × 256 × 256", size: [256, 256, 256] },
  { id: "250", label: "250 × 210 × 220", size: [250, 210, 220] },
  { id: "220", label: "220 × 220 × 250", size: [220, 220, 250] },
  { id: "180", label: "180 × 180 × 180", size: [180, 180, 180] },
  { id: "350", label: "350 × 350 × 350", size: [350, 350, 350] },
];
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
