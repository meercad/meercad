import { describe, expect, it } from "vitest";
import { applyOp, effectiveParams } from "@meercad/model";
import { validateDocument, type Feature } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** A 10 × 10 block as tall as `width`; `depth` is a second parameter for the variants to set. */
const block = (): ReturnType<typeof doc> =>
  doc([sketch("sk1", { ref: "origin.XY" }, rect("a", 0, 0, 10, 10)), { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: "width", mode: "new_body" } as Feature], { width: 20, depth: 10 });

describe("variants", () => {
  it("builds the variant in use, and the plain values without one", async () => {
    const s = await newSession();
    let d = block();
    d = applyOp(d, { type: "set_variant", name: "Small", params: { width: 10 } });
    d = applyOp(d, { type: "set_variant", name: "Large", params: { width: 40, depth: "width / 2" } });
    const volume = () => s.rebuild(d).report.bodies[0]!.volume;
    expect(volume()).toBeCloseTo(2000, 3);
    d = applyOp(d, { type: "use_variant", name: "Small" });
    expect(volume()).toBeCloseTo(1000, 3);
    d = applyOp(d, { type: "use_variant", name: "Large" });
    expect(volume()).toBeCloseTo(4000, 3);
    expect(effectiveParams(d)).toEqual({ fit: 0.2, width: 40, depth: "width / 2" });
    d = applyOp(d, { type: "use_variant", name: null });
    expect(volume()).toBeCloseTo(2000, 3);
  });

  it("keeps variants in step with renamed and deleted parameters", () => {
    let d = block();
    d = applyOp(d, { type: "set_variant", name: "A", params: { width: 12, depth: "width + 1" } });
    d = applyOp(d, { type: "rename_param", name: "width", to: "breite" });
    expect(d.variants![0]!.params).toEqual({ breite: 12, depth: "breite + 1" });
    d = applyOp(d, { type: "set_param", name: "depth", expr: null });
    expect(d.variants![0]!.params).toEqual({ breite: 12 });
  });

  it("renames and deletes variants, and refuses what does not exist", () => {
    let d = block();
    d = applyOp(d, { type: "set_variant", name: "A", params: { width: 12 } });
    d = applyOp(d, { type: "use_variant", name: "A" });
    d = applyOp(d, { type: "set_variant", name: "A", params: { width: 14 }, rename: "M8" });
    expect(d.variant).toBe("M8");
    expect(d.variants).toEqual([{ name: "M8", params: { width: 14 } }]);
    expect(() => applyOp(d, { type: "use_variant", name: "nope" })).toThrow(/unknown variant/);
    expect(() => applyOp(d, { type: "set_variant", name: "B", params: { height: 3 } })).toThrow(/unknown parameter "height"/);
    d = applyOp(d, { type: "delete_variant", name: "M8" });
    expect(d.variants).toBeUndefined();
    expect(d.variant).toBeUndefined();
  });

  it("checks variants in the document", () => {
    const d = { ...block(), variants: [{ name: "A", params: { width: 1 } }, { name: "A", params: {} }], variant: "B" };
    const v = validateDocument(d);
    expect(v.ok).toBe(false);
    expect(v.ok ? [] : v.errors.join("; ")).toMatch(/duplicate name.*in use but not defined|in use but not defined.*duplicate/s);
  });
});
