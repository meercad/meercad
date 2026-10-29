import { describe, expect, it } from "vitest";
import { applyOp } from "@meercad/model";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { planTool, type ModelInfo } from "../../apps/web/src/lib/copilotTools.js";
import { newSession } from "./helpers.js";

/** Runs copilot tool calls one after another, the way the app does, and rebuilds after each. */
async function session() {
  const kernel = await newSession();
  let doc: MeercadDocument = emptyDocument();
  let info: ModelInfo = { bodies: [], params: {} };
  return {
    get doc() {
      return doc;
    },
    async run(name: string, args: Record<string, unknown> = {}) {
      const plan = planTool(name, args, doc, info);
      if (!("ops" in plan)) throw new Error(`${name} changes nothing`);
      doc = plan.ops.reduce((d, op) => applyOp(d, op), doc);
      const r = kernel.rebuild(doc).report;
      const failed = r.features.filter((f) => f.status === "error");
      expect(failed, `${name}: ${failed.map((f) => f.message).join("; ")}`).toEqual([]);
      info = { bodies: r.bodies.map((b) => ({ id: b.id, name: b.id, bbox: b.bbox })), params: r.params };
      return r;
    },
  };
}

describe("copilot tools", () => {
  it("builds, rounds, hollows, drills, resizes and moves", async () => {
    const s = await session();
    let r = await s.run("add_box", { width: 40, depth: 30, height: 10 });
    expect(r.bodies[0]!.volume).toBeCloseTo(12000, 0);
    r = await s.run("round_edges", { part: "ex1", radius: 3, edges: "top" });
    expect(r.bodies[0]!.volume).toBeLessThan(12000);
    r = await s.run("hollow", { part: "ex1", wall: 2, open: "top" });
    expect(r.bodies[0]!.volume).toBeLessThan(6000);
    const before = r.bodies[0]!.volume;
    r = await s.run("add_hole", { diameter: 3, x: 10, y: 5 });
    expect(r.bodies[0]!.volume).toBeLessThan(before);
    r = await s.run("add_cylinder", { diameter: 10, height: 20, x: 40, y: 0 });
    expect(r.bodies).toHaveLength(2);
    const cyl = r.bodies.find((b) => b.id !== "ex1")!;
    expect(cyl.bbox.max[2]).toBeCloseTo(20, 1);
    r = await s.run("resize", { part: cyl.id, diameter: 16, height: 25 });
    const grown = r.bodies.find((b) => b.id === cyl.id)!;
    expect(grown.bbox.max[0] - grown.bbox.min[0]).toBeCloseTo(16, 1);
    expect(grown.bbox.max[2]).toBeCloseTo(25, 1);
    r = await s.run("move_part", { part: cyl.id, dz: 5 });
    expect(r.bodies.find((b) => b.id === cyl.id)!.bbox.min[2]).toBeCloseTo(5, 1);
  });

  it("rounds vertical edges and stacks a box on a plane", async () => {
    const s = await session();
    await s.run("add_box", { width: 20, depth: 20, height: 20 });
    let r = await s.run("round_edges", { part: "ex1", radius: 4, edges: "vertical" });
    expect(r.bodies[0]!.volume).toBeLessThan(8000);
    r = await s.run("add_box", { width: 10, depth: 10, height: 5, z: 20, mode: "add" });
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.bbox.max[2]).toBeCloseTo(25, 1);
    r = await s.run("resize", { part: "ex1", width: 30 });
    expect(r.bodies[0]!.bbox.max[0] - r.bodies[0]!.bbox.min[0]).toBeCloseTo(30, 1);
  });

  it("answers with something the model can fix", async () => {
    const s = await session();
    expect(() => planTool("round_edges", { part: "ex9", radius: 1, edges: "all" }, s.doc, { bodies: [], params: {} })).toThrow(/no part "ex9"/);
    expect(() => planTool("add_box", { width: 10, depth: 10 }, s.doc, { bodies: [], params: {} })).toThrow(/height is missing/);
  });
});
