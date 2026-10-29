/**
 * Materials for parts: density for mass and weight. Prints are given as solid material (100 %
 * infill); a printed part with less infill weighs less.
 */

export interface Material {
  id: string;
  name: string;
  /** g/cm³ */
  density: number;
  kind: "print" | "metal" | "other";
}

export const MATERIALS: readonly Material[] = [
  { id: "pla", name: "PLA", density: 1.24, kind: "print" },
  { id: "petg", name: "PETG", density: 1.27, kind: "print" },
  { id: "abs", name: "ABS", density: 1.04, kind: "print" },
  { id: "asa", name: "ASA", density: 1.07, kind: "print" },
  { id: "tpu", name: "TPU", density: 1.21, kind: "print" },
  { id: "pa12", name: "Nylon (PA12)", density: 1.01, kind: "print" },
  { id: "pc", name: "Polycarbonate", density: 1.2, kind: "print" },
  { id: "resin", name: "Resin (standard)", density: 1.15, kind: "print" },
  { id: "aluminium", name: "Aluminium", density: 2.7, kind: "metal" },
  { id: "steel", name: "Steel", density: 7.85, kind: "metal" },
  { id: "stainless", name: "Stainless steel", density: 8.0, kind: "metal" },
  { id: "brass", name: "Brass", density: 8.5, kind: "metal" },
  { id: "copper", name: "Copper", density: 8.96, kind: "metal" },
  { id: "wood", name: "Wood (beech)", density: 0.72, kind: "other" },
  { id: "plywood", name: "Plywood", density: 0.6, kind: "other" },
  { id: "acrylic", name: "Acrylic (PMMA)", density: 1.18, kind: "other" },
];

export const materialById = (id: string | undefined): Material | undefined => MATERIALS.find((m) => m.id === id);

/** Mass in grams of `volume` mm³ of a material. */
export const massOf = (volume: number, m: Material): number => (volume / 1000) * m.density;

/** Mass for display: grams below a kilogram, then kilograms. */
export function formatMass(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(grams >= 10000 ? 1 : 2)} kg`;
  return `${grams >= 100 ? grams.toFixed(0) : grams >= 10 ? grams.toFixed(1) : grams.toFixed(2)} g`;
}

/**
 * Total mass and centre of gravity of parts. Each part: its volume, its centre of volume and its
 * material (parts without one are left out of the mass).
 */
export function massProperties(parts: readonly { volume: number; centroid?: [number, number, number]; material?: Material }[]): { mass: number; center: [number, number, number] | null; missing: number } {
  let mass = 0;
  const c: [number, number, number] = [0, 0, 0];
  let missing = 0;
  for (const p of parts) {
    if (!p.material || !Number.isFinite(p.volume)) {
      missing++;
      continue;
    }
    const m = massOf(p.volume, p.material);
    mass += m;
    if (p.centroid) for (let k = 0; k < 3; k++) c[k]! += p.centroid[k]! * m;
  }
  return { mass, center: mass > 0 ? (c.map((v) => v / mass) as [number, number, number]) : null, missing };
}
