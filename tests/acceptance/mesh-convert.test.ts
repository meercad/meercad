import { describe, expect, it } from "vitest";
import { exportMeshes, measure, type RebuildReport } from "@meercad/kernel";
import { writeStl } from "@meercad/io";
import type { Feature } from "@meercad/schema";
import { circle, doc, getOcct, newSession, rect, sketch } from "./helpers.js";

/** A model exported to STL the way the app does it, plus its exact volume. */
async function stlOf(features: Feature[]): Promise<{ data: string; volume: number }> {
  const s = await newSession();
  const r = s.rebuild(doc(features)).report;
  expect(r.features.filter((f) => f.status === "error")).toEqual([]);
  const meshes = exportMeshes(await getOcct(), s.state!);
  return { data: Buffer.from(writeStl(meshes)).toString("base64"), volume: r.bodies[0]!.volume };
}

const importAndConvert = (data: string, extra: Feature[] = []): Feature[] => [
  { id: "im1", op: "import", format: "stl", fileName: "part.stl", data },
  { id: "mc1", op: "mesh_convert", body: "im1" },
  ...extra,
];

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const tagsOf = (tags: string[][]) => tags.flat().sort();

/** 55 × 40 × 12 plate with a Ø10 and a Ø6 through hole. */
const plate: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, [...rect("l", 100, 110, 55, 40), ...circle("c1", 115, 130, 5), ...circle("c2", 140, 125, 3)]),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 12, mode: "new_body" },
];

describe("mesh_convert", () => {
  it("turns a plate with holes back into planes and cylinders of the right size", async () => {
    const { data, volume } = await stlOf(plate);
    const s = await newSession();
    const { report, meshes } = s.rebuild(doc(importAndConvert(data)));
    const st = status(report, "mc1");
    expect(st.message ?? "").toBe("");
    expect(st.status).toBe("ok");
    expect(report.bodies).toHaveLength(1);
    expect(report.bodies[0]!.faces).toBe(8);
    expect(report.bodies[0]!.volume).toBeCloseTo(volume, 0);
    const tags = tagsOf(meshes[0]!.faceTags);
    expect(tags.filter((t) => t.startsWith("mc1.plane["))).toHaveLength(6);
    expect(tags.filter((t) => t.startsWith("mc1.cylinder["))).toHaveLength(2);
    // The holes are real cylinders: the kernel measures their radii.
    const oc = await getOcct();
    const body = s.state!.bodies.get("im1")!;
    const radii = meshes[0]!.faceTags.flatMap((t, i) => (t[0]!.startsWith("mc1.cylinder") ? [Number(measure(oc, s.state!, { bodyId: "im1", kind: "face", index: i }).rows.find((r) => r[0] === "Radius")![1].split(" ")[0])] : []));
    expect(radii.sort()).toEqual([3, 5]);
    expect(body.sourceMesh).toBeNull();
    // Real edges are drawn again (a mesh part draws none).
    expect(meshes[0]!.edgeRanges.length).toBeGreaterThan(0);
  });

  it("gives a body that threads, fillets and cuts like any other", async () => {
    const { data } = await stlOf(plate);
    const oc = await getOcct();
    const s = await newSession();
    const converted = s.rebuild(doc(importAndConvert(data)));
    const radiusOf = (i: number) => Number(measure(oc, s.state!, { bodyId: "im1", kind: "face", index: i }).rows.find((r) => r[0] === "Radius")?.[1].split(" ")[0] ?? 0);
    const big = converted.meshes[0]!.faceTags.find((t, i) => t[0]!.startsWith("mc1.cylinder") && radiusOf(i) === 5)![0]!;
    const threaded = s.rebuild(doc(importAndConvert(data, [{ id: "th1", op: "thread", face: { face: big } }])));
    expect(threaded.report.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    // A Ø10 hole becomes an M10 thread: filled to the minor diameter, then grooved.
    expect(threaded.meshes[0]!.faceTags.flat()).toContain("th1.thread");
    expect(Math.abs(threaded.report.bodies[0]!.volume - converted.report.bodies[0]!.volume)).toBeGreaterThan(10);
    const r = s.rebuild(
      doc(
        importAndConvert(data, [
          { id: "fi1", op: "fillet", edges: { select: "edges", of: "im1", where: { face: "mc1.plane[*]" } }, radius: 0.5 },
          sketch("sk2", { ref: "origin.XY" }, rect("q", 100, 110, 5, 5)),
          { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "through_all", distance: 1, mode: "cut" },
        ]),
      ),
    ).report;
    expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    expect(r.bodies[0]!.volume).toBeLessThan(converted.report.bodies[0]!.volume - 5 * 5 * 12 + 1);
    expect(r.bodies[0]!.faces).toBeGreaterThan(8);
  });

  it("recognises cones and rounded edges", async () => {
    // A Ø10 pin with a 1 mm chamfer at the top and a rounded shoulder.
    const pin: Feature[] = [
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 20)),
      { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
      sketch("sk2", { face: { face: "ex1.end_cap" } }, circle("c1", 10, 10, 5)),
      { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "blind", distance: 15, mode: "join" },
      { id: "ch1", op: "chamfer", edges: { edge: ["ex2.end_cap", "ex2.side[sk2.c1]"] }, distance: 1 },
      { id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1", where: { face: "start_cap" } }, radius: 2 },
    ];
    const { data, volume } = await stlOf(pin);
    const s = await newSession();
    const { report, meshes } = s.rebuild(doc(importAndConvert(data)));
    const st = status(report, "mc1");
    expect(st.message ?? "").toBe("");
    expect(report.bodies[0]!.volume).toBeCloseTo(volume, 0);
    const tags = tagsOf(meshes[0]!.faceTags);
    expect(tags.filter((t) => t.startsWith("mc1.cone["))).toHaveLength(1);
    // The shaft and the four rounded bottom edges (the corner blends are spheres).
    expect(tags.filter((t) => t.startsWith("mc1.cylinder[")).length).toBeGreaterThanOrEqual(5);
    expect(tags.filter((t) => t.startsWith("mc1.facet["))).toHaveLength(0);
  });

  it("reports when the body is not a mesh part", async () => {
    const s = await newSession();
    const r = s.rebuild(doc([...plate, { id: "mc1", op: "mesh_convert", body: "ex1" }])).report;
    expect(status(r, "mc1").status).toBe("error");
    expect(status(r, "mc1").message).toMatch(/not a mesh part/);
  });
});
