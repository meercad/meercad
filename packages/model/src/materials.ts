/**
 * Materials for parts: what a part is made of (density for mass and weight, print data for the
 * slicer) and how it looks (a physically based finish: roughness, metalness, clear coat, sheen,
 * see-through). Printed plastics come in every colour, so most of them leave the colour to the
 * part (its own colour, or an own material's); materials with a colour of their own (metals,
 * carbon, wood) bring it along. Prints are given as solid material (100 % infill); a printed part
 * with less infill weighs less.
 */
import type { CustomMaterial, Feature, MeercadDocument } from "@meercad/schema";

/** The finish of a material, as physically based rendering takes it (all 0…1). */
export interface MaterialLook {
  /** "#rrggbb"; absent: the part's own colour. */
  color?: string;
  roughness: number;
  metalness: number;
  /** A glossy coat on top (silk, PETG, polished resin). */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** Velvet-like rim light of soft and fibrous surfaces (TPU, carbon fibre fill). */
  sheen?: number;
  /** Light passing through (clear resin, acrylic); drawn in the rendered view. */
  transmission?: number;
}

export interface Material {
  id: string;
  name: string;
  /** g/cm³ */
  density: number;
  kind: "print" | "metal" | "other";
  look: MaterialLook;
  /** Filament type as slicers name it ("PLA", "PETG", "TPU", "PLA-CF"); resins have none. */
  filament?: string;
  /** Typical nozzle and bed temperature, °C. */
  nozzle?: [number, number];
  bed?: [number, number];
  /** Shore hardness of flexible materials, e.g. "95A". */
  shore?: string;
  /** One line on what it is good for and how it prints. */
  notes: string;
  /** Own materials: the library material it is based on. */
  base?: string;
}

const print = (id: string, name: string, density: number, filament: string | undefined, nozzle: [number, number] | undefined, bed: [number, number] | undefined, look: MaterialLook, notes: string, extra: Partial<Material> = {}): Material => ({
  id,
  name,
  density,
  kind: "print",
  look,
  ...(filament ? { filament } : {}),
  ...(nozzle ? { nozzle } : {}),
  ...(bed ? { bed } : {}),
  notes,
  ...extra,
});

/** The built-in library. Ids never change: documents refer to them. */
export const MATERIALS: readonly Material[] = [
  print("pla", "PLA", 1.24, "PLA", [190, 220], [50, 60], { roughness: 0.42, metalness: 0, clearcoat: 0.15, clearcoatRoughness: 0.4 }, "Easy to print and stiff; softens from about 55 °C."),
  print("plamatte", "PLA matte", 1.31, "PLA", [200, 220], [50, 60], { roughness: 0.88, metalness: 0 }, "PLA without shine: hides layer lines, looks moulded."),
  print("plasilk", "PLA silk", 1.24, "PLA", [205, 230], [50, 60], { roughness: 0.24, metalness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15 }, "Glossy, pearly sheen for decorative prints; a little weaker between layers."),
  print("petg", "PETG", 1.27, "PETG", [230, 250], [70, 85], { roughness: 0.18, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.1 }, "Tough, glossy and food-safe grades exist; stands up to about 70 °C."),
  print("abs", "ABS", 1.04, "ABS", [240, 260], [90, 110], { roughness: 0.5, metalness: 0 }, "Heat resistant to about 95 °C; warps, print enclosed."),
  print("asa", "ASA", 1.07, "ASA", [240, 260], [90, 110], { roughness: 0.62, metalness: 0 }, "Like ABS, but stays colourfast outdoors in sun and rain."),
  print("tpu", "TPU 95A", 1.21, "TPU", [210, 230], [30, 60], { roughness: 0.6, metalness: 0, sheen: 0.45 }, "Flexible and grippy: grips, bumpers, seals. Print slowly.", { shore: "95A" }),
  print("tpu85a", "TPU 85A", 1.18, "TPU", [200, 220], [30, 50], { roughness: 0.72, metalness: 0, sheen: 0.6 }, "Very soft, rubber-like; needs a direct drive extruder.", { shore: "85A" }),
  print("pa12", "Nylon (PA12)", 1.01, "PA", [250, 280], [70, 100], { color: "#ece6d6", roughness: 0.66, metalness: 0, sheen: 0.15 }, "Tough and slippery: gears, hinges, wear parts. Keep it dry."),
  print("pc", "Polycarbonate", 1.2, "PC", [260, 300], [100, 120], { roughness: 0.14, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.08 }, "Very strong and heat resistant to about 115 °C; print enclosed."),
  print("placf", "PLA-CF", 1.3, "PLA-CF", [210, 230], [50, 60], { color: "#2c2e31", roughness: 0.82, metalness: 0, sheen: 0.25 }, "Carbon fibre filled: stiff, matte, light. Needs a hardened nozzle."),
  print("petgcf", "PETG-CF", 1.3, "PETG-CF", [240, 260], [70, 80], { color: "#26282b", roughness: 0.74, metalness: 0, sheen: 0.2 }, "Carbon fibre filled PETG: stiff and tough. Needs a hardened nozzle."),
  print("woodfill", "Wood fill", 1.15, "PLA", [190, 220], [50, 60], { color: "#a87d52", roughness: 0.9, metalness: 0 }, "PLA with wood fibres: looks and sands like wood. Use a 0.6 mm nozzle."),
  print("metalfill", "Metal fill", 3.5, "PLA", [195, 220], [50, 60], { color: "#a67c45", roughness: 0.48, metalness: 0.55 }, "PLA with metal powder (bronze, copper): heavy, can be polished. Needs a hardened nozzle."),
  print("resin", "Resin (standard)", 1.15, undefined, undefined, undefined, { color: "#8e949b", roughness: 0.32, metalness: 0, clearcoat: 0.3, clearcoatRoughness: 0.2 }, "Photopolymer for fine detail on resin printers; brittle."),
  print("resinclear", "Resin (clear)", 1.12, undefined, undefined, undefined, { color: "#eef3f6", roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.05, transmission: 0.92 }, "See-through photopolymer; clear after sanding and coating."),
  { id: "aluminium", name: "Aluminium", density: 2.7, kind: "metal", look: { color: "#c8ccd1", roughness: 0.34, metalness: 1 }, notes: "Light and easy to machine." },
  { id: "steel", name: "Steel", density: 7.85, kind: "metal", look: { color: "#9ea3a8", roughness: 0.3, metalness: 1 }, notes: "Strong and stiff; rusts unless coated." },
  { id: "stainless", name: "Stainless steel", density: 8.0, kind: "metal", look: { color: "#b6babe", roughness: 0.22, metalness: 1 }, notes: "Corrosion resistant steel (A2/A4)." },
  { id: "brass", name: "Brass", density: 8.5, kind: "metal", look: { color: "#cfa94f", roughness: 0.28, metalness: 1 }, notes: "Machines cleanly; inserts and fittings." },
  { id: "copper", name: "Copper", density: 8.96, kind: "metal", look: { color: "#c47a52", roughness: 0.3, metalness: 1 }, notes: "Conducts heat and electricity best." },
  { id: "wood", name: "Wood (beech)", density: 0.72, kind: "other", look: { color: "#d3a978", roughness: 0.8, metalness: 0 }, notes: "Hard, fine-grained wood." },
  { id: "plywood", name: "Plywood", density: 0.6, kind: "other", look: { color: "#dcbd8f", roughness: 0.85, metalness: 0 }, notes: "Layered sheet wood for laser cutting and boxes." },
  { id: "acrylic", name: "Acrylic (PMMA)", density: 1.18, kind: "other", look: { color: "#f1f5f7", roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, transmission: 0.9 }, notes: "Clear sheet for laser cutting and covers." },
];

const LIBRARY = new Map(MATERIALS.map((m) => [m.id, m]));

/** An own material as a full material: its base under its own name, colour and density. */
export function customMaterial(c: CustomMaterial): Material | undefined {
  const base = LIBRARY.get(c.base);
  if (!base) return undefined;
  const { base: _b, ...rest } = base;
  return {
    ...rest,
    id: c.id,
    name: c.name,
    density: c.density ?? base.density,
    look: { ...base.look, ...(c.color ? { color: c.color } : {}) },
    notes: c.notes ?? base.notes,
    base: base.id,
  };
}

/** A material by id: from the library, or from the document's own materials. */
export function materialById(id: string | undefined, own: readonly CustomMaterial[] = []): Material | undefined {
  if (!id) return undefined;
  const c = own.find((m) => m.id === id);
  return c ? customMaterial(c) : LIBRARY.get(id);
}

/** The material a part is made of, or undefined. */
export const partMaterial = (doc: Pick<MeercadDocument, "partMaterials" | "materials"> & { features?: readonly Feature[] }, part: string): Material | undefined =>
  materialById(doc.partMaterials?.[part], doc.materials);

/** Every material a document can use: its own first, then the library. */
export const documentMaterials = (doc: Pick<MeercadDocument, "materials">): Material[] => [...(doc.materials ?? []).flatMap((c) => customMaterial(c) ?? []), ...MATERIALS];

/** A fresh id for an own material ("own1", "own2", …). */
export function newMaterialId(doc: Pick<MeercadDocument, "materials">): string {
  const used = new Set((doc.materials ?? []).map((m) => m.id));
  let n = 1;
  while (used.has(`own${n}`)) n++;
  return `own${n}`;
}

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
export function billOfMaterials(parts: readonly { id: string; volume: number }[], name: (id: string) => string, materials: Readonly<Record<string, string>> = {}, own: readonly CustomMaterial[] = []): BomRow[] {
  const rows: BomRow[] = [];
  for (const p of parts) {
    const base = name(p.id).replace(/ \(\d+\)$/, "");
    const m = materialById(materials[p.id], own);
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
