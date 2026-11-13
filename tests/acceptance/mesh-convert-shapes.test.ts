import { describe, expect, it } from "vitest";
import { Arena, convertMesh, MAX_FACETS } from "@meercad/kernel";
import { getOcct } from "./helpers.js";
import { arc, insideOut, prism, turned, type P } from "./meshes.js";

/**
 * `convertMesh` on meshes of turned parts with known volumes: spheres, a capsule, two spheres
 * grown together, a double cone and a disc with a groove. Each comes back as a solid of the
 * recognised surfaces, its volume within 1 % of the mesh and close to the exact formula.
 */

async function convert(mesh: Float64Array, tolerance?: number) {
  const oc = await getOcct();
  const arena = new Arena();
  try {
    const r = convertMesh(oc, arena, mesh, tolerance === undefined ? {} : { tolerance });
    const props = arena.track(new oc.GProp_GProps());
    oc.BRepGProp.VolumeProperties(r.shape, props, false, false, false);
    const faces: number[] = [];
    for (const e = arena.track(new oc.TopExp_Explorer(r.shape, "TopAbs_FACE")); e.More(); e.Next()) faces.push(r.regionOf(arena.track(oc.TopoDS.Face(arena.track(e.Current())))));
    return { counts: r.counts, volume: props.Mass(), meshVolume: r.fit.volume, regions: faces, kinds: faces.map((i) => (i < 0 ? "?" : (r.fit.regions[i]!.primitive?.kind ?? "facet"))) };
  } finally {
    arena.dispose();
  }
}

describe("mesh_convert of turned shapes", () => {
  it("makes a ball one sphere of the ball's volume", async () => {
    const r = await convert(turned(arc(0, 10, -Math.PI / 2, Math.PI / 2, 32)));
    expect(r.counts).toEqual({ plane: 0, cylinder: 0, cone: 0, sphere: 1, facet: 0 });
    expect(r.kinds).toEqual(["sphere"]);
    expect(Math.abs(r.volume - r.meshVolume) / r.meshVolume).toBeLessThan(0.01);
    // The mesh is inscribed in the sphere, the converted solid is the sphere itself.
    expect(r.volume / ((4 / 3) * Math.PI * 1000)).toBeCloseTo(1, 2);
  });

  it("makes a capsule a cylinder between two half spheres that share its circles", async () => {
    const r = await convert(turned([...arc(0, 5, -Math.PI / 2, 0, 16), ...arc(20, 5, 0, Math.PI / 2, 16)]));
    expect(r.counts).toEqual({ plane: 0, cylinder: 1, cone: 0, sphere: 2, facet: 0 });
    expect(r.kinds.sort()).toEqual(["cylinder", "sphere", "sphere"]);
    expect(r.volume / ((4 / 3) * Math.PI * 125 + Math.PI * 25 * 20)).toBeCloseTo(1, 2);
  });

  it("parts two spheres grown together on the circle where they meet", async () => {
    // Ø20 at z = 0 and Ø14 at z = 14: they meet at z = 7.25.
    const [r1, r2, h] = [10, 7, 14];
    const zc = (h * h + r1 * r1 - r2 * r2) / (2 * h);
    const a1 = Math.asin(zc / r1);
    const a2 = Math.asin((zc - h) / r2);
    const r = await convert(turned([...arc(0, r1, -Math.PI / 2, a1, 24), ...arc(h, r2, a2, Math.PI / 2, 24).slice(1)]));
    expect(r.counts).toEqual({ plane: 0, cylinder: 0, cone: 0, sphere: 2, facet: 0 });
    // Two caps: V = πh²(3r − h)/3 for each, with cap heights r1 + zc and r2 + (h − zc).
    const cap = (rad: number, hh: number) => (Math.PI * hh * hh * (3 * rad - hh)) / 3;
    expect(r.volume / (cap(r1, r1 + zc) + cap(r2, r2 + h - zc))).toBeCloseTo(1, 2);
  });

  it("tells the two cones of a double frustum apart", async () => {
    // Ø12 flat ends at z = ±8, Ø20 at z = 0: two frustums, 8 high, V = πh(R² + Rr + r²)/3 each.
    const r = await convert(turned([[0, -8], [6, -8], [10, 0], [6, 8], [0, 8]]));
    expect(r.counts).toEqual({ plane: 2, cylinder: 0, cone: 2, sphere: 0, facet: 0 });
    expect(new Set(r.regions).size).toBe(4);
    expect(r.volume / ((2 * Math.PI * 8 * (100 + 60 + 36)) / 3)).toBeCloseTo(1, 2);
  });

  // A cone that ends in a point, meshed as a fan from the tip to the rim the way CAD programs write
  // it, has all its vertices on a sphere too. Until Nov 2026 the tip vertex pulled the cone's
  // angle off and the sphere won; the volume check then refused the step.
  it("makes a pointed double cone two cones, not spheres", async () => {
    const r = await convert(turned([[0, -10], [10, 0], [0, 10]]));
    expect(r.counts).toEqual({ plane: 0, cylinder: 0, cone: 2, sphere: 0, facet: 0 });
    expect(r.volume / ((2 * Math.PI * 100 * 10) / 3)).toBeCloseTo(1, 2);
  });

  it("names each of two flat faces in the same plane after its own region", async () => {
    // A Ø20 × 5 disc with a groove 2 mm wide and 2 mm deep at r = 6…8: the top is a disc and a
    // ring in the same plane.
    const profile: P[] = [[0, 0], [10, 0], [10, 5], [8, 5], [8, 3], [6, 3], [6, 5], [0, 5]];
    const r = await convert(turned(profile, 96));
    expect(r.counts).toEqual({ plane: 4, cylinder: 3, cone: 0, sphere: 0, facet: 0 });
    expect(r.regions.every((i) => i >= 0)).toBe(true);
    // Every face from its own region, the two top faces too.
    expect(new Set(r.regions).size).toBe(r.regions.length);
    expect(r.volume / (Math.PI * 100 * 5 - Math.PI * (64 - 36) * 2)).toBeCloseTo(1, 2);
  });

  it("bounds the flat faces of a slot-shaped plate with half circles", async () => {
    // 40 between the centres, R 6, 4 thick: V = (40 · 12 + π · 36) · 4.
    const half = (cx: number, from: number): P[] => Array.from({ length: 33 }, (_, i) => [cx + 6 * Math.cos(from + (Math.PI * i) / 32), 6 * Math.sin(from + (Math.PI * i) / 32)] as P);
    const r = await convert(prism([...half(40, -Math.PI / 2), ...half(0, Math.PI / 2)], 4));
    expect(r.counts).toEqual({ plane: 4, cylinder: 2, cone: 0, sphere: 0, facet: 0 });
    expect(new Set(r.regions).size).toBe(6);
    expect(r.volume / ((40 * 12 + Math.PI * 36) * 4)).toBeCloseTo(1, 2);
  });

  it("reads a mesh wound inside out the same", async () => {
    const r = await convert(insideOut(turned([...arc(0, 5, -Math.PI / 2, 0, 16), ...arc(20, 5, 0, Math.PI / 2, 16)])));
    expect(r.counts).toEqual({ plane: 0, cylinder: 1, cone: 0, sphere: 2, facet: 0 });
    expect(r.volume / ((4 / 3) * Math.PI * 125 + Math.PI * 25 * 20)).toBeCloseTo(1, 2);
  });

  it("refuses a part that is mostly freeform", async () => {
    // A rough ball: every vertex off the sphere by up to 0.5 mm, measured at 0.01 mm.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
    const n = 64;
    const rough: P[] = arc(0, 10, -Math.PI / 2, Math.PI / 2, n).map(([x, z], i) => (i === 0 || i === n ? [0, z] : [x + rnd(), z + rnd()]));
    const mesh = turned(rough, 128);
    // Each ring is jagged too.
    for (let i = 0; i < mesh.length; i += 3) {
      const k = 1 + rnd() * 0.05;
      mesh[i] = mesh[i]! * k;
      mesh[i + 1] = mesh[i + 1]! * k;
    }
    await expect(convert(mesh, 0.01)).rejects.toThrow(/mostly freeform: \d+ faces, \d+% of the surface matches no plane/);
    expect(MAX_FACETS).toBe(1500);
  });

  it("refuses a solid whose true surfaces hold more than 1 % beyond its coarse mesh", async () => {
    // A cylinder meshed with 24 sides: the true cylinder holds 1.1 % more than the 24-gon prism
    // (24·sin(15°)/(2π) = 0.9886), so it is refused instead of coming back quietly bigger.
    await expect(convert(turned([[0, 0], [10, 0], [10, 10], [0, 10]], 24))).rejects.toThrow(/differs from the mesh .* by more than 1%/);
  });
});
