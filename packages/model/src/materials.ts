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

/** One line of a parts list (bill of materials): equal parts counted together. */
export interface BomRow {
  /** Position number, from 1. */
  pos: number;
  name: string;
  qty: number;
  material?: string;
  /** Mass of one part, g (with a material). */
  mass?: number;
  /** Volume of one part, mm³. */
  volume: number;
}

/**
 * The parts list: parts with the same name (copies are named "Name (2)", "Name (3)") and material
 * count as one line; lines keep the parts' order.
 */
export function billOfMaterials(parts: readonly { id: string; volume: number }[], name: (id: string) => string, materials: Readonly<Record<string, string>> = {}): BomRow[] {
  const rows: BomRow[] = [];
  for (const p of parts) {
    const base = name(p.id).replace(/ \(\d+\)$/, "");
    const m = materialById(materials[p.id]);
    const row = rows.find((r) => r.name === base && r.material === m?.name && Math.abs(r.volume - p.volume) <= 1e-6 * Math.max(1, p.volume));
    if (row) row.qty++;
    else rows.push({ pos: rows.length + 1, name: base, qty: 1, ...(m ? { material: m.name, mass: massOf(p.volume, m) } : {}), volume: p.volume });
  }
  return rows;
}

/** The parts list as CSV (semicolons, which spreadsheets in most locales open directly). */
export function bomCsv(rows: readonly BomRow[]): string {
  const cell = (v: string) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [["Pos", "Qty", "Name", "Material", "Mass each (g)", "Volume each (cm³)"].join(";")];
  for (const r of rows) lines.push([String(r.pos), String(r.qty), cell(r.name), cell(r.material ?? ""), r.mass !== undefined ? r.mass.toFixed(2) : "", (r.volume / 1000).toFixed(3)].join(";"));
  return lines.join("\n") + "\n";
}
