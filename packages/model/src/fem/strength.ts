/**
 * How strong the materials are, and how close a stressed part comes to giving way.
 *
 * The numbers are typical values for printed parts at 100 % infill and for common stock; a real
 * part depends on the printer, the filament and the settings, so the result is an estimate. Printed
 * parts are weaker between their layers than along them: pulling the layers apart and shearing them
 * against each other is checked against a lower strength.
 */
import type { Material } from "../materials.js";
import type { Vec3 } from "./grid.js";

export interface Strength {
  /** Young's modulus, MPa. */
  young: number;
  poisson: number;
  /** The stress at which the material gives way for good (yield, or break for brittle ones), MPa. */
  limit: number;
  /** The strength between layers as a share of `limit` (1: the same in every direction). */
  layer: number;
}

const strength = (young: number, poisson: number, limit: number, layer: number): Strength => ({
  young,
  poisson,
  limit,
  layer,
});

/** By library material. */
export const STRENGTHS: Readonly<Record<string, Strength>> = {
  pla: strength(3300, 0.35, 50, 0.6),
  plamatte: strength(3000, 0.35, 40, 0.6),
  plasilk: strength(3000, 0.35, 40, 0.5),
  petg: strength(2000, 0.38, 45, 0.7),
  abs: strength(2200, 0.36, 38, 0.5),
  asa: strength(2200, 0.36, 40, 0.5),
  tpu: strength(60, 0.45, 30, 0.8),
  tpu85a: strength(20, 0.45, 20, 0.8),
  pa12: strength(1700, 0.39, 45, 0.6),
  pc: strength(2300, 0.37, 60, 0.5),
  placf: strength(5500, 0.35, 55, 0.4),
  petgcf: strength(4500, 0.36, 50, 0.4),
  woodfill: strength(2800, 0.35, 30, 0.5),
  metalfill: strength(3500, 0.35, 30, 0.5),
  resin: strength(2500, 0.38, 50, 0.9),
  resinclear: strength(2500, 0.38, 50, 0.9),
  aluminium: strength(69000, 0.33, 240, 1),
  steel: strength(210000, 0.3, 235, 1),
  stainless: strength(193000, 0.3, 205, 1),
  brass: strength(100000, 0.34, 180, 1),
  copper: strength(117000, 0.34, 70, 1),
  wood: strength(10000, 0.3, 40, 1),
  plywood: strength(8000, 0.3, 30, 1),
  acrylic: strength(3000, 0.37, 65, 1),
};

/** The strength of a material: its own, or that of the library material an own one is based on. */
export function strengthOf(material: Pick<Material, "id" | "base">): Strength | undefined {
  return STRENGTHS[material.id] ?? (material.base ? STRENGTHS[material.base] : undefined);
}

/** Equivalent (von Mises) stress of the stress xx, yy, zz, xy, yz, zx that starts at `at`. */
export function vonMises(stress: ArrayLike<number>, at = 0): number {
  const [xx, yy, zz, xy, yz, zx] = [0, 1, 2, 3, 4, 5].map((i) => stress[at + i]!) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  return Math.sqrt(
    ((xx - yy) ** 2 + (yy - zz) ** 2 + (zz - xx) ** 2) / 2 + 3 * (xy ** 2 + yz ** 2 + zx ** 2),
  );
}

/**
 * How much of the material's strength a stress uses up (1: at the limit). The larger of: the
 * equivalent stress against the limit, the pull across the layers against the layer strength, and
 * the shear between layers against the layer strength in shear (1/√3 of it). `up` is the direction
 * the layers are stacked in, of length 1.
 */
export function utilisation(stress: ArrayLike<number>, at: number, material: Strength, up: Vec3): number {
  const [xx, yy, zz, xy, yz, zx] = [0, 1, 2, 3, 4, 5].map((i) => stress[at + i]!) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const pull: Vec3 = [
    xx * up[0] + xy * up[1] + zx * up[2],
    xy * up[0] + yy * up[1] + yz * up[2],
    zx * up[0] + yz * up[1] + zz * up[2],
  ];
  const across = pull[0] * up[0] + pull[1] * up[1] + pull[2] * up[2];
  const shear = Math.sqrt(Math.max(0, pull[0] ** 2 + pull[1] ** 2 + pull[2] ** 2 - across ** 2));
  const between = material.layer * material.limit;

  return Math.max(
    vonMises(stress, at) / material.limit,
    Math.max(0, across) / between,
    (shear * Math.sqrt(3)) / between,
  );
}

export interface StrengthResult {
  /** Per cube: the share of the strength used (0 outside the material). */
  used: Float32Array;
  /** The largest share outside the cubes left out, and the cube it is in (−1: no cube counted). */
  worst: number;
  worstCell: number;
  /** Strength over the largest stress: above 1 the part holds (Infinity without stress). */
  safety: number;
}

/**
 * The strength check of a stress field (six values per cube, see stresses()). Cubes in `skip` are
 * coloured but not counted: where a part is held or pushed, the calculation shows peaks that a real
 * part does not have.
 */
export function strengthCheck(
  stress: ArrayLike<number>,
  solid: ArrayLike<number>,
  material: Strength,
  up: Vec3,
  skip: ArrayLike<number> = [],
): StrengthResult {
  const used = new Float32Array(solid.length);
  const skipped = new Uint8Array(solid.length);
  let worst = 0;
  let worstCell = -1;

  for (let i = 0; i < skip.length; i++) skipped[skip[i]!] = 1;

  for (let cell = 0; cell < solid.length; cell++) {
    if (!solid[cell]) continue;

    used[cell] = utilisation(stress, cell * 6, material, up);

    if (!skipped[cell] && (worstCell < 0 || used[cell]! > worst)) {
      worst = used[cell]!;
      worstCell = cell;
    }
  }

  return { used, worst, worstCell, safety: worst > 0 ? 1 / worst : Infinity };
}
