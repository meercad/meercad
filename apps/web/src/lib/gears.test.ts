/** Gear sizes for the dialog, following the partner a gear meshes with. */
import { describe, expect, it } from "vitest";
import type { Feature, GearFeature } from "@meercad/schema";
import { gearParams, pairInfo } from "./gears";

const gear = (id: string, more: Partial<GearFeature>): GearFeature => ({
  id,
  op: "gear",
  kind: "spur",
  mode: "new_body",
  teeth: 20,
  width: 5,
  ...more,
});

const driver = gear("g1", {
  module: "m",
  helix: 15,
  herringbone: true,
  pressureAngle: 25,
  profileShift: 0.2,
});
const driven = gear("g2", { teeth: 40, meshWith: { gear: "g1" }, backlash: 0.1, profileShift: 0.1 });
const ring = gear("g3", { kind: "internal", teeth: 60, meshWith: { gear: "g1" }, profileShift: 0.3 });
const rack = gear("g4", { kind: "rack", teeth: 30, meshWith: { gear: "g1" } });
const features: Feature[] = [driver, driven, ring, rack];
const params = { m: 2 };

describe("gearParams", () => {
  it("evaluates a gear's own values with the defaults for the rest", () => {
    expect(gearParams(driver, features, params)).toEqual({
      kind: "spur",
      module: 2,
      teeth: 20,
      pressureAngle: 25,
      profileShift: 0.2,
      helix: 15,
      herringbone: true,
      backlash: 0.15,
      clearance: 0.25,
    });
  });

  it("takes module, pressure angle, helix and herringbone from the partner", () => {
    expect(gearParams(driven, features, params)).toMatchObject({
      module: 2,
      teeth: 40,
      pressureAngle: 25,
      profileShift: 0.1,
      helix: -15,
      herringbone: true,
      backlash: 0.1,
    });
    // A ring turns the same way as its pinion and has no profile shift of its own.
    expect(gearParams(ring, features, params)).toMatchObject({ helix: 15, profileShift: 0 });
  });

  it("gives null while a value does not evaluate or the partner is missing", () => {
    expect(gearParams(gear("g", { module: "nope" }), features, params)).toBeNull();
    expect(gearParams(gear("g", {}), features, params)).toBeNull();
    expect(gearParams(gear("g", { module: 1, teeth: "1 +" }), features, params)).toBeNull();
    expect(gearParams(gear("g", { meshWith: { gear: "none" } }), features, params)).toBeNull();
    expect(gearParams(driven, features, {})).toBeNull();
  });

  it("stops at gears that mesh with each other in a circle", () => {
    const a = gear("a", { meshWith: { gear: "b" } });
    const b = gear("b", { meshWith: { gear: "a" } });

    expect(gearParams(a, [a, b], params)).toBeNull();
  });
});

describe("pairInfo", () => {
  it("gives centre distance and ratio to the partner", () => {
    const info = pairInfo(driven, features, params)!;

    expect(info.ratio).toBe(2);
    expect(info.distance).toBeGreaterThan(60);
    expect(pairInfo(rack, features, params)!.distance).toBeNaN();
  });

  it("gives null without a partner or with sizes that do not evaluate", () => {
    expect(pairInfo(driver, features, params)).toBeNull();
    expect(pairInfo(gear("g", { meshWith: { gear: "none" } }), features, params)).toBeNull();
    expect(pairInfo(driven, features, {})).toBeNull();
    expect(pairInfo(gear("g", { teeth: "x", meshWith: { gear: "g1" } }), features, params)).toBeNull();
  });
});
