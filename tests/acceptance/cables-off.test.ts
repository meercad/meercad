import { describe, expect, it } from "vitest";
import { applyOp, OpError } from "@meercad/model";
import { CABLES_ENABLED, validateDocument, type Feature, type MeercadDocument } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** A block with a cable fixed to it, as designs made while cables were offered hold them. */
const block: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", -30, -20, 60, 40)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const cab: Feature = { id: "cab1", op: "cable", points: [{ at: [0, 0, 10], on: "ex1" }, { at: [60, 0, 30] }], diameter: 2 };
const withCable = (): MeercadDocument => doc([...block, cab]);

describe.skipIf(CABLES_ENABLED)("designs with cables while cables are switched off", () => {
  it("open and keep their cable steps unchanged", () => {
    const v = validateDocument(JSON.parse(JSON.stringify(withCable())));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.features.find((f) => f.id === "cab1")).toEqual(cab);
  });

  it("build without the cable and without errors", async () => {
    const s = await newSession();
    const { report } = s.rebuild(withCable());
    expect(report.features.filter((f) => f.status === "error")).toEqual([]);
    expect(report.features.find((f) => f.id === "cab1")?.status).toBe("suppressed");
    expect(report.bodies.map((b) => b.id)).toEqual(["ex1"]);
  });

  it("keep the cable when other steps change, and refuse new or changed cables", () => {
    const d = withCable();
    const next = applyOp(d, { type: "edit_feature", id: "ex1", patch: { distance: 12 } });
    expect(next.features.find((f) => f.id === "cab1")).toEqual(cab);
    expect(() => applyOp(doc(block), { type: "add_features", features: [cab] })).toThrow(OpError);
    expect(() => applyOp(d, { type: "edit_feature", id: "cab1", patch: { diameter: 3 } })).toThrow(OpError);
    expect(applyOp(d, { type: "delete_feature", id: "cab1" }).features.map((f) => f.id)).toEqual(["sk1", "ex1"]);
  });
});
