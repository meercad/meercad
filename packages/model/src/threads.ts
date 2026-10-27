/**
 * ISO metric threads (ISO 261/262 sizes, ISO 68-1 basic profile). Shared by the kernel, which
 * models them, and the app, which offers the sizes.
 */

export interface MetricThread {
  size: string;
  /** Nominal (major) diameter, mm. */
  d: number;
  /** Coarse pitch, mm. */
  pitch: number;
  /** Common fine pitches, mm. */
  fine: number[];
}

export const METRIC_THREADS: readonly MetricThread[] = [
  { size: "M1.6", d: 1.6, pitch: 0.35, fine: [0.2] },
  { size: "M2", d: 2, pitch: 0.4, fine: [0.25] },
  { size: "M2.5", d: 2.5, pitch: 0.45, fine: [0.35] },
  { size: "M3", d: 3, pitch: 0.5, fine: [0.35] },
  { size: "M4", d: 4, pitch: 0.7, fine: [0.5] },
  { size: "M5", d: 5, pitch: 0.8, fine: [0.5] },
  { size: "M6", d: 6, pitch: 1, fine: [0.75] },
  { size: "M8", d: 8, pitch: 1.25, fine: [1, 0.75] },
  { size: "M10", d: 10, pitch: 1.5, fine: [1.25, 1] },
  { size: "M12", d: 12, pitch: 1.75, fine: [1.5, 1.25] },
  { size: "M14", d: 14, pitch: 2, fine: [1.5] },
  { size: "M16", d: 16, pitch: 2, fine: [1.5] },
  { size: "M18", d: 18, pitch: 2.5, fine: [2, 1.5] },
  { size: "M20", d: 20, pitch: 2.5, fine: [2, 1.5] },
  { size: "M22", d: 22, pitch: 2.5, fine: [2, 1.5] },
  { size: "M24", d: 24, pitch: 3, fine: [2] },
  { size: "M27", d: 27, pitch: 3, fine: [2] },
  { size: "M30", d: 30, pitch: 3.5, fine: [2] },
  { size: "M36", d: 36, pitch: 4, fine: [3] },
  { size: "M42", d: 42, pitch: 4.5, fine: [3] },
  { size: "M48", d: 48, pitch: 5, fine: [3] },
];

/** Minor diameter of the internal thread (the tap drill size): D − 1.0825·P. */
export const internalMinor = (d: number, pitch: number) => d - 1.082532 * pitch;
/** Minor diameter of the external thread: d − 1.2269·P. */
export const externalMinor = (d: number, pitch: number) => d - 1.226869 * pitch;

/** Parses "M8" / "M2.5"; null when it is not a metric designation. */
export function parseMetric(size: string): number | null {
  const m = /^M(\d+(?:\.\d+)?)$/.exec(size.trim());
  return m ? Number(m[1]) : null;
}

/**
 * The thread for a cylinder of diameter `dia`: the named size, or the standard size the cylinder
 * was most likely drawn for (a hole at the nominal or the tap drill diameter, a shaft at nominal).
 */
export function threadFor(dia: number, internal: boolean, size?: string, pitch?: number): { size: string; d: number; pitch: number } {
  if (size) {
    const d = parseMetric(size);
    if (d === null || !(d > 0)) throw new Error(`unknown thread size "${size}" (use e.g. M8)`);
    const std = METRIC_THREADS.find((t) => t.d === d);
    const p = pitch ?? std?.pitch;
    if (!p) throw new Error(`${size} is not a standard size; give a pitch`);
    return { size: std?.size ?? `M${d}`, d, pitch: p };
  }
  const score = (t: MetricThread) => Math.min(Math.abs(dia - t.d), internal ? Math.abs(dia - internalMinor(t.d, t.pitch)) : Infinity);
  const best = [...METRIC_THREADS].sort((a, b) => score(a) - score(b))[0]!;
  return { size: best.size, d: best.d, pitch: pitch ?? best.pitch };
}
