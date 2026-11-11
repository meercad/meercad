/**
 * Known answers: parts whose volume, size, mass and exported files can be worked out by hand, built
 * through the same kernel path the app uses, and checked against those numbers. A wrong result here
 * means a person would get a part of the wrong size or weight.
 */
import { describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { exportMeshes, exportStep, measure, type RebuildReport } from "@meercad/kernel";
import { meshVolume, read3mf, readStl, write3mf, writeStl } from "@meercad/io";
import { massProperties, materialById } from "@meercad/model";
import type { Feature, MeercadDocument } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const PI = Math.PI;
const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.status} ${f.message}`)).toEqual([]);
const rel = (got: number, want: number, tol: number) => expect(Math.abs(got - want) / Math.abs(want), `${got} vs ${want}`).toBeLessThan(tol);
const bbox = (r: RebuildReport, i = 0) => r.bodies[i]!.bbox;
const near = (got: number[], want: number[], digits = 6) => got.forEach((v, i) => expect(v, `axis ${i}`).toBeCloseTo(want[i]!, digits));

/** A W × D × H block from the origin, built from a sketch the way a person draws it. */
const block = (w: number, d: number, h: number, id = "ex1", sk = "sk1", x = 0, y = 0): Feature[] => [
  sketch(sk, { ref: "origin.XY" }, rect(`${sk}l`, x, y, w, d)),
  { id, op: "extrude", profile: { sketch: sk }, extent: "blind", distance: h, mode: "new_body" },
];

/** Mounting plate 80 × 50 × 5 with four Ø 6 holes 8 mm in from the corners, driven by variables. */
const plate = (): MeercadDocument => ({
  format: "meercad/1",
  params: { width: "80 mm", depth: "50 mm", thickness: "5 mm", hole: "6 mm", inset: "8 mm" },
  rollback: null,
  features: [
    {
      id: "sk1",
      op: "sketch",
      plane: { ref: "origin.XY" },
      entities: [
        ...rect("l", 1, -1, 70, 45),
        ...[0, 1, 2, 3].flatMap((k) => circle(`h${k}`, k % 2 ? 70 : 10, k < 2 ? 10 : 40, 2)),
      ],
      constraints: [
        { id: "o", type: "coincident", a: "lp1", b: "origin" },
        { id: "c1", type: "horizontal", line: "l1" },
        { id: "c2", type: "horizontal", line: "l3" },
        { id: "c3", type: "vertical", line: "l2" },
        { id: "c4", type: "vertical", line: "l4" },
        { id: "w", type: "length", line: "l1", value: "width" },
        { id: "d", type: "length", line: "l2", value: "depth" },
        ...[0, 1, 2, 3].flatMap((k) => [
          { id: `hd${k}`, type: "diameter" as const, curve: `h${k}`, value: "hole" },
          { id: `hx${k}`, type: "distance" as const, a: k % 2 ? "lp2" : "lp1", b: `h${k}c`, value: "inset", axis: "x" as const },
          { id: `hy${k}`, type: "distance" as const, a: k < 2 ? "lp1" : "lp4", b: `h${k}c`, value: "inset", axis: "y" as const },
        ]),
      ],
    },
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "thickness", mode: "new_body" },
  ],
});
const plateVolume = (w: number, d: number, t: number, hole: number) => w * d * t - 4 * PI * (hole / 2) ** 2 * t;

describe("dimensions and variables drive the exact size", () => {
  it("a fully dimensioned plate has the drawn size and volume", async () => {
    const { report } = (await newSession()).rebuild(plate());
    ok(report);
    near(bbox(report).min, [0, 0, 0]);
    near(bbox(report).max, [80, 50, 5]);
    expect(report.bodies[0]!.volume).toBeCloseTo(plateVolume(80, 50, 5, 6), 4);
  });

  it("changing variables changes the part by exactly that amount", async () => {
    const s = await newSession();
    for (const [w, d, t, h] of [
      [100, 60, 3, 4],
      [120.5, 33.3, 7.25, 8.4],
      [40, 30, 2, 3],
    ] as const) {
      const d0 = plate();
      const { report } = s.rebuild({ ...d0, params: { ...d0.params, width: `${w} mm`, depth: `${d} mm`, thickness: `${t} mm`, hole: `${h} mm` } });
      ok(report);
      near(bbox(report).max, [w, d, t], 5);
      expect(report.bodies[0]!.volume).toBeCloseTo(plateVolume(w, d, t, h), 3);
    }
  });

  it("inch values give inch-sized parts in mm", async () => {
    const d0 = plate();
    const { report } = (await newSession()).rebuild({ ...d0, params: { ...d0.params, width: "3 in", depth: "2 in", thickness: "0.25 in", hole: "0.25 in", inset: "0.375 in" } });
    ok(report);
    near(bbox(report).max, [76.2, 50.8, 6.35], 5);
    expect(report.bodies[0]!.volume).toBeCloseTo(plateVolume(76.2, 50.8, 6.35, 6.35), 3);
  });

  it("formulas in dimensions: a centred hole stays centred at any size", async () => {
    const s = await newSession();
    for (const w of [40, 66]) {
      const f: Feature[] = [
        sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 30, 30), ...circle("c", 12, 14, 3)], [
          { id: "o", type: "coincident", a: "lp1", b: "origin" },
          { id: "h1", type: "horizontal", line: "l1" },
          { id: "h3", type: "horizontal", line: "l3" },
          { id: "v2", type: "vertical", line: "l2" },
          { id: "v4", type: "vertical", line: "l4" },
          { id: "w", type: "length", line: "l1", value: "w" },
          { id: "d", type: "length", line: "l2", value: "w / 2" },
          { id: "cx", type: "distance", a: "lp1", b: "cc", value: "w / 2", axis: "x" },
          { id: "cy", type: "distance", a: "lp1", b: "cc", value: "w / 4", axis: "y" },
          { id: "cd", type: "diameter", curve: "c", value: "w / 5" },
        ]),
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 4, mode: "new_body" },
      ];
      const { report } = s.rebuild(doc(f, { w: `${w} mm` }));
      ok(report);
      expect(report.bodies[0]!.volume).toBeCloseTo((w * (w / 2) - PI * (w / 10) ** 2) * 4, 4);
      const sk = report.sketches.find((x) => x.id === "sk1")!;
      const c = sk.curves.find((x) => x.id === "c")!;
      expect(c.kind === "circle" && c.center[0]).toBeCloseTo(w / 2, 6);
      expect(c.kind === "circle" && c.center[1]).toBeCloseTo(w / 4, 6);
    }
  });
});

describe("booleans by the numbers", () => {
  // Two 20 mm cubes overlapping by 10 mm in x: union 12 000, difference 4 000, intersection 4 000.
  const two = [...block(20, 20, 20, "a", "ska"), ...block(20, 20, 20, "b", "skb", 10, 0)];
  it.each([
    ["union", 12000, [0, 0, 0], [30, 20, 20]],
    ["subtract", 4000, [0, 0, 0], [10, 20, 20]],
    ["intersect", 4000, [10, 0, 0], [20, 20, 20]],
  ] as const)("%s of two overlapping cubes", async (operation, volume, min, max) => {
    const { report } = (await newSession()).rebuild(doc([...two, { id: "bo1", op: "boolean", operation, target: "a", tools: ["b"] }]));
    ok(report);
    expect(report.bodies).toHaveLength(1);
    expect(report.bodies[0]!.volume).toBeCloseTo(volume, 6);
    near(bbox(report).min, [...min]);
    near(bbox(report).max, [...max]);
    expect(report.bodies[0]!.faces).toBe(6);
  });

  it("subtracting a cylinder through a block leaves the exact hole", async () => {
    const f: Feature[] = [
      ...block(30, 30, 10),
      sketch("sk2", { ref: "origin.XY" }, circle("c", 15, 15, 5)),
      { id: "cyl", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 40, mode: "new_body" },
      { id: "bo1", op: "boolean", operation: "subtract", target: "ex1", tools: ["cyl"] },
    ];
    const { report } = (await newSession()).rebuild(doc(f));
    ok(report);
    expect(report.bodies).toHaveLength(1);
    expect(report.bodies[0]!.volume).toBeCloseTo(9000 - PI * 25 * 10, 4);
  });

  it("extrude modes cut, join and intersect give the same numbers as booleans", async () => {
    const s = await newSession();
    const base = block(20, 20, 20);
    const tool = sketch("sk2", { ref: "origin.XY" }, rect("m", 10, 0, 20, 20));
    for (const [mode, volume] of [
      ["join", 12000],
      ["cut", 4000],
      ["intersect", 4000],
    ] as const) {
      const { report } = s.rebuild(doc([...base, tool, { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 20, mode }]));
      ok(report);
      expect(report.bodies[0]!.volume, mode).toBeCloseTo(volume, 6);
    }
  });
});

describe("rounds and bevels by the numbers", () => {
  const box = block(40, 30, 20);
  it("a fillet on one edge removes exactly r²(1 − π/4) per mm of edge", async () => {
    for (const r of [1, 2.5, 5]) {
      const { report } = (await newSession()).rebuild(doc([...box, { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.sk1l1]", "ex1.side[sk1.sk1l2]"] }], radius: r }]));
      ok(report);
      // The vertical edge between the front and right faces is 20 mm long.
      expect(report.bodies[0]!.volume, `r ${r}`).toBeCloseTo(24000 - 20 * r * r * (1 - PI / 4), 4);
    }
  });

  it("a chamfer on one edge removes exactly d²/2 per mm of edge", async () => {
    for (const d of [1, 3]) {
      const { report } = (await newSession()).rebuild(doc([...box, { id: "ch1", op: "chamfer", edges: [{ edge: ["ex1.side[sk1.sk1l1]", "ex1.side[sk1.sk1l2]"] }], distance: d }]));
      ok(report);
      expect(report.bodies[0]!.volume, `d ${d}`).toBeCloseTo(24000 - 20 * (d * d) / 2, 4);
    }
  });

  it("filleting the four top edges of a block", async () => {
    const r = 2;
    const { report } = (await newSession()).rebuild(doc([...box, { id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1", where: { face: "end_cap" } }, radius: r }]));
    ok(report);
    // Each fillet removes r²(1 − π/4) per mm over the full edge; at the four corners (vertical
    // edges left sharp) the two fillets meet in a mitre and their removed parts overlap by
    // ∫₀ʳ (r − √(r² − s²))² ds = r³(5/3 − π/2).
    const want = 24000 - r * r * (1 - PI / 4) * (2 * 40 + 2 * 30) + 4 * r ** 3 * (5 / 3 - PI / 2);
    expect(report.bodies[0]!.volume).toBeCloseTo(want, 3);
  });

  it("a shell of 2 mm leaves the walls and floor", async () => {
    const { report } = (await newSession()).rebuild(doc([...box, { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 }]));
    ok(report);
    expect(report.bodies[0]!.volume).toBeCloseTo(24000 - 36 * 26 * 18, 4);
  });
});

describe("turned and patterned parts", () => {
  it("a 90° revolve is a quarter of the full one", async () => {
    const prof = sketch("sk1", { ref: "origin.XZ" }, [...rect("l", 10, 0, 5, 20), { id: "a1", type: "point", x: 0, y: 0 }, { id: "a2", type: "point", x: 0, y: 1 }, { id: "ax", type: "line", p1: "a1", p2: "a2", construction: true }]);
    const s = await newSession();
    const full = s.rebuild(doc([prof, { id: "rv1", op: "revolve", profile: { sketch: "sk1" }, axis: { line: "sk1.ax" }, angle: 360, mode: "new_body" }])).report;
    ok(full);
    expect(full.bodies[0]!.volume).toBeCloseTo(PI * (225 - 100) * 20, 3);
    const quarter = s.rebuild(doc([prof, { id: "rv1", op: "revolve", profile: { sketch: "sk1" }, axis: { line: "sk1.ax" }, angle: 90, mode: "new_body" }])).report;
    ok(quarter);
    expect(quarter.bodies[0]!.volume).toBeCloseTo((PI * (225 - 100) * 20) / 4, 3);
  });

  it("a circular pattern of 8 holes on a 60 mm circle: count, volume and positions", async () => {
    const f: Feature[] = [
      sketch("sk1", { ref: "origin.XY" }, circle("c0", 0, 0, 40)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 6, mode: "new_body" },
      sketch("sk2", { ref: "origin.XY" }, circle("c1", 30, 0, 3)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut" },
      { id: "cp1", op: "circular_pattern", source: { features: ["ex2"] }, axis: { ref: "origin.Z" }, count: 8 },
    ];
    const s = await newSession();
    const { report } = s.rebuild(doc(f));
    ok(report);
    expect(report.bodies[0]!.volume).toBeCloseTo((PI * 1600 - 8 * PI * 9) * 6, 3);
    // The disc's centre of volume stays on the axis when the holes are evenly spread.
    near(report.bodies[0]!.centroid!.slice(0, 2), [0, 0], 6);
  });

  it("a mirrored part is the same size on the other side", async () => {
    const { report } = (await newSession()).rebuild(doc([...block(15, 10, 5, "ex1", "sk1", 5, 0), { id: "mi1", op: "mirror", source: { bodies: ["ex1"] }, plane: { ref: "origin.YZ" } }]));
    ok(report);
    expect(report.bodies).toHaveLength(2);
    const m = report.bodies.find((b) => b.id !== "ex1")!;
    expect(m.volume).toBeCloseTo(750, 6);
    near(m.bbox.min, [-20, 0, 0]);
    near(m.bbox.max, [-5, 10, 5]);
  });
});

describe("measuring gives the drawn distances", () => {
  it("face to face, and a hole's diameter", async () => {
    const s = await newSession();
    const { meshes } = s.rebuild(plate());
    const tags = meshes[0]!.faceTags;
    const oc = await getOcct();
    const idx = (t: string) => tags.findIndex((x) => x.includes(t));
    const thick = measure(oc, s.state!, { bodyId: "ex1", kind: "face", index: idx("ex1.end_cap") }, { bodyId: "ex1", kind: "face", index: idx("ex1.start_cap") });
    expect(thick.rows[0]).toEqual(["Distance", "5 mm"]);
    const across = measure(oc, s.state!, { bodyId: "ex1", kind: "face", index: idx("ex1.side[sk1.l2]") }, { bodyId: "ex1", kind: "face", index: idx("ex1.side[sk1.l4]") });
    expect(across.rows[0]).toEqual(["Distance", "80 mm"]);
    const hole = measure(oc, s.state!, { bodyId: "ex1", kind: "face", index: idx("ex1.side[sk1.h0]") });
    expect(hole.rows.map((r) => r.join(" ")).join("; ")).toMatch(/(Ø|Diameter) 6 mm|Radius 3 mm/);
  });
});

describe("mass from volume and material", () => {
  it("a 100 × 50 × 10 steel block weighs 392.5 g, the PLA one 62 g", async () => {
    const { report } = (await newSession()).rebuild(doc(block(100, 50, 10)));
    ok(report);
    const b = report.bodies[0]!;
    for (const [mat, grams] of [
      ["steel", 392.5],
      ["pla", 62],
    ] as const) {
      const m = massProperties([{ volume: b.volume, centroid: b.centroid!, material: materialById(mat)! }]);
      expect(m.mass, mat).toBeCloseTo(grams, 6);
      near(m.center!, [50, 25, 5], 6);
    }
  });
});

describe("exported files have the size and volume of the model", () => {
  /** Edges used by exactly two triangles, in opposite directions: a closed, printable surface. */
  function watertight(v: Float32Array): boolean {
    const key = (i: number) => `${v[i]!.toFixed(4)},${v[i + 1]!.toFixed(4)},${v[i + 2]!.toFixed(4)}`;
    const edges = new Map<string, number>();
    for (let t = 0; t < v.length; t += 9) {
      const k = [key(t), key(t + 3), key(t + 6)];
      for (let e = 0; e < 3; e++) {
        const a = k[e]!, b = k[(e + 1) % 3]!;
        edges.set(`${a}|${b}`, (edges.get(`${a}|${b}`) ?? 0) + 1);
      }
    }
    for (const [e, n] of edges) {
      const [a, b] = e.split("|");
      if (n !== 1 || edges.get(`${b}|${a}`) !== 1) return false;
    }
    return true;
  }
  const extent = (v: Float32Array) => {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i += 3) for (let k = 0; k < 3; k++) (min[k] = Math.min(min[k]!, v[i + k]!)), (max[k] = Math.max(max[k]!, v[i + k]!));
    return { min, max };
  };
  /** The flat triangle list of indexed meshes. */
  const soup = (m: { positions: Float32Array; indices: Uint32Array }) => {
    const out = new Float32Array(m.indices.length * 3);
    m.indices.forEach((ix, i) => out.set(m.positions.subarray(ix * 3, ix * 3 + 3), i * 3));
    return out;
  };

  it("STL: mm, the exact size, volume within the tessellation, closed", async () => {
    const s = await newSession();
    const { report } = s.rebuild(plate());
    ok(report);
    const stl = readStl(writeStl(exportMeshes(await getOcct(), s.state!)));
    const e = extent(stl.vertices);
    near(e.min, [0, 0, 0], 4);
    near(e.max, [80, 50, 5], 4);
    // Chords of the Ø 6 holes sag inward by ≤ 0.01 mm: the mesh volume is within 0.05 %.
    rel(meshVolume(stl.vertices), plateVolume(80, 50, 5, 6), 5e-4);
    expect(watertight(stl.vertices)).toBe(true);
  });

  it("3MF: millimetres, one object per part, each with its own volume", async () => {
    const s = await newSession();
    const { report } = s.rebuild(doc([...block(20, 10, 5, "a", "ska"), ...block(10, 10, 10, "b", "skb", 40, 0)]));
    ok(report);
    const meshes = exportMeshes(await getOcct(), s.state!);
    const file = write3mf(meshes.map((m) => ({ ...m, name: m.bodyId })));
    expect(strFromU8(unzipSync(file)["3D/3dmodel.model"]!)).toContain('unit="millimeter"');
    const back = read3mf(file);
    expect(back.map((m) => m.name).sort()).toEqual(["a", "b"]);
    const vol = Object.fromEntries(back.map((m) => [m.name, meshVolume(soup(m))]));
    expect(vol["a"]).toBeCloseTo(1000, 3);
    expect(vol["b"]).toBeCloseTo(1000, 3);
    const eb = extent(soup(back.find((m) => m.name === "b")!));
    near(eb.min, [40, 0, 0], 4);
    near(eb.max, [50, 10, 10], 4);
    for (const m of back) expect(watertight(soup(m)), m.name).toBe(true);
  });

  it("STEP: reads back as the same solids, size and volume", async () => {
    const s = await newSession();
    s.rebuild(doc([...block(20, 10, 5, "a", "ska"), ...block(10, 10, 10, "b", "skb", 40, 0)]));
    const step = exportStep(await getOcct(), s.state!);
    const text = new TextDecoder().decode(step);
    expect(text).toMatch(/SI_UNIT\(\s*\.MILLI\.\s*,\s*\.METRE\.\s*\)/);
    let b64 = "";
    for (let i = 0; i < step.length; i += 0x8000) b64 += String.fromCharCode(...step.subarray(i, i + 0x8000));
    const { report } = (await newSession()).rebuild(doc([{ id: "im1", op: "import", format: "step", fileName: "x.step", data: btoa(b64) }]));
    ok(report);
    // Two solids go out; an import brings the file in as one part holding both.
    expect(text.match(/MANIFOLD_SOLID_BREP/g)).toHaveLength(2);
    expect(report.bodies.reduce((a, b) => a + b.volume, 0)).toBeCloseTo(2000, 4);
    const total = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const b of report.bodies) for (let k = 0; k < 3; k++) (total.min[k] = Math.min(total.min[k]!, b.bbox.min[k]!)), (total.max[k] = Math.max(total.max[k]!, b.bbox.max[k]!));
    near(total.min, [0, 0, 0], 4);
    near(total.max, [50, 10, 10], 4);
  });

  it("STEP of the variable-driven plate keeps the exact holes (no tessellation)", async () => {
    const s = await newSession();
    s.rebuild(plate());
    const step = exportStep(await getOcct(), s.state!);
    let b64 = "";
    for (let i = 0; i < step.length; i += 0x8000) b64 += String.fromCharCode(...step.subarray(i, i + 0x8000));
    const { report } = (await newSession()).rebuild(doc([{ id: "im1", op: "import", format: "step", fileName: "p.step", data: btoa(b64) }]));
    ok(report);
    expect(report.bodies[0]!.volume).toBeCloseTo(plateVolume(80, 50, 5, 6), 4);
  });
});
