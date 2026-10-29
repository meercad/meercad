import { describe, expect, it } from "vitest";
import type { RebuildReport } from "@meercad/kernel";
import type { Feature, StandardPartFeature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

const status = (r: RebuildReport, id: string) => r.features.find((f) => f.id === id)!;
const ok = (r: RebuildReport) => expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const PI = Math.PI;
const hex = (s: number) => (Math.sqrt(3) / 2) * s * s;
/** 40 × 30 × 10 plate, top at z = 10. */
const plate: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 30)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const part = (p: Partial<StandardPartFeature>): StandardPartFeature => ({ id: "np1", op: "standard_part", kind: "socket_screw", size: "M3", length: 12, plane: { face: { face: "ex1.end_cap" } }, points: [[10, 15]], ...p });

async function run(p: Partial<StandardPartFeature>) {
  const s = await newSession();
  return s.rebuild(doc([...plate, part(p)]));
}
const body = (r: RebuildReport, id = "np1") => r.bodies.find((b) => b.id === id)!;

describe("standard parts", () => {
  it("places a socket head cap screw: head on the face, shank in, hex socket in the head", async () => {
    const { report, meshes } = await run({});
    ok(report);
    const b = body(report);
    // ISO 4762 M3: head Ø5.5 × 3, socket 2.5 deep 1.3, shank Ø3 × 12.
    expect(b.volume).toBeCloseTo(PI * 2.75 ** 2 * 3 - hex(2.5) * 1.3 + PI * 1.5 ** 2 * 12, 2);
    expect(b.bbox.min[2]).toBeCloseTo(10 - 12, 6);
    expect(b.bbox.max[2]).toBeCloseTo(10 + 3, 6);
    expect((b.bbox.min[0] + b.bbox.max[0]) / 2).toBeCloseTo(10, 6);
    const tags = new Set(meshes.find((m) => m.bodyId === "np1")!.faceTags.flat());
    for (const t of ["np1.head", "np1.shank", "np1.socket", "np1.top", "np1.bottom"]) expect(tags).toContain(t);
  });

  it("makes nuts, washers, bearings and magnets standing on the face", async () => {
    const nut = (await run({ kind: "hex_nut", size: "M5", length: undefined })).report;
    expect(body(nut).volume).toBeCloseTo((hex(8) - PI * 2.5 ** 2) * 4.7, 2);
    expect(body(nut).bbox.min[2]).toBeCloseTo(10, 6);
    const washer = (await run({ kind: "washer", size: "M4", length: undefined })).report;
    expect(body(washer).volume).toBeCloseTo(PI * (4.5 ** 2 - 2.15 ** 2) * 0.8, 3);
    const bearing = (await run({ kind: "bearing", size: "608", length: undefined, flip: true })).report;
    expect(body(bearing).volume).toBeCloseTo(PI * (11 ** 2 - 4 ** 2) * 7, 2);
    // Flipped: it goes into the face (a bearing pressed into a bore).
    expect(body(bearing).bbox.max[2]).toBeCloseTo(10, 6);
    const magnet = (await run({ kind: "magnet", size: undefined, length: undefined, diameter: 6, height: 3 })).report;
    expect(body(magnet).volume).toBeCloseTo(PI * 9 * 3, 3);
  });

  it("places one part per point", async () => {
    const { report } = await run({ points: [[10, 10], [30, 10], [30, 20]] });
    ok(report);
    expect(report.bodies.map((b) => b.id).filter((id) => id.startsWith("np1")).sort()).toEqual(["np1", "np1_2", "np1_3"]);
  });

  it("explains what is wrong", async () => {
    const { report } = await run({ size: "M7" });
    expect(status(report, "np1").message).toMatch(/unknown size "M7"/);
  });
});
