import { describe, expect, it } from "vitest";
import { doc, newSession } from "./helpers.js";

describe("primitive solids", () => {
  it("builds a box, a cylinder and a sphere at their centres, with named faces", async () => {
    const s = await newSession();
    const r = s.rebuild(
      doc([
        { id: "bx", op: "primitive", shape: "box", size: [20, 10, 4], center: [5, 0, 2], mode: "new_body" },
        {
          id: "cy",
          op: "primitive",
          shape: "cylinder",
          diameter: 6,
          height: 30,
          axis: "X",
          center: [0, 40, 0],
          mode: "new_body",
        },
        {
          id: "sp",
          op: "primitive",
          shape: "sphere",
          diameter: "2 * 5 mm",
          center: [0, 0, 50],
          mode: "new_body",
        },
      ]),
    );
    expect(r.report.features.filter((f) => f.status !== "ok")).toEqual([]);

    const body = (id: string) => r.report.bodies.find((b) => b.id === id)!;
    expect(body("bx").volume).toBeCloseTo(800, 3);
    expect(body("bx").bbox.min).toEqual([-5, -5, 0]);
    expect(body("cy").volume).toBeCloseTo(Math.PI * 9 * 30, 1);
    expect(body("cy").bbox.min[0]).toBeCloseTo(-15, 6);
    expect(body("sp").volume).toBeCloseTo((4 / 3) * Math.PI * 125, 0);

    const tags = (id: string) => new Set(r.meshes.find((m) => m.bodyId === id)!.faceTags.flat());
    expect(tags("bx")).toEqual(
      new Set(["bx.top", "bx.bottom", "bx.front", "bx.back", "bx.left", "bx.right"]),
    );
    expect(tags("cy")).toEqual(new Set(["cy.side", "cy.start_cap", "cy.end_cap"]));
  });

  it("cuts and joins like an extrude, and its faces take fillets", async () => {
    const s = await newSession();
    const r = s.rebuild(
      doc([
        { id: "bx", op: "primitive", shape: "box", size: [20, 20, 10], center: [0, 0, 5], mode: "new_body" },
        {
          id: "ho",
          op: "primitive",
          shape: "cylinder",
          diameter: 4,
          height: 30,
          center: [0, 0, 5],
          mode: "cut",
          targets: ["bx"],
        },
        { id: "fi", op: "fillet", edges: { select: "edges", of: "bx", where: { face: "top" } }, radius: 1 },
      ]),
    ).report;
    expect(r.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0]!.volume).toBeLessThan(4000 - Math.PI * 4 * 10 + 1);
    expect(r.bodies[0]!.volume).toBeGreaterThan(4000 - Math.PI * 4 * 10 - 40);
  });

  it("says what is missing", async () => {
    const s = await newSession();
    const r = s.rebuild(
      doc([{ id: "bx", op: "primitive", shape: "box", size: [0, 10, 4], mode: "new_body" }]),
    ).report;
    expect(r.features[0]!.message).toMatch(/greater than zero/);
  });
});
