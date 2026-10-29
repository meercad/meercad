/** Gear sizes for assistants planning a drive (no app needed). */
import { centerDistance, GEAR_DEFAULTS, gearDims, type GearKind, type GearParams } from "@meercad/model";

const r = (v: number) => +v.toFixed(4);

export function gearCalc(a: { module: number; teeth: number; teeth2?: number | undefined; kind2?: GearKind | undefined; pressureAngle?: number | undefined; profileShift?: number | undefined; helix?: number | undefined }) {
  const g1: GearParams = {
    kind: "spur",
    module: a.module,
    teeth: a.teeth,
    herringbone: false,
    ...GEAR_DEFAULTS,
    ...(a.pressureAngle !== undefined ? { pressureAngle: a.pressureAngle } : {}),
    ...(a.profileShift !== undefined ? { profileShift: a.profileShift } : {}),
    ...(a.helix !== undefined ? { helix: a.helix } : {}),
  };
  const describe = (g: GearParams) => {
    const d = gearDims(g);
    return g.kind === "rack"
      ? { kind: g.kind, teeth: g.teeth, pitch: r(d.pitch), length: r(g.teeth * d.pitch), warnings: d.warnings }
      : {
          kind: g.kind,
          teeth: g.teeth,
          pitchDiameter: r(d.d),
          [g.kind === "internal" ? "innerDiameter" : "outsideDiameter"]: r(d.da),
          rootDiameter: r(d.df),
          ...(d.span ? { spanOverTeeth: { k: d.span.k, w: r(d.span.w) } } : {}),
          warnings: d.warnings,
        };
  };
  const out: Record<string, unknown> = { module: a.module, transverseModule: r(gearDims(g1).mt), gear: describe(g1) };
  if (a.teeth2 !== undefined) {
    const kind2 = a.kind2 ?? "spur";
    // A mating gear turns the other way outside, the same way in a ring; a rack moves along.
    const g2: GearParams = { ...g1, kind: kind2, teeth: a.teeth2, profileShift: 0, helix: kind2 === "spur" ? -g1.helix : g1.helix };
    out["mate"] = describe(g2);
    if (kind2 === "rack") out["travelPerTurn"] = r(Math.PI * gearDims(g1).d);
    else {
      out["centreDistance"] = r(centerDistance(g1, g2));
      out["ratio"] = r(a.teeth2 / a.teeth);
    }
  }
  return out;
}
