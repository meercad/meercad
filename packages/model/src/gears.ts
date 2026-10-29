/**
 * Involute gears (ISO 21771 notation): sizes, the outline of spur gears, ring gears and racks, and
 * where a gear sits to mesh with another. Pure geometry in plane coordinates, shared by the kernel,
 * which builds the solids, and the app, which shows the sizes.
 */

export type GearKind = "spur" | "internal" | "rack";

export interface GearParams {
  kind: GearKind;
  /** Normal module, mm. */
  module: number;
  teeth: number;
  /** Pressure angle, degrees. */
  pressureAngle: number;
  /** Profile shift coefficient (spur gears only). */
  profileShift: number;
  /** Helix angle, degrees; + right hand, − left hand. */
  helix: number;
  herringbone: boolean;
  /** Circumferential backlash of a pair, mm; each gear takes half of it. */
  backlash: number;
  /** Tip clearance factor c*. */
  clearance: number;
}

export const GEAR_DEFAULTS = { pressureAngle: 20, profileShift: 0, helix: 0, backlash: 0.15, clearance: 0.25 } as const;

export interface GearDims {
  /** Transverse module and pressure angle (radians). */
  mt: number;
  alphaT: number;
  /** Pitch, base, tip and root diameters (ring gear: tip is the inner diameter). Rack: NaN. */
  d: number;
  db: number;
  da: number;
  df: number;
  /** Circular pitch along the pitch circle or line. */
  pitch: number;
  /** Fewest teeth without undercut for this pressure angle and profile shift. */
  minTeeth: number;
  /** Span measurement over k teeth (spur gears with a straight tooth). */
  span?: { k: number; w: number };
  warnings: string[];
}

const rad = (deg: number) => (deg * Math.PI) / 180;
export const involute = (a: number) => Math.tan(a) - a;

/** Inverse of the involute function (Newton on tan a − a = v). */
export function inverseInvolute(v: number): number {
  let a = Math.cbrt(3 * v);
  for (let i = 0; i < 30; i++) {
    const t = Math.tan(a);
    const step = (t - a - v) / (t * t);
    a -= step;
    if (Math.abs(step) < 1e-14) break;
  }
  return a;
}

export function gearDims(p: GearParams): GearDims {
  const beta = rad(p.helix);
  const alpha = rad(p.pressureAngle);
  const mt = p.module / Math.cos(beta);
  const alphaT = Math.atan(Math.tan(alpha) / Math.cos(beta));
  const m = p.module;
  const x = p.kind === "spur" ? p.profileShift : 0;
  const pitch = Math.PI * mt;
  const minTeeth = (2 * (1 - x)) / Math.sin(alphaT) ** 2;
  const warnings: string[] = [];
  if (p.kind === "rack") return { mt, alphaT, d: NaN, db: NaN, da: NaN, df: NaN, pitch, minTeeth, warnings };
  const d = mt * p.teeth;
  const db = d * Math.cos(alphaT);
  let da: number, df: number;
  if (p.kind === "internal") {
    da = d - 2 * m;
    df = d + 2 * m * (1 + p.clearance);
    if (da < db) warnings.push(`the ring's teeth reach below the base circle; use ${Math.ceil(2 / (1 - Math.cos(alphaT)))} or more teeth for a clean involute`);
  } else {
    da = d + 2 * m * (1 + x);
    df = d - 2 * m * (1 + p.clearance - x);
    if (p.teeth < minTeeth - 1e-9) {
      const shift = (1 - (p.teeth * Math.sin(alphaT) ** 2) / 2).toFixed(2);
      warnings.push(`${p.teeth} teeth are undercut at ${p.pressureAngle}°; a profile shift of about ${shift} avoids it`);
    }
  }
  if (df <= 0) warnings.push("the root circle is smaller than zero; use more teeth or a smaller module");
  let span: GearDims["span"];
  if (p.kind === "spur" && Math.abs(p.helix) < 1e-9) {
    const k = Math.max(2, Math.round((p.teeth * p.pressureAngle) / 180 + 0.5));
    span = { k, w: m * Math.cos(alpha) * (Math.PI * (k - 0.5) + p.teeth * involute(alpha)) + 2 * x * m * Math.sin(alpha) - (p.backlash / 2) * Math.cos(alpha) };
  }
  return { mt, alphaT, d, db, da, df, pitch, minTeeth, ...(span ? { span } : {}), warnings };
}

/** Centre distance of two gears in mesh (external pair, or a spur gear inside a ring gear). */
export function centerDistance(a: GearParams, b: GearParams): number {
  const internal = a.kind === "internal" || b.kind === "internal";
  const { mt, alphaT } = gearDims(a);
  const za = a.kind === "spur" ? a.teeth : -a.teeth;
  const zb = b.kind === "spur" ? b.teeth : -b.teeth;
  const xa = a.kind === "spur" ? a.profileShift : 0;
  const xb = b.kind === "spur" ? b.profileShift : 0;
  const sumZ = internal ? Math.abs(za + zb) : za + zb;
  const a0 = (mt * sumZ) / 2;
  const sumX = xa + xb;
  if (Math.abs(sumX) < 1e-12 || internal) return a0;
  const alphaW = inverseInvolute(involute(alphaT) + (2 * Math.tan(rad(a.pressureAngle)) * sumX) / sumZ);
  return (a0 * Math.cos(alphaT)) / Math.cos(alphaW);
}

// ---------------------------------------------------------------- outline

export type Pt = [number, number];
/** One piece of a closed outline; two points make a straight edge, more a smooth curve through them. */
export interface OutlineSegment {
  part: "flank" | "tip" | "root" | "rim" | "back" | "end";
  pts: Pt[];
}

const polar = (r: number, a: number): Pt => [r * Math.cos(a), r * Math.sin(a)];
const arc = (r: number, a0: number, a1: number, n = 6): Pt[] => Array.from({ length: n + 1 }, (_, i) => polar(r, a0 + ((a1 - a0) * i) / n));

/**
 * Counter-clockwise outline of an external gear around the origin, tooth 1 centred on +x.
 * Flanks are involutes, radial below the base circle; `thickness` adjusts the tooth thickness at
 * the pitch circle (negative = thinner, for backlash).
 */
function externalOutline(z: number, mt: number, alphaT: number, ra: number, rf: number, toothThickness: number): OutlineSegment[] {
  const r = (mt * z) / 2;
  const rb = r * Math.cos(alphaT);
  const psi = toothThickness / (2 * r);
  // Half angle of the tooth at radius ρ (on the involute: ρ ≥ rb).
  const eta = (rho: number) => psi + involute(alphaT) - involute(Math.acos(Math.min(1, rb / rho)));
  const etaA = eta(ra);
  if (etaA <= 0) throw new GearError("the teeth come to a point; use a smaller profile shift or more teeth");
  const rStart = Math.max(rb, rf);
  const etaF = eta(rStart);
  if (etaF >= Math.PI / z) throw new GearError("the teeth overlap at the root; use fewer teeth or a smaller module");
  // Involute points spaced evenly in roll angle.
  const t0 = Math.sqrt(Math.max(0, (rStart / rb) ** 2 - 1));
  const t1 = Math.sqrt((ra / rb) ** 2 - 1);
  const radii = Array.from({ length: FLANK_POINTS }, (_, i) => rb * Math.sqrt(1 + (t0 + ((t1 - t0) * i) / (FLANK_POINTS - 1)) ** 2));
  radii[0] = rStart;
  radii[FLANK_POINTS - 1] = ra;
  const out: OutlineSegment[] = [];
  for (let k = 0; k < z; k++) {
    const c = (2 * Math.PI * k) / z;
    if (rf < rb) out.push({ part: "flank", pts: [polar(rf, c - etaF), polar(rb, c - etaF)] });
    out.push({ part: "flank", pts: radii.map((rho) => polar(rho, c - eta(rho))) });
    out.push({ part: "tip", pts: arc(ra, c - etaA, c + etaA, 4) });
    out.push({ part: "flank", pts: [...radii].reverse().map((rho) => polar(rho, c + eta(rho))) });
    if (rf < rb) out.push({ part: "flank", pts: [polar(rb, c + etaF), polar(rf, c + etaF)] });
    out.push({ part: "root", pts: arc(rf, c + etaF, c + (2 * Math.PI) / z - etaF, 4) });
  }
  return out;
}

export class GearError extends Error {}

/** Points along each involute flank. With fewer, the curve through them bulges out near the base circle and eats the backlash. */
const FLANK_POINTS = 17;

export interface GearShape {
  /** Outer boundary (counter-clockwise), in the gear's own coordinates. */
  outer: OutlineSegment[];
  /** Ring gears: the toothed hole (counter-clockwise). */
  inner?: OutlineSegment[];
}

/**
 * Outline of the gear in its own coordinates: axis at the origin, tooth 1 on +x (a ring gear's
 * tooth 1 points inward along +x). A rack runs along x centred on the origin with its teeth up
 * (+y) and its pitch line on y = 0.
 */
export function gearShape(p: GearParams, opts: { rim?: number; length?: number } = {}): GearShape {
  const { mt, alphaT, da, df, pitch } = gearDims(p);
  const m = p.module;
  const j = p.backlash;
  if (p.kind === "spur") {
    const s = mt * (Math.PI / 2 + 2 * p.profileShift * Math.tan(rad(p.pressureAngle))) - j / 2;
    return { outer: externalOutline(p.teeth, mt, alphaT, da / 2, df / 2, s) };
  }
  if (p.kind === "internal") {
    // The ring's tooth gaps have the shape of an external gear's teeth (one tooth's turn later).
    const outerD = opts.rim ?? df + 4 * m;
    if (outerD <= df + 0.2) throw new GearError(`the ring needs an outside diameter above ${df.toFixed(2)} mm`);
    const gaps = externalOutline(p.teeth, mt, alphaT, df / 2, da / 2, (mt * Math.PI) / 2 + j / 2);
    const turn = Math.PI / p.teeth;
    const inner = gaps.map((s) => ({
      part: s.part === "tip" ? ("root" as const) : s.part === "root" ? ("tip" as const) : s.part,
      pts: s.pts.map(([u, v]): Pt => [u * Math.cos(turn) - v * Math.sin(turn), u * Math.sin(turn) + v * Math.cos(turn)]),
    }));
    return { outer: [{ part: "rim", pts: arc(outerD / 2, 0, Math.PI, 8) }, { part: "rim", pts: arc(outerD / 2, Math.PI, 2 * Math.PI, 8) }], inner };
  }
  // Rack: trapezoid teeth, flanks at the pressure angle.
  const n = Math.round(p.teeth);
  const back = opts.rim ?? 2 * m;
  const hf = m * (1 + p.clearance);
  const t = Math.tan(alphaT);
  const half = pitch / 4 - j / 4;
  if (half - m * t <= 0.01 * m) throw new GearError("the rack's teeth come to a point; use a smaller pressure angle");
  if (pitch / 2 - (half + hf * t) <= 0) throw new GearError("the rack's teeth overlap at the root");
  const L = opts.length ?? n * pitch;
  const yb = -hf - back;
  const out: OutlineSegment[] = [
    { part: "back", pts: [[-L / 2, yb], [L / 2, yb]] },
    { part: "end", pts: [[L / 2, yb], [L / 2, -hf]] },
  ];
  let x = L / 2;
  for (let k = n - 1; k >= 0; k--) {
    const c = (k - (n - 1) / 2) * pitch;
    const right = c + half + hf * t;
    const left = c - half - hf * t;
    out.push({ part: "root", pts: [[x, -hf], [right, -hf]] });
    out.push({ part: "flank", pts: [[right, -hf], [c + half - m * t, m]] });
    out.push({ part: "tip", pts: [[c + half - m * t, m], [c - half + m * t, m]] });
    out.push({ part: "flank", pts: [[c - half + m * t, m], [left, -hf]] });
    x = left;
  }
  out.push({ part: "root", pts: [[x, -hf], [-L / 2, -hf]] });
  out.push({ part: "end", pts: [[-L / 2, -hf], [-L / 2, yb]] });
  // Drop zero-length pieces (teeth reaching the rack's ends).
  return { outer: out.filter((s) => Math.hypot(s.pts[0]![0] - s.pts.at(-1)![0], s.pts[0]![1] - s.pts.at(-1)![1]) > 1e-9) };
}

/** Area enclosed by an outline (shoelace over its points), for checks. */
export function outlineArea(segments: OutlineSegment[]): number {
  let a = 0;
  for (const s of segments) for (let i = 0; i + 1 < s.pts.length; i++) a += s.pts[i]![0] * s.pts[i + 1]![1] - s.pts[i + 1]![0] * s.pts[i]![1];
  return a / 2;
}

// ---------------------------------------------------------------- placement

/** Where a gear sits in its plane: centre (rack: middle of its pitch line) and turn, radians. */
export interface GearPlacement {
  params: GearParams;
  center: Pt;
  rotation: number;
  width: number;
}

/**
 * Places `gear` in mesh with `partner`. `direction` (radians, in the plane) is the line from the
 * partner's centre towards the new gear; with a rack as partner the gear sits on the middle of the rack.
 * Returns the centre and turn so a tooth of one meets a gap of the other.
 */
export function meshPlacement(partner: GearPlacement, gear: GearParams, direction: number): { center: Pt; rotation: number } {
  const P = partner.params;
  if (P.kind === "rack" && gear.kind === "rack") throw new GearError("two racks cannot mesh");
  if (P.kind === "internal" && gear.kind === "internal") throw new GearError("two ring gears cannot mesh");
  if (P.kind === "internal" && gear.kind === "rack") throw new GearError("a rack cannot mesh with a ring gear");
  if (P.kind === "rack" && gear.kind === "internal") throw new GearError("a ring gear cannot mesh with a rack");
  const [cx, cy] = partner.center;
  const dirV = (a: number): Pt => [Math.cos(a), Math.sin(a)];
  const add = (p: Pt, d: Pt, s: number): Pt => [p[0] + d[0] * s, p[1] + d[1] * s];
  const dims = gearDims(gear);
  const m = gear.module;
  if (P.kind === "rack") {
    // The rack's up direction points at the gear; the gear's pitch circle rolls on the pitch line.
    const up = partner.rotation + Math.PI / 2;
    const r = dims.d / 2 + gear.profileShift * m;
    const rackHasToothAtMiddle = Math.round(P.teeth) % 2 === 1;
    return { center: add([cx, cy], dirV(up), r), rotation: up + Math.PI + (rackHasToothAtMiddle ? Math.PI / gear.teeth : 0) };
  }
  const pd = gearDims(P);
  if (gear.kind === "rack") {
    // Rack tangent to the partner at `direction`, teeth towards it, shifted to meet its teeth.
    const r = pd.d / 2 + P.profileShift * P.module;
    const rotation = direction + Math.PI / 2;
    const gapOffset = Math.round(gear.teeth) % 2 === 1 ? dims.pitch / 2 : 0;
    const shift = -gapOffset + r * (partner.rotation - direction);
    // Racks repeat every pitch: keep the shift small so the rack stays centred on the gear.
    const s = shift - dims.pitch * Math.round(shift / dims.pitch);
    return { center: add(add([cx, cy], dirV(direction), r), dirV(rotation), s), rotation };
  }
  const a = centerDistance(P, gear);
  const center = add([cx, cy], dirV(direction), a);
  const z1 = P.teeth;
  const z2 = gear.teeth;
  if (P.kind === "spur" && gear.kind === "spur") {
    return { center, rotation: direction + Math.PI + Math.PI / z2 - (z1 / z2) * (partner.rotation - direction) };
  }
  if (P.kind === "internal") {
    // Gear inside the ring: a tooth of the gear points out into a gap of the ring.
    return { center, rotation: direction + (z1 / z2) * (partner.rotation + Math.PI / z1 - direction) };
  }
  // Ring around the partner gear: seen from the ring, the gear lies the other way.
  const back = direction + Math.PI;
  return { center, rotation: back - Math.PI / z2 + (z1 / z2) * (partner.rotation - back) };
}

/** Helix of a gear meshing with `partner`: opposite hand for an external pair, the same otherwise. */
export function meshHelix(partner: GearParams, gear: GearKind): number {
  return partner.kind === "spur" && gear === "spur" ? -partner.helix : partner.helix;
}

/**
 * Turn of the cross-section at height `z` (0…width) caused by the helix, radians. Racks shift
 * instead of turning: the result is then a shift along x, mm.
 */
export function helixTwist(p: GearParams, width: number, z: number): number {
  if (Math.abs(p.helix) < 1e-12) return 0;
  const along = p.herringbone ? width / 2 - Math.abs(z - width / 2) : z;
  const t = Math.tan(rad(p.helix)) * along;
  if (p.kind === "rack") return t;
  return t / (gearDims(p).d / 2);
}
