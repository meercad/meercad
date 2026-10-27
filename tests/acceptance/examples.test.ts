import { describe, expect, it } from "vitest";
import { validateDocument } from "@meercad/schema";
import { EXAMPLES } from "../../apps/web/src/lib/examples.js";
import { newSession, withParams } from "./helpers.js";

describe("home-screen examples", () => {
  it.each(EXAMPLES.map((e) => [e.name, e] as const))("%s validates, is fully defined and rebuilds", async (_, ex) => {
    expect(validateDocument(ex.doc).ok).toBe(true);
    const { report } = (await newSession()).rebuild(ex.doc);
    expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    for (const s of report.sketches) expect(s.diagnostics.dof, `${s.id} DOF`).toBe(0);
    expect(report.bodies).toHaveLength(1);
  });

  it("mounting plate survives parameter changes", async () => {
    const s = await newSession();
    const ex = EXAMPLES[0]!.doc;
    for (const p of [{ width: "90 mm" }, { depth: "30 mm", hole: "3 mm" }, { thickness: "8 mm", corner: "2 mm" }] as Record<string, string>[]) {
      const { report } = s.rebuild(withParams(ex, p));
      expect(report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    }
  });
});
