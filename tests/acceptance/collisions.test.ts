import { describe, expect, it } from "vitest";
import { linkage, MeshCollider, meshesCollide, motion } from "@meercad/model";
import type { BodyMesh, RebuildReport } from "@meercad/kernel";
import type { MeercadDocument } from "@meercad/schema";
import { MODELS } from "../models/models.js";
import { newSession } from "./helpers.js";

/** As the app (lib/mechanism): how far the display mesh may stray from the true surface. */
const slack = (c: MeshCollider) => Math.max(0.01, Math.hypot(c.root.max[0] - c.root.min[0], c.root.max[1] - c.root.min[1], c.root.max[2] - c.root.min[2]) * 5e-4);

/** Pairs of parts running into each other in `poses`, leaving out those touching as drawn. */
function hits(meshes: BodyMesh[], poses: ReadonlyMap<string, motion.Mat4>): string[] {
  const cs = new Map(meshes.map((m) => [m.bodyId, new MeshCollider(m.positions, m.indices)]));
  const out: string[] = [];
  for (let i = 0; i < meshes.length; i++)
    for (let j = i + 1; j < meshes.length; j++) {
      const a = cs.get(meshes[i]!.bodyId)!;
      const b = cs.get(meshes[j]!.bodyId)!;
      const inset = 1.5 * Math.max(slack(a), slack(b));
      if (meshesCollide(a, b, undefined, undefined, inset)) continue;
      if (meshesCollide(a, b, poses.get(meshes[i]!.bodyId), poses.get(meshes[j]!.bodyId), inset)) out.push(`${meshes[i]!.bodyId}|${meshes[j]!.bodyId}`);
    }
  return out;
}

/** Joints and couplings for gears, as "Joints for N gears" makes them in the app (lib/mechanism). */
function withGearJoints(doc: MeercadDocument, gears: RebuildReport["gears"]): MeercadDocument {
  const joints = gears.map((g, i) => ({ id: `j${i + 1}`, type: g.kind === "rack" ? ("slider" as const) : ("revolute" as const), a: g.id, b: "ground", anchor: { gear: g.id } }));
  const jointOf = new Map(gears.map((g, i) => [g.id, `j${i + 1}`]));
  const couplings = gears.flatMap((g, i) => {
    const p = g.meshWith ? gears.find((x) => x.id === g.meshWith) : undefined;
    if (!p) return [];
    const ratio = p.kind === "rack" ? 180 / (Math.PI * g.radius) : g.kind === "rack" ? (Math.PI * p.radius) / 180 : (p.kind === "spur" && g.kind === "spur" ? -1 : 1) * (p.teeth / g.teeth);
    return [{ id: `c${i + 1}`, driver: jointOf.get(p.id)!, driven: jointOf.get(g.id)!, ratio }];
  });
  return { ...doc, mechanism: { joints, couplings } };
}

describe("live collisions on the test models", () => {
  for (const prefix of ["18", "19", "20", "21", "22", "23"]) {
    const model = MODELS.find((m) => m.file.startsWith(prefix))!;
    it(`${model.file}: moving through its range shows no collision`, async () => {
      const s = await newSession();
      const doc = model.doc.mechanism ? model.doc : withGearJoints(model.doc, s.rebuild(model.doc).report.gears);
      const { report, meshes } = s.rebuild(doc);
      const joints: motion.MotionJoint[] = doc.mechanism!.joints.map((j) => {
        const f = report.joints.find((x) => x.id === j.id)!;
        return { id: j.id, type: j.type, a: j.a, b: j.b, origin: f.origin, axis: f.axis, ...(j.limits ? { limits: [Number(j.limits[0]), Number(j.limits[1])] as [number, number] } : {}) };
      });
      const couplings = (doc.mechanism!.couplings ?? []).map((c) => ({ driver: c.driver, driven: c.driven, ratio: Number(c.ratio) }));
      const driver = joints.find((j) => j.type !== "fixed" && !couplings.some((c) => c.driven === j.id))!;
      const found = new Set<string>();
      if (linkage.hasLoops(joints)) {
        const L = new linkage.Linkage(joints, couplings);
        let poses = new Map<string, motion.Mat4>();
        let values: Record<string, number> = {};
        for (let v = 10; v <= 360; v += 10) {
          const r = L.solve(poses, { [driver.id]: v }, undefined, values);
          if (!r.ok) break;
          poses = r.poses;
          values = r.values;
          for (const h of hits(meshes, poses)) found.add(`${h} at ${v}`);
        }
      } else {
        const mech = new motion.Mechanism(joints, couplings);
        const [lo, hi] = mech.range(driver.id);
        const span = driver.type === "slider" ? [Math.max(lo, -20), Math.min(hi, 20)] : [Math.max(lo, 0), Math.min(hi, 360)];
        for (let k = 0; k <= 24; k++) {
          const v = span[0]! + ((span[1]! - span[0]!) * k) / 24;
          for (const h of hits(meshes, mech.poses(mech.values({ [driver.id]: v })))) found.add(`${h} at ${v.toFixed(1)}`);
        }
      }
      expect([...found]).toEqual([]);
    }, 120_000);
  }
});
