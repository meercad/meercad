import { describe, expect, it } from "vitest";
import { validateDocument } from "@meercad/schema";
import { applyOp, DEFAULT_FIT, effectiveParams, fitTestDocument, FIT_TEST_STEPS, OpError, resolveParams } from "@meercad/model";
import { doc, newSession } from "./helpers.js";

const failures = (r: { features: { id: string; status: string; message?: string }[] }) => r.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`);

describe("fit (Spiel)", () => {
  it("is there by name in every expression, default 0.2 mm", () => {
    expect(resolveParams(effectiveParams(doc([]))).values.get("fit")).toBe(DEFAULT_FIT);
    const d = { ...doc([], { shaft: "8 mm", bore: "shaft + 2 * fit" }), fit: "0.15 mm" };
    expect(resolveParams(effectiveParams(d)).values.get("bore")).toBeCloseTo(8.3, 9);
  });

  it("an own variable called fit from before keeps its value", () => {
    expect(resolveParams(effectiveParams({ ...doc([], { fit: "1 mm" }), fit: 0.3 })).values.get("fit")).toBe(1);
  });

  it("set_fit stores and clears it; fit cannot become an own variable", () => {
    const d = applyOp(doc([]), { type: "set_fit", fit: "0.25 mm" });
    expect(d.fit).toBe("0.25 mm");
    expect(validateDocument(d).ok).toBe(true);
    expect(applyOp(d, { type: "set_fit", fit: null }).fit).toBeUndefined();
    expect(() => applyOp(d, { type: "set_param", name: "fit", expr: 1 })).toThrow(OpError);
    expect(() => applyOp(applyOp(d, { type: "set_param", name: "gap", expr: 1 }), { type: "rename_param", name: "gap", to: "fit" })).toThrow(OpError);
  });

  it("renaming a variable the fit uses renames it in the fit too", () => {
    let d = applyOp(doc([]), { type: "set_param", name: "nozzle", expr: "0.4 mm" });
    d = applyOp(d, { type: "set_fit", fit: "nozzle / 2" });
    expect(applyOp(d, { type: "rename_param", name: "nozzle", to: "noz" }).fit).toBe("noz / 2");
  });

  it("the test part builds: a plate with a labelled hole per gap and a pin", async () => {
    const d = fitTestDocument();
    expect(validateDocument(d).ok).toBe(true);
    const session = await newSession();
    const { report } = session.rebuild(d);
    expect(failures(report)).toEqual([]);
    expect(report.bodies).toHaveLength(2);
    for (const s of report.sketches) expect(s.diagnostics.dof, `${s.id} DOF`).toBe(0);
    expect(d.features.filter((f) => f.op === "hole")).toHaveLength(FIT_TEST_STEPS.length);
    // The holes go through the plate inside its outline: the plate weighs less than the plain block.
    const plate = report.bodies.find((b) => b.id === "ex1")!;
    expect(plate.bbox.max[0] - plate.bbox.min[0]).toBeCloseTo(64, 3);
    expect(plate.bbox.max[2] - plate.bbox.min[2]).toBeCloseTo(5, 3);
    const holes = FIT_TEST_STEPS.reduce((v, g) => v + Math.PI * (4 + g) ** 2 * 5, 0);
    const vol = session.bodyProps().find((b) => b.id === "ex1")!.volume;
    // Plain block minus the eight holes, minus a little for the engraved numbers.
    expect(64 * 40 * 5 - holes - vol).toBeGreaterThan(5);
    expect(64 * 40 * 5 - holes - vol).toBeLessThan(150);
    // The pin is the pin, chamfered at both ends.
    const pin = report.bodies.find((b) => b.id === "ex2")!.bbox;
    expect(pin.max[0] - pin.min[0]).toBeCloseTo(8, 3);
    expect(pin.max[2] - pin.min[2]).toBeCloseTo(14, 3);
  });
});
