/**
 * Phase 0 acceptance criteria (PLAN.md §7). Criterion 3's cold start is measured in the browser;
 * criterion 5 (live LLM) lives in packages/ai and needs an API key.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { KernelSession, type BodyMesh, type OC } from "@opencad/kernel";
import { decodeShareFragment, encodeShareFragment, meshVolume, readStl, writeStl } from "@opencad/io";
import { validateDocument, type OpencadDocument } from "@opencad/schema";
import { corpus, getOcct, withParams } from "./helpers.js";

const FILLET_LOSS = (r: number, len: number) => len * r * r * (1 - Math.PI / 4);

/** Vertex positions of all triangles of the faces carrying `tag`. */
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

let oc: OC;
let initMs: number;
beforeAll(async () => {
  const t = performance.now();
  oc = await getOcct();
  initMs = performance.now() - t;
});

const ROUND = "fi1.round[ex1.end_cap|ex1.side[sk1.r1.top]]";

describe("Phase 0 acceptance", () => {
  it("1: rectangle → extrude → fillet one edge → STL", () => {
    const doc = corpus("box-fillet.ocad.json");
    const { report, meshes } = new KernelSession(oc).rebuild(doc);
    expect(report.features.map((f) => f.status)).toEqual(["ok", "ok", "ok"]);
    const expected = 40 * 20 * 10 - FILLET_LOSS(2, 40);
    expect(report.bodies[0]!.volume).toBeCloseTo(expected, 3);
    expect(report.bodies[0]!.faces).toBe(7);

    const stl = readStl(writeStl(meshes));
    expect(stl.triangles).toBeGreaterThan(12);
    expect(Math.abs(meshVolume(stl.vertices) - expected) / expected).toBeLessThan(0.005);
  });

  it("2: changing extrude height keeps the fillet on the same edge", () => {
    const session = new KernelSession(oc);
    for (const h of [10, 25, 4, 10]) {
      const { report, meshes } = session.rebuild(withParams(corpus("box-fillet.ocad.json"), { h: `${h} mm` }));
      expect(report.features.every((f) => f.status === "ok")).toBe(true);
      expect(report.bodies[0]!.volume).toBeCloseTo(40 * 20 * h - FILLET_LOSS(2, 40), 3);
      // The fillet face must hug the top/back edge (y = 20, z = h) for every height.
      const pts = facePoints(meshes[0]!, ROUND);
      expect(pts.length).toBeGreaterThan(0);
      for (const [, y, z] of pts) {
        expect(y!).toBeGreaterThanOrEqual(18 - 1e-3);
        expect(z!).toBeGreaterThanOrEqual(h - 2 - 1e-3);
      }
    }
  });

  it("2b: a reference that no longer resolves is an explicit error, never a silent re-match", () => {
    const doc = corpus("box-fillet.ocad.json");
    const fi = doc.features[2]!;
    const bad: OpencadDocument = {
      ...doc,
      features: [doc.features[0]!, doc.features[1]!, { ...fi, edges: { edge: ["ex1.end_cap", "ex1.side[sk1.r1.gone]"] } } as typeof fi],
    };
    const { report } = new KernelSession(oc).rebuild(bad);
    expect(report.features[2]).toMatchObject({ status: "error" });
    expect(report.features[2]!.message).toMatch(/no edge between/);
    expect(report.bodies[0]!.volume).toBeCloseTo(8000, 3);
  });

  it("3: cold start < 5 s and incremental rebuild < 200 ms (Node; browser measured separately)", () => {
    expect(initMs).toBeLessThan(5000);
    const session = new KernelSession(oc);
    session.rebuild(corpus("box-fillet.ocad.json"));
    const times: number[] = [];
    for (let h = 11; h < 21; h++) {
      const { report } = session.rebuild(withParams(corpus("box-fillet.ocad.json"), { h }));
      expect(report.firstRecomputed).toBe(1);
      times.push(report.rebuildMs + report.meshMs);
    }
    const median = times.sort((a, b) => a - b)[times.length >> 1]!;
    console.info(`OCCT init ${initMs.toFixed(0)} ms, incremental rebuild median ${median.toFixed(1)} ms`);
    expect(median).toBeLessThan(200);
  });

  it("4: document in URL fragment rebuilds identically", async () => {
    const doc = corpus("box-fillet.ocad.json");
    const fragment = await encodeShareFragment(doc);
    const parsed = validateDocument(await decodeShareFragment(fragment));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const a = new KernelSession(oc).rebuild(doc);
    const b = new KernelSession(oc).rebuild(parsed.value);
    expect(b.report.bodies).toEqual(a.report.bodies);
    expect(b.meshes[0]!.faceTags).toEqual(a.meshes[0]!.faceTags);
    expect(Array.from(b.meshes[0]!.positions)).toEqual(Array.from(a.meshes[0]!.positions));
  });
});

describe("kernel robustness", () => {
  it("suggests a working radius when a fillet is too large", () => {
    const doc = withParams(corpus("box-fillet.ocad.json"), { wall: 15 });
    const { report } = new KernelSession(oc).rebuild(doc);
    expect(report.features[2]).toMatchObject({ status: "error" });
    expect(report.features[2]!.hint).toMatch(/7\.5 mm works/);
  });

  it("fillets all edges of a box and tags corner blends", () => {
    const doc = corpus("box-fillet.ocad.json");
    const all = { ...doc, features: [doc.features[0]!, doc.features[1]!, { id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1" }, radius: 1 }] } as OpencadDocument;
    const { report, meshes } = new KernelSession(oc).rebuild(all);
    expect(report.features[2]!.status).toBe("ok");
    const tags = meshes[0]!.faceTags.flat();
    expect(tags.filter((t) => t.startsWith("fi1.round[")).length).toBe(12);
    expect(tags.filter((t) => t.startsWith("fi1.blend.")).length).toBe(8);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("extrudes on other planes and in negative direction", () => {
    const doc = corpus("box-fillet.ocad.json");
    const sk = doc.features[0]!;
    const xz = { ...doc, params: { ...doc.params, h: -10 }, features: [{ ...sk, plane: { ref: "origin.XZ" } }, doc.features[1]!, doc.features[2]!] } as OpencadDocument;
    const { report } = new KernelSession(oc).rebuild(xz);
    expect(report.features.map((f) => f.status)).toEqual(["ok", "ok", "ok"]);
    const b = report.bodies[0]!;
    expect(b.volume).toBeCloseTo(8000 - FILLET_LOSS(2, 40), 3);
    expect(b.bbox.min[1]).toBeCloseTo(0, 3);
    expect(b.bbox.max[1]).toBeCloseTo(10, 3);
  });
});
