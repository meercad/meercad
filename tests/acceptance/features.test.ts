import { describe, expect, it } from "vitest";
import { exportStep, measure, type RebuildReport } from "@meercad/kernel";
import type { Feature, SketchEntity } from "@meercad/schema";
import { circle, corpus, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const box: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const vol = (r: RebuildReport, i = 0) => r.bodies[i]!.volume;

describe("sketch profiles", () => {
  it("extrudes a rectangle with a circular hole (even-odd regions)", async () => {
    const { report } = (await newSession()).rebuild(
      doc([sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 40, 20), ...circle("c1", 20, 10, 5)]), { ...box[1]! } as Feature]),
    );
    ok(report);
    expect(vol(report)).toBeCloseTo(8000 - Math.PI * 25 * 10, 3);
  });

  it("extrudes explicit regions symmetric and two-sided", async () => {
    const s = await newSession();
    const sk = sketch("sk1", { ref: "origin.XY" }, [...rect("l", 0, 0, 40, 20), ...circle("c1", 20, 10, 5)]);
    let r = s.rebuild(doc([sk, { id: "ex1", op: "extrude", profile: { sketch: "sk1", regions: ["c1"] }, extent: "symmetric", distance: 10, mode: "new_body" }])).report;
    ok(r);
    expect(vol(r)).toBeCloseTo(Math.PI * 25 * 10, 3);
    expect(r.bodies[0]!.bbox.min[2]).toBeCloseTo(-5, 4);
    r = s.rebuild(doc([sk, { id: "ex1", op: "extrude", profile: { sketch: "sk1", regions: ["c1"] }, extent: "two_sided", distance: 10, distance2: 3, mode: "new_body" }])).report;
    expect(r.bodies[0]!.bbox.min[2]).toBeCloseTo(-3, 4);
    expect(r.bodies[0]!.bbox.max[2]).toBeCloseTo(10, 4);
  });
});

describe("modelling features", () => {
  it("sketches on a face and cuts a through-all hole", async () => {
    const { report, meshes } = (await newSession()).rebuild(
      doc([
        ...box,
        sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, 3)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, flip: true, mode: "cut" },
      ]),
    );
    ok(report);
    expect(vol(report)).toBeCloseTo(8000 - Math.PI * 9 * 10, 3);
    expect(meshes[0]!.faceTags.flat()).toContain("ex2.side[sk2.c1]");
  });

  it("joins a boss and merges coplanar faces", async () => {
    const { report, meshes } = (await newSession()).rebuild(
      doc([
        ...box,
        sketch("sk2", { ref: "origin.XY" }, rect("m", 40, 0, 10, 20)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 10, mode: "join" },
      ]),
    );
    ok(report);
    expect(report.bodies).toHaveLength(1);
    expect(vol(report)).toBeCloseTo(10000, 3);
    expect(report.bodies[0]!.faces).toBe(6); // unified back into a plain box
    const top = meshes[0]!.faceTags.find((t) => t.includes("ex1.end_cap"))!;
    expect(top).toContain("ex2.end_cap");
  });

  it("revolves a profile around a sketch axis", async () => {
    const { report } = (await newSession()).rebuild(
      doc([
        sketch("sk1", { ref: "origin.XZ" }, [...rect("l", 5, 0, 5, 20), { id: "a1", type: "point", x: 0, y: 0 }, { id: "a2", type: "point", x: 0, y: 1 }, { id: "ax", type: "line", p1: "a1", p2: "a2", construction: true }]),
        { id: "rv1", op: "revolve", profile: { sketch: "sk1" }, axis: { line: "sk1.ax" }, angle: 360, mode: "new_body" },
      ]),
    );
    ok(report);
    expect(vol(report)).toBeCloseTo(Math.PI * (100 - 25) * 20, 2);
  });

  it("chamfers and shells", async () => {
    const s = await newSession();
    let r = s.rebuild(doc([...box, { id: "ch1", op: "chamfer", edges: { select: "edges", of: "ex1", where: { face: "end_cap" } }, distance: 1 }])).report;
    ok(r);
    expect(vol(r)).toBeLessThan(8000);
    expect(vol(r)).toBeGreaterThan(8000 - 120 * 0.5 - 1);
    r = s.rebuild(doc([...box, { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 }])).report;
    ok(r);
    expect(vol(r)).toBeCloseTo(8000 - 36 * 16 * 8, 2);
  });

  it("patterns a cut feature linearly and circularly", async () => {
    const s = await newSession();
    const hole: Feature[] = [
      sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 5, 10, 2)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, flip: true, mode: "cut" },
    ];
    let r = s.rebuild(doc([...box, ...hole, { id: "lp1", op: "linear_pattern", source: { features: ["ex2"] }, direction: { ref: "origin.X" }, count: 4, spacing: 10 }])).report;
    ok(r);
    expect(vol(r)).toBeCloseTo(8000 - 4 * Math.PI * 4 * 10, 2);
    r = s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, circle("c0", 0, 0, 20)),
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
        sketch("sk2", { ref: "origin.XY" }, circle("c1", 12, 0, 2)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut" },
        { id: "cp1", op: "circular_pattern", source: { features: ["ex2"] }, axis: { ref: "origin.Z" }, count: 6 },
      ]),
    ).report;
    ok(r);
    expect(vol(r)).toBeCloseTo(Math.PI * 400 * 5 - 6 * Math.PI * 4 * 5, 2);
  });

  it("tags every copy of a cut or joined pattern, and resolves a copy's face later", async () => {
    const s = await newSession();
    const pattern = (mode: "cut" | "join"): Feature[] => [
      ...box,
      sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 5, 10, 2)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 4, flip: mode === "cut", mode },
      { id: "lp1", op: "linear_pattern", source: { features: ["ex2"] }, direction: { ref: "origin.X" }, count: 4, spacing: 10 },
    ];
    for (const mode of ["cut", "join"] as const) {
      const { report, meshes } = s.rebuild(doc(pattern(mode)));
      ok(report);
      expect(report.bodies, mode).toHaveLength(1);
      expect(vol(report), mode).toBeCloseTo(8000 + (mode === "cut" ? -1 : 1) * 4 * Math.PI * 4 * 4, 2);
      const tags = meshes[0]!.faceTags.flat();
      for (const k of [1, 2, 3]) expect(tags, mode).toContain(`ex2.side[sk2.c1]@lp1.${k}`);
    }
    // A later feature picks one copy's wall by its tag.
    const { report } = s.rebuild(doc([...pattern("join"), { id: "fi1", op: "fillet", edges: { select: "edges", where: { face: "ex2.end_cap@lp1.2" } }, radius: 0.5 }]));
    ok(report);
  });

  it("mirrors and patterns bodies, then unions them", async () => {
    const { report } = (await newSession()).rebuild(
      doc([
        ...box,
        { id: "mi1", op: "mirror", source: { bodies: ["ex1"] }, plane: { ref: "origin.YZ" } },
        { id: "bo1", op: "boolean", operation: "union", target: "ex1", tools: ["mi1_1"] },
      ]),
    );
    ok(report);
    expect(report.bodies).toHaveLength(1);
    expect(vol(report)).toBeCloseTo(16000, 3);
    expect(report.bodies[0]!.bbox.min[0]).toBeCloseTo(-40, 4);
    expect(report.bodies[0]!.faces).toBe(6);
  });

  it("deletes a part from that point on", async () => {
    const session = await newSession();
    const parts: Feature[] = [...box, { id: "mi1", op: "mirror", source: { bodies: ["ex1"] }, plane: { ref: "origin.YZ" } }];
    const before = session.rebuild(doc(parts)).report;
    ok(before);
    expect(before.bodies).toHaveLength(2);
    const after = session.rebuild(doc([...parts, { id: "del1", op: "delete", bodies: ["mi1_1"] }])).report;
    ok(after);
    expect(after.bodies.map((b) => b.id)).toEqual(["ex1"]);
    const missing = session.rebuild(doc([...parts, { id: "del1", op: "delete", bodies: ["nope"] }])).report;
    expect(missing.features.find((f) => f.id === "del1")?.status).toBe("error");
  });

  it("uses offset planes and projected edges", async () => {
    const { report } = (await newSession()).rebuild(
      doc([
        ...box,
        { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
        sketch("sk2", { ref: "pl1" }, [{ id: "pr", type: "projection", edges: [{ select: "edges", of: "ex1", where: { face: "end_cap" } }] }]),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 5, mode: "new_body" },
      ]),
    );
    ok(report);
    expect(report.bodies).toHaveLength(2);
    expect(vol(report, 1)).toBeCloseTo(4000, 3);
    expect(report.bodies[1]!.bbox.min[2]).toBeCloseTo(30, 4);
  });

  it("reports sketch conflicts as warnings and solver DOF", async () => {
    const d = corpus("box-fillet.meercad.json");
    const sk = d.features[0] as Extract<Feature, { op: "sketch" }>;
    sk.constraints.push({ id: "c8", type: "length", line: "l3", value: 99 });
    const { report } = (await newSession()).rebuild(d);
    expect(report.features[0]).toMatchObject({ status: "warning" });
    expect(report.features[0]!.message).toMatch(/conflicting/);
  });
});

describe("tools", () => {
  it("exports STEP and re-imports it with the same volume", async () => {
    const s = await newSession();
    s.rebuild(corpus("box-fillet.meercad.json"));
    const step = exportStep(await getOcct(), s.state!);
    expect(new TextDecoder().decode(step.subarray(0, 20))).toContain("ISO-10303-21");
    let b64 = "";
    for (let i = 0; i < step.length; i += 0x8000) b64 += String.fromCharCode(...step.subarray(i, i + 0x8000));
    const { report } = (await newSession()).rebuild(doc([{ id: "im1", op: "import", format: "step", fileName: "x.step", data: btoa(b64) }]));
    ok(report);
    expect(vol(report)).toBeCloseTo(8000 - 40 * 4 * (1 - Math.PI / 4), 2);
  });

  it("measures distance and angle between faces", async () => {
    const s = await newSession();
    const { meshes } = s.rebuild(doc(box));
    const tags = meshes[0]!.faceTags;
    const top = tags.findIndex((t) => t.includes("ex1.end_cap"));
    const bottom = tags.findIndex((t) => t.includes("ex1.start_cap"));
    const side = tags.findIndex((t) => t.includes("ex1.side[sk1.l1]"));
    const m = measure(await getOcct(), s.state!, { bodyId: "ex1", kind: "face", index: top }, { bodyId: "ex1", kind: "face", index: bottom });
    expect(m.rows[0]).toEqual(["Distance", "10 mm"]);
    const a = measure(await getOcct(), s.state!, { bodyId: "ex1", kind: "face", index: top }, { bodyId: "ex1", kind: "face", index: side });
    expect(a.rows.find((r) => r[0] === "Angle")?.[1]).toBe("90 °");
  });
});

describe("push/pull", () => {
  it("pulls a face out (join) and pushes another in (cut)", async () => {
    const { report, meshes } = (await newSession()).rebuild(
      doc([
        ...box,
        { id: "ex2", op: "extrude", profile: { face: { face: "ex1.end_cap" } }, extent: "blind", distance: 5, mode: "join" },
        { id: "ex3", op: "extrude", profile: { face: { face: "ex1.side[sk1.l2]" } }, extent: "blind", distance: 10, flip: true, mode: "cut" },
      ]),
    );
    ok(report);
    expect(report.bodies).toHaveLength(1);
    expect(vol(report)).toBeCloseTo(30 * 20 * 15, 3);
    expect(report.bodies[0]!.faces).toBe(6);
    expect(meshes[0]!.faceTags.flat()).toContain("ex2.end_cap");
  });
});

describe("tessellation", () => {
  it("has usable normals where a chamfer runs into a fillet corner (cone apex)", async () => {
    const d = doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
      { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }], radius: 4 },
      { id: "ch1", op: "chamfer", edges: { select: "edges", of: "ex1", where: { face: "end_cap" } }, distance: 4 },
    ]);
    const { report, meshes } = (await newSession()).rebuild(d);
    ok(report);
    const m = meshes[0]!;
    // Every vertex normal must agree with the area-weighted normal of its own triangles.
    const acc = new Float32Array(m.normals.length);
    for (let t = 0; t < m.indices.length; t += 3) {
      const [a, b, c] = [m.indices[t]! * 3, m.indices[t + 1]! * 3, m.indices[t + 2]! * 3];
      const p = m.positions;
      const u = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const v = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      for (const i of [a, b, c]) for (let k = 0; k < 3; k++) acc[i + k]! += n[k]!;
    }
    let bad = 0;
    for (let i = 0; i < acc.length; i += 3) {
      const l = Math.hypot(acc[i]!, acc[i + 1]!, acc[i + 2]!) || 1;
      if ((m.normals[i]! * acc[i]! + m.normals[i + 1]! * acc[i + 1]! + m.normals[i + 2]! * acc[i + 2]!) / l < 0.8) bad++;
    }
    expect(bad).toBe(0);
  });
});

describe("large booleans", () => {
  it("joins a stack of many-sided layers quickly (a mesh rebuilt with features)", async () => {
    // 20 layers of the same 120-sided outline, 1 mm each: the union merges 2400 side faces into 120.
    const n = 120;
    const pts: SketchEntity[] = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: "point", x: 30 * Math.cos((2 * Math.PI * i) / n), y: 20 * Math.sin((2 * Math.PI * i) / n) }));
    const lines: SketchEntity[] = Array.from({ length: n }, (_, i) => ({ id: `l${i}`, type: "line", p1: `p${i}`, p2: `p${(i + 1) % n}` }));
    const features: Feature[] = [];
    for (let k = 0; k < 20; k++) {
      features.push({ id: `pl${k}`, op: "plane", base: { ref: "origin.XY" }, offset: k });
      features.push(sketch(`sk${k}`, { ref: `pl${k}` }, [...pts, ...lines]));
      features.push({ id: `ex${k}`, op: "extrude", profile: { sketch: `sk${k}` }, extent: "blind", distance: 1, mode: "new_body" });
    }
    features.push({ id: "join", op: "boolean", operation: "union", target: "ex0", tools: Array.from({ length: 19 }, (_, k) => `ex${k + 1}`) });
    const s = await newSession();
    const t0 = performance.now();
    const { report } = s.rebuild(doc(features));
    const ms = performance.now() - t0;
    expect(report.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(report.bodies).toHaveLength(1);
    expect(report.bodies[0]!.faces).toBe(n + 2);
    // About 2 s alone, more while the other test files run beside it. Matching the merged faces'
    // names against every old face took minutes or broke the multi-threaded kernel.
    expect(ms).toBeLessThan(15000);
  });
});
