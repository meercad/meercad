/**
 * What an assistant's MCP request does in the app (mcpBridge.ts, mcpTools.ts) with the real
 * kernel: every answer that carries a number (volumes, areas, distances, overlaps, walls,
 * overhangs, exported meshes) is checked against the drawn parts.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { parseStl, read3mf } from "@meercad/io";
import type { Feature, SketchEntity } from "@meercad/schema";
import { testCall } from "./mcpBridge";

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
const block = (id: string, x: number, y: number, w: number, d: number, h: number, z = 0): Feature[] => [
  {
    id: `s_${id}`,
    op: "sketch",
    plane: z ? { ref: `pl_${id}` } : { ref: "origin.XY" },
    entities: rect(id, x, y, w, d),
    constraints: [],
  },
  {
    id,
    op: "extrude",
    profile: { sketch: `s_${id}` },
    extent: "blind",
    distance: h,
    mode: z ? "join" : "new_body",
  },
];
/**
 * plate 40 × 20 × 10; a and b, 10 mm cubes overlapping by 5 mm; wall 30 × 2 × 20; post, a T: a
 * 10 mm post with a 30 × 10 × 2 bar joined on top.
 */
const design: Feature[] = [
  ...block("plate", 0, 0, 40, 20, 10),
  ...block("a", 60, 0, 10, 10, 10),
  ...block("b", 65, 0, 10, 10, 10),
  ...block("wall", 100, 0, 30, 2, 20),
  ...block("post", 160, 0, 10, 10, 10),
  { id: "pl_bar", op: "plane", base: { ref: "origin.XY" }, offset: 10 },
  ...block("bar", 150, 0, 30, 10, 2, 10),
];

const call = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}) =>
  testCall(method, params) as Promise<T>;
const b64bytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Volume enclosed by a triangle mesh (divergence theorem). */
function meshVolume(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let v = 0;

  for (let t = 0; t < indices.length; t += 3) {
    const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!].map((i) => [
      positions[i * 3]!,
      positions[i * 3 + 1]!,
      positions[i * 3 + 2]!,
    ]);
    v +=
      a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) -
      a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) +
      a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!);
  }

  return v / 6;
}

beforeAll(async () => {
  await expect(call("get_model")).rejects.toThrow(/No project is open/);
  await call("new_project", { name: "Bridge" });

  const r = await call<{ features: { id: string; status: string }[]; bodies: { id: string }[] }>(
    "apply_ops",
    { ops: [{ type: "add_features", features: design }] },
  );
  // The brief answer names the steps it added, all built, and the six new parts.
  expect(r.features.map((f) => f.status)).toEqual(design.map(() => "ok"));
  expect(r.bodies.map((b) => b.id)).toEqual(["plate", "a", "b", "wall", "post"]);
});

describe("an assistant's requests in the app", () => {
  it("reports every part's volume, box and mass", async () => {
    await call("apply_ops", { ops: [{ type: "set_material", part: "plate", material: "pla" }] });

    const m = await call<{
      rebuild: {
        bodies: { id: string; volume: number; bbox: { min: number[]; max: number[] }; massGrams?: number }[];
        mass?: { grams: number };
      };
    }>("get_model");
    const v = Object.fromEntries(m.rebuild.bodies.map((b) => [b.id, b.volume]));
    expect(v).toEqual({ plate: 8000, a: 1000, b: 1000, wall: 1200, post: 1600 });

    const plate = m.rebuild.bodies.find((b) => b.id === "plate")!;
    expect(plate.bbox).toEqual({ min: [0, 0, 0], max: [40, 20, 10] });
    // PLA 1.24 g/cm³: 8 cm³ → 9.92 g.
    expect(plate.massGrams).toBeCloseTo(9.92, 2);
    expect(m.rebuild.bodies.find((b) => b.id === "post")!.bbox).toEqual({
      min: [150, 0, 0],
      max: [180, 10, 12],
    });
  });

  it("measures a face, an edge and the distance between two faces", async () => {
    const top = await call<{ rows: [string, string][] }>("measure", { a: { face: "plate.end_cap" } });
    expect(top.rows.find((r) => r[0] === "Area")![1]).toMatch(/^800(\.0+)? mm²/);

    const between = await call<{ rows: [string, string][] }>("measure", {
      a: { face: "plate.end_cap" },
      b: { face: "plate.start_cap" },
    });
    expect(between.rows.find((r) => r[0] === "Distance")![1]).toMatch(/^10(\.0+)? mm/);

    const edge = await call<{ rows: [string, string][] }>("measure", {
      a: { edge: ["plate.end_cap", "plate.side[s_plate.platea]"] },
    });
    expect(edge.rows.find((r) => r[0] === "Length")![1]).toMatch(/^40(\.0+)? mm/);
  });

  it("finds the parts that overlap and by how much", async () => {
    const r = await call<{ overlaps: { a: string; b: string; overlapMm3: number }[]; touching: string[][] }>(
      "check_interference",
      {},
    );
    expect(r.overlaps.map((o) => [o.a, o.b, o.overlapMm3])).toEqual([["a", "b", 500]]);
    expect(r.touching).toEqual([]);

    const only = await call<{ overlaps: unknown[] }>("check_interference", { parts: ["plate"], seconds: 30 });
    expect(only.overlaps).toEqual([]);
  });

  it("measures walls and overhangs", async () => {
    // The two big faces of the 30 × 2 × 20 wall (1200 of its 1400 mm²) are 2 mm apart.
    const w = await call<{ thinnestMm: number; shareThinnerThanMinWall: number }>("wall_thickness", {
      part: "wall",
      minWall: 3,
      show: false,
    });
    expect(w.thinnestMm).toBeCloseTo(2, 3);
    expect(w.shareThinnerThanMinWall).toBeCloseTo(1200 / 1400, 3);

    const thick = await call<{ thinnestMm: number; shareThinnerThanMinWall: number }>("wall_thickness", {
      part: "wall",
      minWall: 1,
      show: false,
      quality: "fast",
    });
    expect(thick.shareThinnerThanMinWall).toBe(0);

    // The T's bar hangs over the post on 300 − 100 mm², flat.
    const p = await call<{ overhangMm2: number; onBedMm2: number; heightMm: number }>("print_check", {
      part: "post",
      show: false,
    });
    expect(p.overhangMm2).toBeCloseTo(200, 0);
    expect(p.onBedMm2).toBeCloseTo(100, 0);
    expect(p.heightMm).toBeCloseTo(12, 6);

    // Upside down the bar lies on the bed and nothing hangs over.
    const flipped = await call<{ overhangMm2: number; onBedMm2: number }>("print_check", {
      part: "post",
      show: false,
      down: [0, 0, 1],
    });
    expect(flipped.overhangMm2).toBeCloseTo(0, 0);
    expect(flipped.onBedMm2).toBeCloseTo(300, 0);
  });

  it("exports meshes and a STEP file of the drawn size", async () => {
    const stl = await call<{ files: Record<string, string> }>("export", {
      format: "stl",
      parts: ["plate"],
      name: "plate",
    });
    const mesh = parseStl(b64bytes(stl.files["plate.stl"]!));
    expect(meshVolume(mesh.positions, mesh.indices)).toBeCloseTo(8000, 3);

    const three = await call<{ files: Record<string, string> }>("export", {
      format: "3mf",
      parts: ["a", "b"],
      name: "two",
    });
    const parts = read3mf(b64bytes(three.files["two.3mf"]!));
    expect(parts.map((m) => Math.round(meshVolume(m.positions, m.indices)))).toEqual([1000, 1000]);

    const step = await call<{ files: Record<string, string> }>("export", {
      format: "step",
      parts: ["plate"],
      name: "plate",
    });
    expect(new TextDecoder().decode(b64bytes(step.files["plate.step"]!).slice(0, 9))).toBe("ISO-10303");

    const saved = await call<{ files: Record<string, string> }>("export", { format: "meercad" });
    expect(
      JSON.parse(new TextDecoder().decode(b64bytes(saved.files["model.meercad"]!))).features.length,
    ).toBe(design.length);
  });
});
