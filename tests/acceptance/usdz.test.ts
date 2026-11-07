import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportMeshes } from "@meercad/kernel";
import { writeUsda, writeUsdz } from "@meercad/io";
import { describe, expect, it } from "vitest";
import { corpus, getOcct, newSession } from "./helpers.js";

/** The AR file of a real part: in real size, standing on the table, and valid for AR Quick Look. */
describe("USDZ of a built part", () => {
  it("keeps the part's size and passes the ARKit checks", async () => {
    const s = await newSession();
    const report = s.rebuild(corpus("mounting-plate.meercad.json")).report;
    const meshes = exportMeshes(await getOcct(), s.state!);
    expect(meshes.length).toBeGreaterThan(0);
    const parts = meshes.map((m) => ({ positions: m.positions, indices: m.indices, normals: m.normals, name: m.bodyId, color: "#8aa1b8", metalness: 1, roughness: 0.35 }));

    // The size in the file (metres, Y up) is the part's size in mm, turned Z up → Y up.
    const usda = writeUsda(parts);
    const nums = [...usda.matchAll(/float3\[\] extent = \[\(([^)]*)\), \(([^)]*)\)\]/g)].map((m) => [m[1]!.split(", ").map(Number), m[2]!.split(", ").map(Number)] as const);
    const lo = [0, 1, 2].map((k) => Math.min(...nums.map(([a]) => a[k]!)));
    const hi = [0, 1, 2].map((k) => Math.max(...nums.map(([, b]) => b[k]!)));
    const box = report.bodies.map((b) => b.bbox).reduce((a, b) => ({ min: a.min.map((v, k) => Math.min(v, b.min[k]!)) as typeof a.min, max: a.max.map((v, k) => Math.max(v, b.max[k]!)) as typeof a.max }));
    const size = [0, 1, 2].map((k) => box.max[k]! - box.min[k]!);
    expect((hi[0]! - lo[0]!) * 1000).toBeCloseTo(size[0]!, 1);
    expect((hi[1]! - lo[1]!) * 1000).toBeCloseTo(size[2]!, 1);
    expect((hi[2]! - lo[2]!) * 1000).toBeCloseTo(size[1]!, 1);
    expect(lo[1]).toBeCloseTo(0, 6); // standing on the table
    expect(lo[0]! + hi[0]!).toBeCloseTo(0, 6); // centred
    expect(lo[2]! + hi[2]!).toBeCloseTo(0, 6);

    if (!existsSync("/usr/bin/usdchecker")) return;
    const file = join(process.env["USDZ_OUT"] ?? mkdtempSync(join(tmpdir(), "usdz-")), "mounting-plate.usdz");
    writeFileSync(file, writeUsdz(parts));
    const out = execFileSync("/usr/bin/usdchecker", ["--arkit", file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(out).toContain("Success");
  }, 60_000);
});
