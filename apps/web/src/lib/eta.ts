/**
 * How long long work still takes, from its progress. Work whose progress does not grow evenly with
 * time gives a curve: for each progress, the share of the whole time that has gone by then.
 */
export type PaceCurve = readonly (readonly [progress: number, time: number])[];

/**
 * Apple's photogrammetry (a model from photos), measured on 77 drone photos on the Mac at full and
 * reduced detail (7.5 and 6.8 min), averaged: when each progress is first reached, as a share of the
 * whole time. Half the progress comes in the first fifth (the photos are read); then it stands still
 * for minutes and moves slowly.
 */
export const PHOTOGRAMMETRY: PaceCurve = [
  [0, 0],
  [0.05, 0.009],
  [0.1, 0.016],
  [0.15, 0.024],
  [0.2, 0.045],
  [0.25, 0.115],
  [0.3, 0.131],
  [0.35, 0.147],
  [0.4, 0.162],
  [0.45, 0.18],
  [0.5, 0.197],
  [0.55, 0.263],
  [0.6, 0.399],
  [0.65, 0.509],
  [0.7, 0.609],
  [0.75, 0.666],
  [0.8, 0.694],
  [0.85, 0.754],
  [0.9, 0.82],
  [0.95, 0.93],
  [0.98, 0.952],
  [1, 1],
];

/** The share of the time gone by at `p`, read off the curve (straight between its points). */
export function timeShare(curve: PaceCurve, p: number): number {
  if (p <= curve[0]![0]) return curve[0]![1];
  for (let i = 1; i < curve.length; i++) {
    const [p1, t1] = curve[i]!;
    if (p <= p1) {
      const [p0, t0] = curve[i - 1]!;
      return t0 + ((t1 - t0) * (p - p0)) / (p1 - p0 || 1);
    }
  }
  return 1;
}

/** A progress report: seconds from the first one, and the progress then. */
export type ProgressPoint = readonly [seconds: number, progress: number];

/**
 * Seconds still to go, or null while there is too little to go by. `points`: the progress so far,
 * oldest first; `ran`: seconds from the first progress to now.
 *
 * Without a curve, the straight estimate from the latest progress. With one, every report says how
 * long the whole work takes (its time over the curve's share at its progress); their mean is used, so
 * one early or late step does not throw it. While the progress stands still the time left counts
 * down, but never below what the next step of progress still leaves.
 */
export function secondsLeft(points: readonly ProgressPoint[], ran: number, curve?: PaceCurve): number | null {
  const p = points.at(-1)?.[1];
  if (p === undefined || p < 0.03 || ran < 20) return null;
  if (!curve) return (ran * (1 - p)) / p;
  const totals = points.filter(([, q]) => q >= 0.05).map(([at, q]) => at / timeShare(curve, q));
  if (!totals.length) return null;
  const total = totals.reduce((a, b) => a + b) / totals.length;
  return Math.max(total - ran, total * (1 - timeShare(curve, Math.min(1, p + 0.05))));
}
