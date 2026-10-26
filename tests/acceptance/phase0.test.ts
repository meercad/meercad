/** Phase 0 acceptance criteria (PLAN.md §7), now on the full sketch + feature stack. */
import { describe, expect, it } from "vitest";
import type { BodyMesh } from "@opencad/kernel";
import { decodeShareFragment, encodeShareFragment, meshVolume, readStl, writeStl } from "@opencad/io";
import { validateDocument, type OpencadDocument } from "@opencad/schema";
import { corpus, newSession, withParams } from "./helpers.js";

const FILLET_LOSS = (r: number, len: number) => len * r * r * (1 - Math.PI / 4);
const ROUND = "fi1.round[ex1.end_cap|ex1.side[sk1.l3]]";

function facePoints(mesh: BodyMesh, tag: string): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < mesh.faceRanges.length; i += 3) {
    const [start, count, face] = [mesh.faceRanges[i]!, mesh.faceRanges[i + 1]!, mesh.faceRanges[i + 2]!];
    if (!mesh.faceTags[face]?.includes(tag)) continue;
    for (let k = start; k < start + count; k++) {
      const v = mesh.indices[k]! * 3;
      pts.push([mesh.positions[v]!, mesh.positions[v + 1]!, mesh.positions[v + 2]!]);
    }
  }
  return pts;
}

describe("Phase 0 acceptance", () => {
  it("1: constrained rectangle → extrude → fillet one edge → STL", async () => {
    const { report, meshes } = (await newSession()).rebuild(corpus("box-fillet.ocad.json"));
    expect(report.features.map((f) => f.status)).toEqual(["ok", "ok", "ok"]);
    expect(report.sketches[0]!.diagnostics.dof).toBe(0);
    const expected = 8000 - FILLET_LOSS(2, 40);
    expect(report.bodies[0]!.volume).toBeCloseTo(expected, 3);
    const stl = readStl(writeStl(meshes));
    expect(Math.abs(meshVolume(stl.vertices) - expected) / expected).toBeLessThan(0.005);
  });

  it("2: parameter changes drive the sketch and the fillet stays on its edge", async () => {
    const session = await newSession();
    for (const [w, d, h] of [[40, 20, 10], [60, 30, 25], [20, 12, 4]] as const) {
      const { report, meshes } = session.rebuild(withParams(corpus("box-fillet.ocad.json"), { w, d, h }));
      expect(report.features.every((f) => f.status === "ok")).toBe(true);
      expect(report.bodies[0]!.volume).toBeCloseTo(w * d * h - FILLET_LOSS(2, w), 2);
      const pts = facePoints(meshes[0]!, ROUND);
      expect(pts.length).toBeGreaterThan(0);
      for (const [, y, z] of pts) {
        expect(y!).toBeGreaterThanOrEqual(d - 2 - 1e-3);
        expect(z!).toBeGreaterThanOrEqual(h - 2 - 1e-3);
      }
    }
  });

  it("2b: a lost reference is an explicit error", async () => {
    const doc = corpus("box-fillet.ocad.json");
    doc.features[2] = { ...doc.features[2]!, edges: { edge: ["ex1.end_cap", "ex1.side[sk1.l9]"] } } as OpencadDocument["features"][number];
    const { report } = (await newSession()).rebuild(doc);
    expect(report.features[2]).toMatchObject({ status: "error" });
    expect(report.features[2]!.message).toMatch(/no edge between/);
  });

  it("3: incremental rebuild < 200 ms", async () => {
    const session = await newSession();
    session.rebuild(corpus("box-fillet.ocad.json"));
    const times: number[] = [];
    for (let h = 11; h < 21; h++) {
      const { report } = session.rebuild(withParams(corpus("box-fillet.ocad.json"), { h }));
      expect(report.firstRecomputed).toBe(1);
      times.push(report.rebuildMs + report.meshMs);
    }
    const median = times.sort((a, b) => a - b)[times.length >> 1]!;
    console.info(`incremental rebuild median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(200);
  });

  it("4: share link rebuilds identically", async () => {
    const doc = corpus("box-fillet.ocad.json");
    const parsed = validateDocument(await decodeShareFragment(await encodeShareFragment(doc)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const a = (await newSession()).rebuild(doc);
    const b = (await newSession()).rebuild(parsed.value);
    expect(b.report.bodies).toEqual(a.report.bodies);
    expect(b.meshes[0]!.faceTags).toEqual(a.meshes[0]!.faceTags);
  });
});
