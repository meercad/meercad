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
 * Moments of inertia about the centre of gravity, axes parallel to X, Y, Z, in g·mm²: Ixx, Iyy,
 * Izz and the products of inertia ∫xy, ∫xz, ∫yz dm.
 */
export type Inertia = [number, number, number, number, number, number];

/**
 * Total mass, centre of gravity and inertia of parts. Each part: its volume, its centre of volume,
 * its volume's moments about that centre (from the kernel) and its material (parts without one are
 * left out). Each part's inertia moves to the common centre by the parallel axis theorem.
 */
export function massProperties(parts: readonly { volume: number; centroid?: [number, number, number]; inertia?: readonly number[]; material?: Material }[]): { mass: number; center: [number, number, number] | null; inertia: Inertia | null; missing: number } {
  let mass = 0;
  const c: [number, number, number] = [0, 0, 0];
  let missing = 0;
  const counted: { m: number; at?: [number, number, number]; own?: readonly number[] }[] = [];
  for (const p of parts) {
    if (!p.material || !Number.isFinite(p.volume)) {
      missing++;
      continue;
    }
    const m = massOf(p.volume, p.material);
    mass += m;
    if (p.centroid) for (let k = 0; k < 3; k++) c[k]! += p.centroid[k]! * m;
    // The kernel's moments are of the volume in mm⁵; mass per mm³ turns them into g·mm².
    counted.push({ m, ...(p.centroid ? { at: p.centroid } : {}), ...(p.inertia && p.volume > 0 ? { own: p.inertia.map((v) => (v * m) / p.volume) } : {}) });
  }
  const center = mass > 0 ? (c.map((v) => v / mass) as [number, number, number]) : null;
  let inertia: Inertia | null = null;
  if (center && counted.length && counted.every((p) => p.at && p.own)) {
    inertia = [0, 0, 0, 0, 0, 0];
    for (const p of counted) {
      const [dx, dy, dz] = [p.at![0] - center[0], p.at![1] - center[1], p.at![2] - center[2]];
      const shift = [dy * dy + dz * dz, dx * dx + dz * dz, dx * dx + dy * dy, dx * dy, dx * dz, dy * dz];
      for (let k = 0; k < 6; k++) inertia[k]! += p.own![k]! + p.m * shift[k]!;
    }
  }
  return { mass, center, inertia, missing };
}

/** Inertia for display: g·mm² for small parts, then kg·mm² and kg·m². */
export function formatInertia(gmm2: number): string {
  const a = Math.abs(gmm2);
  const num = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (a >= 1e9) return `${num(gmm2 / 1e9)} kg·m²`;
  if (a >= 1e5) return `${num(gmm2 / 1e3)} kg·mm²`;
  return `${num(gmm2)} g·mm²`;
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
