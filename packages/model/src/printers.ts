/**
 * Printer profiles: the build volumes of common FDM printers (width × depth × height, mm, as the
 * makers publish them), for the bed-size checks and for cutting large parts into printable pieces.
 */

export interface PrinterProfile {
  id: string;
  brand: "Bambu Lab" | "Prusa" | "Other";
  name: string;
  /** Build volume, mm: width (x), depth (y), height (z). */
  bed: [number, number, number];
}

export const PRINTERS: readonly PrinterProfile[] = [
  { id: "bambu-h2s", brand: "Bambu Lab", name: "H2S", bed: [340, 320, 340] },
  { id: "bambu-h2d", brand: "Bambu Lab", name: "H2D (one nozzle)", bed: [325, 320, 325] },
  { id: "bambu-x1", brand: "Bambu Lab", name: "X1 / P1 / P2S / A1", bed: [256, 256, 256] },
  { id: "bambu-a1mini", brand: "Bambu Lab", name: "A1 mini", bed: [180, 180, 180] },
  { id: "prusa-xl", brand: "Prusa", name: "XL", bed: [360, 360, 360] },
  { id: "prusa-coreone-l", brand: "Prusa", name: "CORE One L", bed: [300, 300, 330] },
  { id: "prusa-coreone", brand: "Prusa", name: "CORE One", bed: [250, 220, 270] },
  { id: "prusa-mk4", brand: "Prusa", name: "MK4 / MK3S", bed: [250, 210, 220] },
  { id: "prusa-mini", brand: "Prusa", name: "MINI", bed: [180, 180, 180] },
  { id: "generic-220", brand: "Other", name: "220 × 220", bed: [220, 220, 250] },
  { id: "generic-350", brand: "Other", name: "350 × 350", bed: [350, 350, 350] },
];

export const printerById = (id: string | undefined): PrinterProfile | undefined => PRINTERS.find((p) => p.id === id);

/** "Bambu Lab H2S" */
export const printerName = (p: PrinterProfile): string => (p.brand === "Other" ? p.name : `${p.brand} ${p.name}`);

/**
 * The part of a bed that can be printed on: its width and depth less what cannot be used
 * (`margin`: mm lost across the width and across the depth, e.g. [0, 20] for 2 cm at the back).
 */
export function usableBed(bed: readonly number[], margin: readonly number[] = [0, 0]): [number, number] {
  return [bed[0]! - (margin[0] ?? 0), bed[1]! - (margin[1] ?? 0)];
}
