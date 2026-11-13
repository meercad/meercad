import { describe, expect, it } from "vitest";
import { exportMeshes, type RebuildReport } from "@meercad/kernel";
import { writeStl } from "@meercad/io";
import { GRIDFINITY as G, MeshCollider, signedDistance } from "@meercad/model";
import { validateDocument, type Feature } from "@meercad/schema";
import { doc, getOcct, newSession } from "./helpers.js";

/**
 * A Gridfinity bin made round a scanned part: the part sinks half way into a nest with play, the bin
 * takes as few grid cells as hold it and is built where the part lies.
 */

/** A slightly bumpy ellipsoid like a scanned stone, half axes a, b, c, lying on z = 5 at (30, −10). */
function stone(a: number, b: number, c: number, n = 30): string {
  const P: number[] = [0, 0, 0],
    I: number[] = [];
  const m = 2 * n;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;

  for (let i = 1; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const th = (Math.PI * i) / n,
        ph = (2 * Math.PI * j) / m,
        k = 1 + (0.2 * rnd()) / a;
      P.push(
        a * k * Math.sin(th) * Math.cos(ph) + 30,
        b * k * Math.sin(th) * Math.sin(ph) - 10,
        -c * k * Math.cos(th) + c + 5,
      );
    }
  }

  P.splice(0, 3, 30, -10, 5);
  P.push(30, -10, 2 * c + 5);

  const v = (i: number, j: number) => 1 + (i - 1) * m + (j % m);
  for (let j = 0; j < m; j++) I.push(0, v(1, j + 1), v(1, j));

  for (let i = 1; i < n - 1; i++) {
    for (let j = 0; j < m; j++) {
      I.push(v(i, j), v(i, j + 1), v(i + 1, j + 1), v(i, j), v(i + 1, j + 1), v(i + 1, j));
    }
  }

  const top = P.length / 3 - 1;
  for (let j = 0; j < m; j++) I.push(top, v(n - 1, j), v(n - 1, j + 1));

  return Buffer.from(writeStl([{ positions: Float32Array.from(P), indices: Uint32Array.from(I) }])).toString(
    "base64",
  );
}

const ok = (r: RebuildReport) =>
  expect(r.features.filter((f) => f.status === "error").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
const scan = (a = 45, b = 15, c = 12): Feature => ({
  id: "im1",
  op: "import",
  format: "stl",
  fileName: "stone.stl",
  data: stone(a, b, c),
});

async function build(features: Feature[]) {
  const s = await newSession();

  return { ...s.rebuild(doc(features)), session: s };
}

describe("gridfinity bins for a part", () => {
  it("nests a scan half way with play in the smallest bin, built where the scan lies", async () => {
    const features: Feature[] = [
      scan(),
      { id: "gf1", op: "gridfinity", kind: "bin", pocket: { body: "im1" } },
    ];
    expect(validateDocument(doc(features))).toMatchObject({ ok: true });

    const { report, session } = await build(features);
    ok(report);

    const f = report.features.find((x) => x.id === "gf1")!;
    // 90 × 30 mm, 24 mm high: 3 × 1 cells straight; 12 mm + 0.5 play deep → 3 units high.
    expect(f.info).toMatchObject({ width: 3, depth: 1, height: 3, angle: 0 });
    expect(f.info!["pocketDepth"]).toBeCloseTo(12.5, 1);

    const bin = report.bodies.find((b) => b.id === "gf1")!;
    // The rim (top of the solid, below the lip) at the scan's middle height, z = 5 + 12.
    expect(bin.bbox.max[2]).toBeCloseTo(17 + G.lipHeight, 1);
    expect(bin.bbox.min[2]).toBeCloseTo(17 - 3 * G.unit, 1);
    expect((bin.bbox.min[0] + bin.bbox.max[0]) / 2).toBeCloseTo(30, 0);
    expect((bin.bbox.min[1] + bin.bbox.max[1]) / 2).toBeCloseTo(-10, 0);
    expect(bin.bbox.max[0] - bin.bbox.min[0]).toBeCloseTo(3 * 42 - 0.5, 3);

    // The scan sits in the nest without touching it: every point of it lies outside the bin, the
    // nearest about the play away.
    const meshes = exportMeshes(await getOcct(), session.state!);
    const binMesh = meshes.find((m) => m.bodyId === "gf1"),
      part = meshes.find((m) => m.bodyId === "im1");
    const collider = new MeshCollider(binMesh!.positions, binMesh!.indices);
    let nearest = Infinity;

    for (let i = 0; i < part!.positions.length; i += 3) {
      nearest = Math.min(
        nearest,
        signedDistance(collider, [part!.positions[i]!, part!.positions[i + 1]!, part!.positions[i + 2]!]),
      );
    }

    expect(nearest).toBeGreaterThan(0.3);
    expect(nearest).toBeLessThan(0.8);

    // Its faces are named: the nest's triangles, the outer wall, the feet.
    const tags = new Set(session.state!.bodies.get("gf1")!.faceTags.flat());
    for (const t of ["gf1.nest", "gf1.wall", "gf1.foot", "gf1.top"]) expect(tags).toContain(t);
  });

  it("adds a finger grip across the part and makes room for it", async () => {
    const { report, session } = await build([
      scan(),
      {
        id: "gf1",
        op: "gridfinity",
        kind: "bin",
        pocket: { body: "im1", grip: true, sink: 40, clearance: 0.3 },
      },
    ]);
    ok(report);
    // 30 mm + 2 × 12 mm for the fingers no longer fits one cell.
    expect(report.features.find((x) => x.id === "gf1")!.info).toMatchObject({ width: 3, depth: 2 });
    expect(session.state!.bodies.get("gf1")!.faceTags.flat()).toContain("gf1.grip");
  });

  it("turns the bin along a part lying at an angle, and keeps it straight when turning saves nothing", async () => {
    const turned = await build([
      scan(),
      { id: "tf1", op: "transform", bodies: ["im1"], rotate: { axis: { ref: "origin.Z" }, angle: 30 } },
      { id: "gf1", op: "gridfinity", kind: "bin", pocket: { body: "im1" } },
    ]);
    ok(turned.report);

    const info = turned.report.features.find((x) => x.id === "gf1")!.info!;
    expect(info).toMatchObject({ width: 3, depth: 1 });
    // Along the part (its bumps tilt the tightest box by a degree or two).
    expect(Math.abs(info["angle"]! - 30)).toBeLessThan(3);

    // 70 × 50 mm needs 2 × 2 cells either way: straight.
    const round = await build([
      scan(35, 25, 8),
      { id: "gf1", op: "gridfinity", kind: "bin", pocket: { body: "im1" } },
    ]);
    ok(round.report);
    expect(round.report.features.find((x) => x.id === "gf1")!.info).toMatchObject({
      width: 2,
      depth: 2,
      angle: 0,
    });
  });

  it("keeps given sizes, and says when the part does not fit them", async () => {
    const { report } = await build([
      scan(),
      { id: "gf1", op: "gridfinity", kind: "bin", units: [2, 1], height: 4, pocket: { body: "im1" } },
    ]);
    expect(report.features.find((x) => x.id === "gf1")!.message).toMatch(/at least 3 × 1 cells/);

    const big = await build([
      scan(),
      { id: "gf1", op: "gridfinity", kind: "bin", units: [4, 2], height: 5, pocket: { body: "im1" } },
    ]);
    ok(big.report);
    expect(big.report.features.find((x) => x.id === "gf1")!.info).toMatchObject({
      width: 4,
      depth: 2,
      height: 5,
    });
  });

  it("reports a missing part", async () => {
    const { report } = await build([{ id: "gf1", op: "gridfinity", kind: "bin", pocket: { body: "im9" } }]);
    expect(report.features.find((x) => x.id === "gf1")!.message).toMatch(/not found/);
  });
});
