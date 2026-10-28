/** Grid spacing in the design's unit, shared by the grid drawing, sketch snapping and drag handles. */

/** The grid is laid out in the design's unit. */
export type GridUnit = "mm" | "in";
export const UNIT_MM: Record<GridUnit, number> = { mm: 1, in: 25.4 };

/** Minor spacings the grid steps through as you zoom: 1, 5, 10 mm …; inches go in ruler fractions. */
const MINOR: Record<GridUnit, number[]> = {
  mm: [0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 50000],
  in: [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 3, 6, 12, 36, 120, 360, 1200].map((n) => n * 25.4),
};
/** Inch major lines land on whole inches and feet. */
const INCH_MAJOR = [1, 12, 120, 1200, 12000].map((n) => n * 25.4);

/** Minor lines are kept at least this far apart on screen. */
export const MIN_SPACING_PX = 12;

/**
 * The grid at a zoom level (mm per screen pixel): fine minor lines, coarse major lines, and the step
 * points snap to (the minor one, so fine work stays possible). Zooming steps the minor spacing
 * 1 → 5 → 10 mm (and back), with major lines ten minor steps apart, so both are always visible.
 */
export function gridLevels(pixel: number, unit: GridUnit): { minor: number; major: number; snap: number } {
  const list = MINOR[unit];
  const minor = list.find((n) => n / pixel >= MIN_SPACING_PX) ?? list[list.length - 1]!;
  const major = unit === "in" ? (INCH_MAJOR.find((n) => n >= minor * 8 - 1e-9) ?? minor * 10) : minor * 10;
  return { minor, major, snap: minor };
}

/** Steps drag arrows move in: much finer than the grid (about 6 px each), so values stay precise. */
const DRAG: Record<GridUnit, number[]> = {
  mm: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 25, 50, 100, 250, 500, 1000],
  in: [1 / 256, 1 / 128, 1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 6, 12, 24].map((n) => n * 25.4),
};

/** The step a drag arrow moves in at a zoom level (mm per screen pixel). */
export function dragStep(pixel: number, unit: GridUnit): number {
  const list = DRAG[unit];
  return list.find((n) => n >= pixel * 6) ?? list[list.length - 1]!;
}

/** A spacing in mm written in the unit: "2.5 mm", "1/16 in". */
export function formatStep(stepMm: number, unit: GridUnit): string {
  const v = stepMm / UNIT_MM[unit];
  if (unit === "in" && v < 1) {
    const den = Math.round(1 / v);
    if (Math.abs(1 / den - v) < 1e-9) return `1/${den} in`;
  }
  if (unit === "mm" && v >= 10) return `${+(v / 10).toPrecision(6)} cm`;
  return `${+v.toPrecision(6)} ${unit}`;
}
