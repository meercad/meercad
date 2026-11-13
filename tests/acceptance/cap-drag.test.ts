/**
 * Pulling the top of an extruded part changes that extrusion (or its variable) instead of adding a
 * new step on top. Found 2026-11-11 on the iPad: dragging the mounting plate's top added
 * "Extrude 3" and the holes no longer went through.
 */
import { describe, expect, it } from "vitest";
import { applyOp, evaluate } from "@meercad/model";
import type { Expr, MeercadDocument } from "@meercad/schema";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
import { capDrag } from "../../apps/web/src/lib/capDrag.js";
import { doc, newSession, rect, sketch, withParams } from "./helpers.js";

const plate = EXAMPLES.find((e) => e.name === "Mounting plate")!.doc;

/** Tags of the flat face on top (largest z), as a tap picks it. */
async function topFaceTags(d: MeercadDocument): Promise<{ tags: string[]; params: Record<string, number> }> {
  const { meshes, report } = (await newSession()).rebuild(d);
  const m = meshes[0]!;
  let best = -Infinity,
    tags: string[] = [];

  for (let g = 0; g < m.faceRanges.length; g += 3) {
    const face = m.faceRanges[g + 2]!;
    const i = m.indices[m.faceRanges[g]!]! * 3;
    const z = m.positions[i + 2]!;

    if (z > best + 1e-6 && (m.faceTags[face] ?? []).some((t) => t.endsWith(".end_cap"))) {
      ((best = z), (tags = m.faceTags[face]!));
    }
  }

  return { tags, params: report.params };
}

const valueIn = (params: Record<string, number>) => (e: Expr) => evaluate(e, new Map(Object.entries(params)));

describe("dragging an extrusion's end face", () => {
  it("changes the variable behind it: the mounting plate gets thicker and its holes still go through", async () => {
    const { tags, params } = await topFaceTags(plate);
    const cap = capDrag(plate, tags, valueIn(params));
    expect(cap).toMatchObject({ feature: "ex1", param: "thickness", distance: 4 });

    const dragged = applyOp(plate, cap!.write(7.5));
    expect(dragged.params["thickness"]).toBe("7.5 mm");
    // No new step: the same features as before.
    expect(dragged.features.map((f) => f.id)).toEqual(plate.features.map((f) => f.id));

    const s = await newSession();
    const after = s.rebuild(dragged).report;
    const typed = s.rebuild(withParams(plate, { thickness: "7.5 mm" })).report;
    expect(after.features.filter((f) => f.status !== "ok")).toEqual([]);
    expect(after.bodies).toHaveLength(1);
    expect(after.bodies[0]!.bbox.max[2] - after.bodies[0]!.bbox.min[2]).toBeCloseTo(7.5, 6);
    // Exactly what typing 7.5 mm into the variable gives: holes through, countersinks on top.
    expect(after.bodies[0]!.volume).toBeCloseTo(typed.bodies[0]!.volume, 6);
  });

  it("changes a plain distance in place", async () => {
    const d = doc([
      sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 10)),
      {
        id: "ex1",
        op: "extrude",
        profile: { sketch: "sk1" },
        extent: "blind",
        distance: 5,
        mode: "new_body",
      },
    ]);
    const { tags, params } = await topFaceTags(d);
    const cap = capDrag(d, tags, valueIn(params))!;
    expect(cap).toMatchObject({ feature: "ex1", param: null, distance: 5 });
    expect(cap.write(12.3456)).toEqual({ type: "edit_feature", id: "ex1", patch: { distance: 12.346 } });
    expect(capDrag(d, tags, valueIn(params), "in")!.write(25.4)).toEqual({
      type: "edit_feature",
      id: "ex1",
      patch: { distance: "1 in" },
    });
  });

  it("writes an inch design's variable in inches, and a unitless one as a number", () => {
    const base = doc(
      [
        sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 10)),
        {
          id: "ex1",
          op: "extrude",
          profile: { sketch: "sk1" },
          extent: "blind",
          distance: "t",
          mode: "new_body",
        },
      ],
      { t: 5 },
    );
    const v = valueIn({ t: 5 });
    expect(capDrag(base, ["ex1.end_cap"], v)!.write(6)).toEqual({ type: "set_param", name: "t", expr: 6 });
    expect(capDrag(base, ["ex1.end_cap"], v, "in")!.write(12.7)).toEqual({
      type: "set_param",
      name: "t",
      expr: "0.5 in",
    });
  });

  it("adds a new step where nothing can be changed in place", () => {
    const f = (distance: Expr, extra: object = {}) =>
      doc(
        [
          sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 20, 10)),
          {
            id: "ex1",
            op: "extrude",
            profile: { sketch: "sk1" },
            extent: "blind",
            distance,
            mode: "new_body",
            ...extra,
          },
        ],
        { t: 5 },
      );
    const v = valueIn({ t: 5 });
    expect(capDrag(f("t * 2"), ["ex1.end_cap"], v), "a formula").toBeNull();
    expect(capDrag(f(5), ["ex1.side[sk1.l1]"], v), "a side face").toBeNull();
    expect(capDrag(f(5), ["ex1.start_cap"], v), "the sketch side").toBeNull();
    expect(capDrag(f(5), ["ex1.end_cap@lp1.2"], v), "a pattern copy").toBeNull();
    expect(capDrag(f(5), ["ex1.end_cap", "ex2.end_cap"], v), "two steps share the face").toBeNull();
    expect(capDrag(f(5, { extent: "symmetric" }), ["ex1.end_cap"], v), "symmetric").toBeNull();
    expect(capDrag(f(5, { mode: "cut" }), ["ex1.end_cap"], v), "a cut").toBeNull();
    expect(capDrag(f(5, { suppressed: true }), ["ex1.end_cap"], v), "suppressed").toBeNull();
    expect(capDrag(f("5 mm"), ["ex1.end_cap"], v), "a number with mm").not.toBeNull();
  });
});
