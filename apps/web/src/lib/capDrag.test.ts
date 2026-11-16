/** What dragging an extrusion's end face changes in place. */
import { describe, expect, it } from "vitest";
import type { Expr, Feature, MeercadDocument } from "@meercad/schema";
import { capDrag } from "./capDrag";

const extrude = (id: string, distance: Expr, more: Partial<Feature> = {}): Feature =>
  ({
    id,
    op: "extrude",
    profile: { sketch: "sk1" },
    extent: "blind",
    distance,
    mode: "new_body",
    ...more,
  }) as Feature;

const doc = (features: Feature[], params: Record<string, Expr> = {}): MeercadDocument => ({
  format: "meercad/1",
  params,
  features,
  rollback: null,
});

/** Numbers as they are; variables looked up in a small table; anything else fails. */
const value = (expr: Expr) => {
  if (typeof expr === "number") return expr;

  const table: Record<string, number> = { thickness: 5, plate: 4, "12 mm": 12, "wall * 2": 6, size: 25.4 };
  if (expr.trim() in table) return table[expr.trim()]!;

  throw new Error(`cannot evaluate ${expr}`);
};

describe("capDrag", () => {
  it("changes a plain distance in place, in mm or inches", () => {
    const drag = capDrag(doc([extrude("ex1", 5)]), ["ex1.end_cap", "ex1.side"], value)!;

    expect(drag).toMatchObject({ feature: "ex1", param: null, distance: 5 });
    expect(drag.write(7.12345)).toEqual({ type: "edit_feature", id: "ex1", patch: { distance: 7.123 } });

    const inch = capDrag(doc([extrude("ex1", "12 mm")]), ["ex1.end_cap"], value, "in")!;

    expect(inch.distance).toBe(12);
    expect(inch.write(25.4)).toEqual({ type: "edit_feature", id: "ex1", patch: { distance: "1 in" } });
  });

  it("changes the variable a distance is, keeping its way of writing", () => {
    const design = doc([extrude("ex1", " thickness "), extrude("ex2", "plate"), extrude("ex3", "size")], {
      thickness: "5 mm",
      plate: 4,
      size: "1 in",
    });
    const mm = capDrag(design, ["ex1.end_cap"], value)!;

    expect(mm).toMatchObject({ param: "thickness", distance: 5 });
    expect(mm.write(6)).toEqual({ type: "set_param", name: "thickness", expr: "6 mm" });
    expect(capDrag(design, ["ex2.end_cap"], value)!.write(4.5)).toEqual({
      type: "set_param",
      name: "plate",
      expr: 4.5,
    });
    expect(capDrag(design, ["ex3.end_cap"], value, "in")!.write(50.8)).toEqual({
      type: "set_param",
      name: "size",
      expr: "2 in",
    });
  });

  it("adds a step instead where nothing can change in place", () => {
    const tags = ["ex1.end_cap"];

    // Not exactly one end face (a copy's face does not count).
    expect(capDrag(doc([extrude("ex1", 5)]), ["ex1.end_cap@lp1.2"], value)).toBeNull();
    expect(
      capDrag(doc([extrude("ex1", 5), extrude("ex2", 5)]), ["ex1.end_cap", "ex2.end_cap"], value),
    ).toBeNull();
    // Not a blind, active extrusion that makes or adds to a body.
    expect(capDrag(doc([]), tags, value)).toBeNull();
    expect(capDrag(doc([{ ...extrude("ex1", 5), op: "revolve" } as Feature]), tags, value)).toBeNull();
    expect(
      capDrag(doc([extrude("ex1", 5, { extent: "through_all" } as Partial<Feature>)]), tags, value),
    ).toBeNull();
    expect(capDrag(doc([extrude("ex1", 5, { suppressed: true })]), tags, value)).toBeNull();
    expect(capDrag(doc([extrude("ex1", 5, { mode: "cut" } as Partial<Feature>)]), tags, value)).toBeNull();
    expect(
      capDrag(doc([extrude("ex1", 5, { mode: "join" } as Partial<Feature>)]), tags, value),
    ).not.toBeNull();
    // A distance that cannot be evaluated, or a formula.
    expect(capDrag(doc([extrude("ex1", "nonsense")]), tags, value)).toBeNull();
    expect(capDrag(doc([extrude("ex1", "wall * 2")]), tags, value)).toBeNull();
  });
});
