import { describe, expect, it } from "vitest";
import { validateDocument, withoutRemovedFeatures, type Feature, type MeercadDocument } from "@meercad/schema";
import { doc, newSession, rect, sketch } from "./helpers.js";

/** An open 60 × 40 × 30 box with 2 mm walls. */
const box: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", -30, -20, 60, 40)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 30, mode: "new_body" },
  { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 },
];
/** The surface texture step earlier versions wrote; meerCAD no longer has it. */
const oldTexture = { id: "st1", op: "texture", name: "Ribs", faces: [{ face: "ex1.side[*]" }], pattern: "ribs", depth: 0.8, pitch: 4 } as unknown as Feature;
/** A design from an earlier version: the texture, then a step after it. */
const oldDesign = (rollback: string | null = null): MeercadDocument => ({
  ...doc([...box, oldTexture, { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }], radius: 3 }]),
  rollback,
});

describe("files with the removed surface texture", () => {
  it("open without it: the step is left out, the rest stays", () => {
    const v = validateDocument(JSON.parse(JSON.stringify(oldDesign())));
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.features.map((f) => f.id)).toEqual(["sk1", "ex1", "sh1", "fi1"]);
  });

  it("a rollback to it moves to the step before", () => {
    expect(withoutRemovedFeatures(oldDesign("st1"))).toMatchObject({ removed: ["st1"], doc: { rollback: "sh1" } });
    expect(withoutRemovedFeatures(oldDesign("fi1")).doc.rollback).toBe("fi1");
    // A design without one comes back as it was.
    const plain = doc(box);
    expect(withoutRemovedFeatures(plain)).toEqual({ doc: plain, removed: [] });
  });

  it("rebuild smooth and without an error, even when the step reaches the kernel", async () => {
    const plain = (await newSession()).rebuild(doc([...box, { id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }], radius: 3 }]));
    const r = (await newSession()).rebuild(oldDesign());
    expect(r.report.features.filter((f) => f.status !== "ok").map((f) => `${f.id}: ${f.message}`)).toEqual([]);
    expect(r.report.features.map((f) => f.id)).toEqual(["sk1", "ex1", "sh1", "fi1"]);
    expect(r.report.bodies[0]!.volume).toBeCloseTo(plain.report.bodies[0]!.volume, 6);
    expect(r.meshes[0]!.textured).toBeFalsy();
    expect(r.meshes[0]!.indices.length).toBe(plain.meshes[0]!.indices.length);
  }, 120_000);
});
