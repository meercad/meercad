// Time and size of the robot export (MJCF/URDF + meshes) of a design, without the app.
// Usage (from tests/): ../node_modules/.bin/jiti bench/robot-export.ts path/to/design.meercad
import { KernelSession, loadOcct } from "@meercad/kernel";
import { writeRobot, type RobotJoint, type RobotPart } from "@meercad/io";
import type { MeercadDocument } from "@meercad/schema";
import { SketchSolver } from "@meercad/sketch";
import { readFileSync } from "node:fs";

const doc = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as MeercadDocument;
const oc = await loadOcct(undefined, false);
const solver = await SketchSolver.create();
const s = new KernelSession(oc, solver);
let t = performance.now();
const r = s.rebuild(doc);
console.log(
  `rebuild ${(performance.now() - t).toFixed(0)} ms, ${r.report.bodies.length} bodies, ${r.meshes.reduce((n, m) => n + m.indices.length / 3, 0)} triangles`,
);

const meshes = new Map(r.meshes.map((m) => [m.bodyId, m]));
const parts: RobotPart[] = r.report.bodies.flatMap((b) => {
  const m = meshes.get(b.id);
  if (!m || !(b.volume > 0)) return [];

  const c = b.centroid ?? [0, 0, 0];

  return [
    {
      id: b.id,
      mesh: { positions: m.positions, indices: m.indices },
      mass: b.volume * 0.00124,
      centroid: c as [number, number, number],
      inertia: [1, 1, 1, 0, 0, 0] as const,
    },
  ];
});
const joints: RobotJoint[] = (doc.mechanism?.joints ?? []).flatMap((j) => {
  const f = r.report.joints.find((x) => x.id === j.id);
  if (!f || f.error || j.suppressed) return [];

  return [
    {
      id: j.id,
      type: j.type === "cylindrical" ? "revolute" : (j.type as RobotJoint["type"]),
      a: j.a,
      b: j.b,
      origin: f.origin,
      axis: f.axis,
    },
  ];
});
t = performance.now();

const out = writeRobot(parts, joints, [], { name: "bench" });
const ms = performance.now() - t;
const bytes = Object.values(out.files).reduce((n, f) => n + f.length, 0);
console.log(
  `writeRobot ${ms.toFixed(0)} ms, ${out.links.length} links, ${Object.keys(out.files).length} files, ${(bytes / 1e6).toFixed(1)} MB (base64 ${((bytes * 4) / 3 / 1e6).toFixed(1)} MB)`,
);

const heavy = [...r.meshes].sort((a, b) => b.indices.length - a.indices.length).slice(0, 12);
for (const m of heavy) console.log(`  ${String(m.indices.length / 3).padStart(8)} triangles  ${m.bodyId}`);
process.exit(0);
