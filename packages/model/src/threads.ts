import type { ThreadProfile } from "@meercad/schema";

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
  const match = /^M(\d+(?:\.\d+)?)$/.exec(size.trim());

  return match ? Number(match[1]) : null;
}

/**
 * The thread for a cylinder of diameter `dia`: the named size, or the standard size the cylinder
 * was most likely drawn for (a hole at the nominal or the tap drill diameter, a shaft at nominal).
 */
export function threadFor(
  dia: number,
  internal: boolean,
  size?: string,
  pitch?: number,
): { size: string; d: number; pitch: number } {
  if (size) {
    const d = parseMetric(size);
    if (d === null || !(d > 0)) throw new Error(`unknown thread size "${size}" (use e.g. M8)`);

    const std = METRIC_THREADS.find((thread) => thread.d === d);
    const p = pitch ?? std?.pitch;
    if (!p) throw new Error(`${size} is not a standard size; give a pitch`);

    return { size: std?.size ?? `M${d}`, d, pitch: p };
  }

  const score = (thread: MetricThread) =>
    Math.min(
      Math.abs(dia - thread.d),
      internal ? Math.abs(dia - internalMinor(thread.d, thread.pitch)) : Infinity,
    );
  const best = [...METRIC_THREADS].sort((a, b) => score(a) - score(b))[0]!;

  return { size: best.size, d: best.d, pitch: pitch ?? best.pitch };
}

// ---------------------------------------------------------------- thread profiles

/**
 * Thread forms: ISO metric (60°), trapezoidal (ISO 2904, 30°, lead screws and vices), square,
 * buttress (ISO 3030, 3°/30°, one-way loads such as clamps) and round (knuckle, DIN 405 style: jar
 * lids, bottle caps, printed threads that must not catch).
 */
export type { ThreadProfile };
export const THREAD_PROFILES: readonly ThreadProfile[] = ["iso", "trapezoid", "square", "buttress", "round"];

/** Pitches of ISO 2904 trapezoidal threads by nominal diameter (preferred series). */
const TRAPEZOID_PITCH: [number, number][] = [
  [8, 1.5],
  [10, 2],
  [12, 3],
  [14, 3],
  [16, 4],
  [18, 4],
  [20, 4],
  [22, 5],
  [24, 5],
  [26, 5],
  [28, 5],
  [30, 6],
  [32, 6],
  [36, 6],
  [40, 7],
  [44, 7],
  [48, 8],
  [52, 8],
  [60, 9],
  [70, 10],
  [80, 10],
  [100, 12],
];

/** The usual pitch of a thread form at a nominal diameter. */
export function defaultPitch(profile: ThreadProfile, d: number): number {
  if (profile === "iso") {
    const best = [...METRIC_THREADS].sort((a, b) => Math.abs(a.d - d) - Math.abs(b.d - d))[0]!;

    return best.d === d ? best.pitch : Math.max(0.2, Math.round(((best.pitch * d) / best.d) * 20) / 20);
  }

  if (d < 8) return Math.max(1, Math.round((d / 5) * 2) / 2);

  const best = [...TRAPEZOID_PITCH].sort((a, b) => Math.abs(a[0] - d) - Math.abs(b[0] - d))[0]!;

  return best[1];
}

/**
 * The resolved thread: designation, nominal diameter, pitch and lead. `size` names a metric size
 * ("M8") or is omitted; `diameter` overrides the drawn one; otherwise an ISO thread takes the
 * standard size the cylinder was drawn for and the other forms the drawn diameter itself.
 */
export function threadSpec(
  dia: number,
  internal: boolean,
  o: { profile?: ThreadProfile; size?: string; diameter?: number; pitch?: number; starts?: number },
): { size: string; d: number; pitch: number; lead: number; starts: number; profile: ThreadProfile } {
  const profile = o.profile ?? "iso";
  const starts = Math.round(o.starts ?? 1);
  if (!(starts >= 1 && starts <= 8)) throw new Error("a thread has 1 to 8 starts");

  let d: number;
  let pitch: number | undefined = o.pitch;
  let size: string;

  if (profile === "iso" && o.diameter === undefined) {
    const std = threadFor(dia, internal, o.size, o.pitch);
    d = std.d;
    pitch = std.pitch;
    size = std.size;
  } else {
    d = o.diameter ?? (o.size ? (parseMetric(o.size) ?? NaN) : dia);
    if (!(d > 0)) throw new Error(`unknown thread size "${o.size}"`);

    pitch ??= defaultPitch(profile, d);

    const nice = (v: number) => String(Math.round(v * 100) / 100);
    size = profile === "iso" ? `M${nice(d)}` : profile === "trapezoid" ? `Tr${nice(d)}` : `Ø${nice(d)}`;
  }

  if (!(pitch! > 0)) throw new Error("the pitch must be greater than zero");

  const lead = pitch! * starts;

  if (profile !== "iso" || pitch !== METRIC_THREADS.find((thread) => thread.d === d)?.pitch || starts > 1) {
    size = `${size}×${starts > 1 ? `${Math.round(lead * 100) / 100} P${pitch}` : pitch}`;
  }

  return { size, d, pitch: pitch!, lead, starts, profile };
}

/**
 * The groove one thread start cuts, in (radius, axial offset) about the groove's middle: a closed
 * outline reaching `extra` beyond the crest diameter into free space so the cut is clean. `crest`
 * is the diameter the blank must have (internal: the minor, external: the major), `root` the bottom
 * of the groove; both include the printing clearance `c` (internal threads grow, external ones shrink).
 */
export function grooveShape(
  profile: ThreadProfile,
  d: number,
  P: number,
  internal: boolean,
  c = 0,
  extra = 0.05 * P,
): { crest: number; root: number; outline: [number, number][] } {
  const R = d / 2;
  const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);
  // Crest radius, root radius, groove width at the crest, flank angles (lower, upper side).
  let rc: number, rr: number, wc: number, a1: number, a2: number;
  const ac = P <= 1.5 ? 0.15 : P <= 5 ? 0.25 : 0.5;

  switch (profile) {
    case "iso":
      if (internal) {
        rc = internalMinor(d, P) / 2 + c;
        rr = R + c;
        wc = 0.75 * P;
      } else {
        rc = R - c;
        rr = externalMinor(d, P) / 2 - c;
        wc = 0.875 * P;
      }

      a1 = a2 = 30;
      break;
    case "trapezoid":
      // ISO 2904: tooth 0.366·P wide at the crest, depth 0.5·P + ac, 15° flanks.
      rc = internal ? (d - P) / 2 + c : R - c;
      rr = internal ? R + ac + c : R - 0.5 * P - ac - c;
      wc = 0.634 * P;
      a1 = a2 = 15;
      break;
    case "square":
      rc = internal ? R - 0.5 * P + c : R - c;
      rr = internal ? R + 0.05 * P + c : R - 0.5 * P - c;
      wc = 0.5 * P;
      a1 = a2 = 0;
      break;
    case "buttress":
      // ISO 3030: load flank 3°, back flank 30°; external depth 0.868·P, internal 0.75·P.
      rc = internal ? R - 0.75 * P + c : R - c;
      rr = internal ? R + 0.118 * P + c : R - 0.868 * P - c;
      wc = 0.736 * P;
      a1 = 3;
      a2 = 30;
      break;
    case "round": {
      // Knuckle thread: a rounded groove 0.5·P deep (half an ellipse), rounded crests between.
      const h = 0.5 * P;
      rc = internal ? R - h + c : R - c;
      rr = internal ? R + 0.05 * P + c : R - h - c;

      const out = internal ? -1 : 1;
      const depth = Math.abs(rc - rr);
      const w = 0.92 * P;
      const pts: [number, number][] = [[rc + out * extra, -w / 2 - 0.04 * P]];

      // The arc's own ends would lie exactly on the crest cylinder, which booleans handle badly: left out.
      for (let k = 1; k < 8; k++) {
        const th = -Math.PI / 2 + (k / 8) * Math.PI;
        pts.push([rc - out * depth * Math.cos(th), (w / 2) * Math.sin(th)]);
      }

      pts.push([rc + out * extra, w / 2 + 0.04 * P]);

      return { crest: rc * 2, root: rr * 2, outline: pts };
    }
  }

  // Material is inside (external) or outside (internal) the crest radius; the groove goes into it.
  const out = internal ? -1 : 1;
  const h = Math.abs(rc - rr);
  const lo = -wc / 2;
  const hi = wc / 2;
  const outline: [number, number][] = [
    [rc + out * extra, lo - extra * tan(a1)],
    [rr, lo + h * tan(a1)],
    [rr, hi - h * tan(a2)],
    [rc + out * extra, hi + extra * tan(a2)],
  ];
  if (outline[2]![1] - outline[1]![1] < 1e-6) throw new Error("the thread profile does not fit this pitch");

  return { crest: rc * 2, root: rr * 2, outline };
}
