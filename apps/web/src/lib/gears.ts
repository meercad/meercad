/** Gear sizes for the dialog: the parameters a gear feature ends up with, following `meshWith`. */
import { centerDistance, evaluate, GEAR_DEFAULTS, meshHelix, type GearParams } from "@meercad/model";
import type { Expr, Feature, GearFeature } from "@meercad/schema";

/** The gear's effective parameters, or null while a value does not evaluate. */
export function gearParams(
  feature: GearFeature,
  features: readonly Feature[],
  params: Record<string, number>,
  depth = 0,
): GearParams | null {
  const scope = new Map(Object.entries(params));

  const num = (expr: Expr | undefined, fallback: number) => {
    if (expr === undefined) return fallback;

    try {
      return evaluate(expr, scope);
    } catch {
      return NaN;
    }
  };

  const partnerF = feature.meshWith
    ? features.find((x): x is GearFeature => x.id === feature.meshWith!.gear && x.op === "gear")
    : undefined;
  const partner = partnerF && depth < 50 ? gearParams(partnerF, features, params, depth + 1) : null;
  if (feature.meshWith && !partner) return null;

  const p: GearParams = {
    kind: feature.kind,
    module: partner ? partner.module : num(feature.module, NaN),
    teeth: Math.round(num(feature.teeth, NaN)),
    pressureAngle: partner ? partner.pressureAngle : num(feature.pressureAngle, GEAR_DEFAULTS.pressureAngle),
    profileShift: feature.kind === "spur" ? num(feature.profileShift, 0) : 0,
    helix: partner ? meshHelix(partner, feature.kind) : num(feature.helix, 0),
    herringbone: partner ? partner.herringbone : !!feature.herringbone,
    backlash: num(feature.backlash, GEAR_DEFAULTS.backlash),
    clearance: num(feature.clearance, GEAR_DEFAULTS.clearance),
  };

  return Object.values(p).every((v) => typeof v !== "number" || Number.isFinite(v)) ? p : null;
}

/** Centre distance and ratio to the partner gear, when this gear meshes with one. */
export function pairInfo(
  feature: GearFeature,
  features: readonly Feature[],
  params: Record<string, number>,
): { distance: number; ratio: number } | null {
  const partnerF = feature.meshWith
    ? features.find((x): x is GearFeature => x.id === feature.meshWith!.gear && x.op === "gear")
    : undefined;
  if (!partnerF) return null;

  const a = gearParams(partnerF, features, params);
  const b = gearParams(feature, features, params);
  if (!a || !b) return null;

  return {
    distance: a.kind === "rack" || b.kind === "rack" ? NaN : centerDistance(a, b),
    ratio: b.teeth / a.teeth,
  };
}
