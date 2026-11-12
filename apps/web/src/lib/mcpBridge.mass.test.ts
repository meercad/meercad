/**
 * Mass, centre of gravity and moments of inertia an assistant gets for a design (mcpBridge.ts
 * summary) with the real kernel: a 40 × 20 × 10 block of PLA (1.24 g/cm³) weighs 9.92 g, its centre
 * is at (20, 10, 5), and about it Ixx = m(20² + 10²)/12, Iyy = m(40² + 10²)/12, Izz = m(40² + 20²)/12
 * with no products of inertia. A second block of the same PLA beside it moves the centre half way.
 * A part without a material is counted, not weighed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Feature, SketchEntity } from "@meercad/schema";
import { testCall } from "./mcpBridge";

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) => testCall(method, params) as Promise<T>;
const rect = (p: string, x: number, y: number, w: number, h: number): SketchEntity[] => [
  { id: `${p}1`, type: "point", x, y },
  { id: `${p}2`, type: "point", x: x + w, y },
  { id: `${p}3`, type: "point", x: x + w, y: y + h },
  { id: `${p}4`, type: "point", x, y: y + h },
  { id: `${p}a`, type: "line", p1: `${p}1`, p2: `${p}2` },
  { id: `${p}b`, type: "line", p1: `${p}2`, p2: `${p}3` },
  { id: `${p}c`, type: "line", p1: `${p}3`, p2: `${p}4` },
  { id: `${p}d`, type: "line", p1: `${p}4`, p2: `${p}1` },
];
const block = (id: string, x: number): Feature[] => [
  { id: `s${id}`, op: "sketch", plane: { ref: "origin.XY" }, entities: rect("r", x, 0, 40, 20), constraints: [] },
  { id, op: "extrude", profile: { sketch: `s${id}` }, extent: "blind", distance: 10, mode: "new_body" },
];
type Model = { rebuild: { mass?: { grams: number; centreOfGravity: number[]; inertiaGmm2?: Record<string, number | string>; partsWithoutMaterial: number } } };
const m = 9.92;

beforeAll(async () => {
  await call("new_project", { name: "Mass" });
  await call("apply_ops", { ops: [{ type: "add_features", features: [...block("b1", 0), ...block("b2", 100)] }, { type: "set_material", part: "b1", material: "pla" }] });
});

describe("mass properties for an assistant", () => {
  it("weighs a PLA block, finds its centre and its moments of inertia", async () => {
    const r = await call<Model>("get_model");
    const mass = r.rebuild.mass!;
    expect(mass.grams).toBeCloseTo(m, 2);
    mass.centreOfGravity.forEach((v, i) => expect(v).toBeCloseTo([20, 10, 5][i]!, 3));
    const I = mass.inertiaGmm2!;
    expect(I["Ixx"]).toBeCloseTo((m * (20 ** 2 + 10 ** 2)) / 12, 1);
    expect(I["Iyy"]).toBeCloseTo((m * (40 ** 2 + 10 ** 2)) / 12, 1);
    expect(I["Izz"]).toBeCloseTo((m * (40 ** 2 + 20 ** 2)) / 12, 1);
    expect(Math.abs(Number(I["Ixy"]))).toBeLessThan(0.01);
    // The second block has no material: counted, not weighed.
    expect(mass.partsWithoutMaterial).toBe(1);
  });

  it("moves the centre half way when the second block is PLA too", async () => {
    await call("apply_ops", { ops: [{ type: "set_material", part: "b2", material: "pla" }] });
    const mass = (await call<Model>("get_model")).rebuild.mass!;
    expect(mass.grams).toBeCloseTo(2 * m, 2);
    mass.centreOfGravity.forEach((v, i) => expect(v).toBeCloseTo([70, 10, 5][i]!, 3));
    // About the common centre: Izz gains m·d² for each block 50 mm away.
    expect(Number(mass.inertiaGmm2!["Izz"])).toBeCloseTo(2 * ((m * (40 ** 2 + 20 ** 2)) / 12 + m * 50 ** 2), 0);
    expect(mass.partsWithoutMaterial).toBe(0);
  });
});
