/** Gear sizes for the dialog: the parameters a gear feature ends up with, following `meshWith`. */
import { centerDistance, evaluate, GEAR_DEFAULTS, meshHelix, type GearParams } from "@meercad/model";
import type { Expr, Feature, GearFeature } from "@meercad/schema";

/** The gear's effective parameters, or null while a value does not evaluate. */
export function gearParams(
  f: GearFeature,
  features: readonly Feature[],
  params: Record<string, number>,
  depth = 0,
): GearParams | null {
  const scope = new Map(Object.entries(params));

  const num = (e: Expr | undefined, fallback: number) => {
    if (e === undefined) return fallback;

    try {
      return evaluate(e, scope);
    } catch {
      return NaN;
    }
  };

  const partnerF = f.meshWith
    ? features.find((x): x is GearFeature => x.id === f.meshWith!.gear && x.op === "gear")
    : undefined;
  const partner = partnerF && depth < 50 ? gearParams(partnerF, features, params, depth + 1) : null;
  if (f.meshWith && !partner) return null;

  const p: GearParams = {
    kind: f.kind,
    module: partner ? partner.module : num(f.module, NaN),
    teeth: Math.round(num(f.teeth, NaN)),
    pressureAngle: partner ? partner.pressureAngle : num(f.pressureAngle, GEAR_DEFAULTS.pressureAngle),
    profileShift: f.kind === "spur" ? num(f.profileShift, 0) : 0,
    helix: partner ? meshHelix(partner, f.kind) : num(f.helix, 0),
    herringbone: partner ? partner.herringbone : !!f.herringbone,
    backlash: num(f.backlash, GEAR_DEFAULTS.backlash),
    clearance: num(f.clearance, GEAR_DEFAULTS.clearance),
  };

  return Object.values(p).every((v) => typeof v !== "number" || Number.isFinite(v)) ? p : null;
}

/** Centre distance and ratio to the partner gear, when this gear meshes with one. */
export function pairInfo(
  f: GearFeature,
  features: readonly Feature[],
  params: Record<string, number>,
): { distance: number; ratio: number } | null {
  const partnerF = f.meshWith
    ? features.find((x): x is GearFeature => x.id === f.meshWith!.gear && x.op === "gear")
    : undefined;
  if (!partnerF) return null;

  const a = gearParams(partnerF, features, params);
  const b = gearParams(f, features, params);
  if (!a || !b) return null;

  return {
    distance: a.kind === "rack" || b.kind === "rack" ? NaN : centerDistance(a, b),
    ratio: b.teeth / a.teeth,
  };
}
