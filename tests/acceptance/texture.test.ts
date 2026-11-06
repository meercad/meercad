import { describe, expect, it } from "vitest";
import { exportMeshes, type RebuildReport } from "@meercad/kernel";
import { parseStl, read3mf, write3mf, writeStl } from "@meercad/io";
import type { Feature, TextureFeature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);

/** Every edge (by position) used by exactly two triangles, once in each direction. */
function closedManifold(positions: Float32Array, indices: ArrayLike<number>): { open: number; bad: number } {
  const id = new Map<string, number>();
  const weld = (i: number) => {
    const key = `${positions[i * 3]!.toFixed(4)},${positions[i * 3 + 1]!.toFixed(4)},${positions[i * 3 + 2]!.toFixed(4)}`;
    let w = id.get(key);
    if (w === undefined) id.set(key, (w = id.size));
    return w;
  };
  const directed = new Map<number, number>();
  const ws = Array.from({ length: positions.length / 3 }, (_, i) => weld(i));
  for (let t = 0; t < indices.length; t += 3) {
    const c = [ws[indices[t]!]!, ws[indices[t + 1]!]!, ws[indices[t + 2]!]!];
    for (let k = 0; k < 3; k++) {
      const key = c[k]! * 4194304 + c[(k + 1) % 3]!;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let open = 0, bad = 0;
  for (const [key, n] of directed) {
    const a = Math.floor(key / 4194304), b = key % 4194304;
    if (n !== 1) bad++;
    if (directed.get(b * 4194304 + a) !== 1) open++;
  }
  return { open, bad };
}

function bbox(m: { positions: Float32Array }): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, m.positions[i + k]!);
      max[k] = Math.max(max[k]!, m.positions[i + k]!);
    }
  return { min, max };
}

/** An open 60 × 40 × 30 storage box with 2 mm walls, its four upright corners rounded (r 6). */
const storageBox: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", -30, -20, 60, 40)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
  {
    id: "fi1",
    op: "fillet",
    edges: ["l1|l2", "l2|l3", "l3|l4", "l4|l1"].map((p) => {
      const [a, b] = p.split("|");
      return { edge: [`ex1.side[sk1.${a}]`, `ex1.side[sk1.${b}]`] as [string, string] };
    }),
    radius: 6,
  },
  { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 },
];
const ribs: TextureFeature = { id: "st1", op: "texture", faces: [{ face: "ex1.side[*]" }, { face: "fi1.round[*]" }], pattern: "ribs", depth: 0.8, pitch: 4 };

describe("surface texture", () => {
  it("puts ribs round a storage box: closed, manifold, the right depth, the solid unchanged", async () => {
    const plain = (await newSession()).rebuild(doc(storageBox));
    const s = await newSession();
    const r = s.rebuild(doc([...storageBox, ribs]));
    ok(r.report);
    // A finish only: volume and size of the solid stay as they were.
    expect(r.report.bodies[0]!.volume).toBeCloseTo(plain.report.bodies[0]!.volume, 6);
    expect(r.report.bodies[0]!.faces).toBe(plain.report.bodies[0]!.faces);
    const shown = r.meshes[0]!;
    expect(shown.textured).toBe(true);
    expect(shown.indices.length).toBeGreaterThan(plain.meshes[0]!.indices.length * 20);
    expect(closedManifold(shown.positions, shown.indices)).toEqual({ open: 0, bad: 0 });
    // The ribs stand 0.8 mm out of the walls; nothing grows up or down.
    const b = bbox(shown);
    expect(b.min[0]).toBeCloseTo(-30.8, 1);
    expect(b.max[1]).toBeCloseTo(20.8, 1);
    expect(b.min[2]).toBeCloseTo(0, 6);
    expect(b.max[2]).toBeCloseTo(30, 6);

    // Exported triangles carry the ribs too, finer, and stay closed through STL and 3MF.
    const [fine] = exportMeshes(await getOcct(), s.state!);
    expect(fine!.textured).toBe(true);
    expect(fine!.indices.length).toBeGreaterThan(shown.indices.length);
    expect(closedManifold(fine!.positions, fine!.indices)).toEqual({ open: 0, bad: 0 });
    const stl = parseStl(writeStl([fine!]));
    expect(bbox(stl).min[0]).toBeCloseTo(-30.8, 1);
    const [tm] = read3mf(write3mf([{ ...fine!, name: "Box" }]));
    expect(closedManifold(tm!.positions, tm!.indices)).toEqual({ open: 0, bad: 0 });
    expect(bbox(tm!).max[1]).toBeCloseTo(20.8, 1);
  }, 120_000);

  it("runs the ribs on round the rounded corners: whole ribs, no seam", async () => {
    const s = await newSession();
    const m = s.rebuild(doc([...storageBox, { ...ribs, fade: 0 }])).meshes[0]!;
    // Halfway up, walk round the outside: count ribs (radius peaks) along the outline.
    const outline = 2 * (48 + 28) + 2 * Math.PI * 6;
    const samples: [number, number][] = [];
    for (let i = 0; i < m.positions.length; i += 3) {
      const [x, y, z] = [m.positions[i]!, m.positions[i + 1]!, m.positions[i + 2]!];
      if (Math.abs(z - 15) > 0.5) continue;
      // Distance outside the smooth outline (rounded rectangle 60 × 40, r 6).
      const dx = Math.max(Math.abs(x) - 24, 0), dy = Math.max(Math.abs(y) - 14, 0);
      const out = Math.hypot(dx, dy) - 6;
      if (out < -0.01) continue;
      samples.push([Math.atan2(y, x), out]);
    }
    samples.sort((a, b) => a[0] - b[0]);
    const bins = new Map<number, number>();
    for (const [a, o] of samples) {
      const k = Math.round(((a + Math.PI) / (2 * Math.PI)) * 3000);
      bins.set(k, Math.max(bins.get(k) ?? 0, o));
    }
    const seq = [...bins].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
    let peaks = 0;
    for (let i = 0; i < seq.length; i++) if (seq[i]! > 0.5 && seq[(i + seq.length - 1) % seq.length]! <= 0.5) peaks++;
    expect(peaks).toBe(Math.round(outline / 4));
  }, 120_000);

  it("knurls a round knob and keeps it closed", async () => {
    const s = await newSession();
    const r = s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, circle("c", 0, 0, 15)),
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 12, mode: "new_body" },
        { id: "st1", op: "texture", faces: [{ face: "ex1.side[sk1.c]" }], pattern: "knurl", depth: -0.5, pitch: 2 },
      ]),
    );
    ok(r.report);
    expect(r.report.bodies[0]!.volume).toBeCloseTo(Math.PI * 225 * 12, 0);
    const [m] = exportMeshes(await getOcct(), s.state!);
    expect(closedManifold(m!.positions, m!.indices)).toEqual({ open: 0, bad: 0 });
    // Cut in: nothing beyond the radius, grooves 0.5 mm deep.
    let minR = Infinity, maxR = 0;
    for (let i = 0; i < m!.positions.length; i += 3) {
      const z = m!.positions[i + 2]!;
      if (z < 2 || z > 10) continue;
      const rr = Math.hypot(m!.positions[i]!, m!.positions[i + 1]!);
      minR = Math.min(minR, rr);
      maxR = Math.max(maxR, rr);
    }
    expect(maxR).toBeLessThan(15 + 1e-3);
    expect(minR).toBeCloseTo(14.5, 1);
  }, 120_000);

  it("follows the faces when the part changes later", async () => {
    const s = await newSession();
    const r = s.rebuild(
      doc([
        sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)),
        { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
        { id: "st1", op: "texture", faces: [{ face: "ex1.end_cap" }], pattern: "hex", depth: 0.5, pitch: 5 },
        // A hole drilled afterwards: the top keeps its texture round it.
        sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("h", 0, 0, 4)),
        { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 0, mode: "cut" },
      ]),
    );
    ok(r.report);
    const m = r.meshes[0]!;
    expect(m.textured).toBe(true);
    expect(closedManifold(m.positions, m.indices)).toEqual({ open: 0, bad: 0 });
    expect(bbox(m).max[2]).toBeCloseTo(10.5, 2);
  }, 120_000);

  it("explains what is wrong", async () => {
    const s = await newSession();
    const base: Feature[] = [sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 10, 10)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" }];
    const r = s.rebuild(doc([...base, { id: "st1", op: "texture", faces: [{ face: "ex1.end_cap" }], pattern: "ribs", depth: 0, pitch: 2 }])).report;
    expect(r.features.find((f) => f.id === "st1")!.message).toMatch(/depth/);
    const r2 = s.rebuild(doc([...base, { id: "st1", op: "texture", faces: [{ face: "nope.cap" }], pattern: "ribs", depth: 1, pitch: 2 }])).report;
    expect(r2.features.find((f) => f.id === "st1")!.status).toBe("error");
  }, 120_000);
});

