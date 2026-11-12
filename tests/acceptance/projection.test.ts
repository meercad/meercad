/**
 * Edges projected into a sketch keep their true size and place: a hole's round edge comes in as a
 * circle of its radius round its centre, a rounded corner's edge as an arc of its radius between
 * the right ends, also on a plane facing the other way; a circle that is not parallel to the sketch
 * says so. Extruding a projected circle gives the cylinder of that size.
 */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

/** A 40 × 20 × 10 block with an Ø8 hole at (20, 10) and its corner at (40, 20) rounded R5 (vertical edge). */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  sketch("sk2", { ref: "origin.XY" }, circle("k", 20, 10, 4)),
  { id: "ex2", op: "extrude", profile: { sketch: "sk2" }, extent: "symmetric", distance: 40, mode: "cut" },
  { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l2]", "ex1.side[sk1.l3]"] }], radius: 5 },
  { id: "pl1", op: "plane", base: { ref: "origin.XY" }, offset: 30 },
];
const holeTop = { edge: ["ex1.end_cap", "ex2.side[sk2.k]"] };
const roundTop = { edge: ["ex1.end_cap", "fi1.round[ex1.side[sk1.l2]|ex1.side[sk1.l3]]"] };

async function curvesOf(plane: Parameters<typeof sketch>[1], edges: object[], extra: Feature[] = []) {
  const { report } = (await newSession()).rebuild(doc([...block, sketch("sk3", plane, [{ id: "pr", type: "projection", edges: edges as never }]), ...extra]));
  const st = report.features.find((f) => f.id === "sk3")!;
  return { report, status: st, curves: report.sketches.find((s) => s.id === "sk3")?.curves ?? [] };
}

describe("projected edges", () => {
  it("bring a hole's edge in as a circle of its size round its centre", async () => {
    const { curves, status } = await curvesOf({ ref: "pl1" }, [holeTop]);
    expect(status.status).toBe("ok");
    expect(curves).toHaveLength(1);
    const c = curves[0] as { kind: string; center: [number, number]; radius: number; external?: boolean };
    expect(c.kind).toBe("circle");
    expect(c.radius).toBeCloseTo(4, 9);
    expect(c.center[0]).toBeCloseTo(20, 9);
    expect(c.center[1]).toBeCloseTo(10, 9);
    expect(c.external).toBe(true);
  });

  it("bring a rounded corner's edge in as an arc of its radius between its ends", async () => {
    const { curves } = await curvesOf({ ref: "pl1" }, [roundTop]);
    const a = curves[0] as { kind: string; center: [number, number]; radius: number; a0: number; a1: number };
    expect(a.kind).toBe("arc");
    expect(a.radius).toBeCloseTo(5, 9);
    expect(a.center[0]).toBeCloseTo(35, 9);
    expect(a.center[1]).toBeCloseTo(15, 9);
    // From the right side round to the back: 0° to 90°.
    expect([a.a0, a.a1].map((x) => Math.round((x * 180) / Math.PI))).toEqual([0, 90]);
  });

  it("keep the arc's direction on a plane facing down", async () => {
    // On the block's bottom face the sketch looks up from below: the arc still spans its quarter.
    const { curves, status } = await curvesOf({ face: { face: "ex1.start_cap" } }, [roundTop]);
    expect(status.status).toBe("ok");
    const a = curves[0] as { center: [number, number]; radius: number; a0: number; a1: number };
    expect(a.radius).toBeCloseTo(5, 9);
    const span = ((a.a1 - a.a0 + 2 * Math.PI) % (2 * Math.PI)) * (180 / Math.PI);
    expect(span).toBeCloseTo(90, 6);
  });

  it("make a cylinder of the hole's size when extruded", async () => {
    const { report } = await curvesOf({ ref: "pl1" }, [holeTop], [{ id: "ex3", op: "extrude", profile: { sketch: "sk3" }, extent: "blind", distance: 5, mode: "new_body" }]);
    const cyl = report.bodies.find((b) => b.id === "ex3")!;
    expect(cyl.volume).toBeCloseTo(Math.PI * 16 * 5, 6);
    expect(cyl.bbox.min[2]).toBeCloseTo(30, 6);
  });

  it("say when a circle is not parallel to the sketch", async () => {
    const { status } = await curvesOf({ ref: "origin.XZ" }, [holeTop]);
    expect(status.status).toBe("error");
    expect(status.message).toMatch(/only circles parallel to the sketch plane can be projected/);
  });
});
