import { describe, expect, it } from "vitest";
import { emptyDocument, type MeercadDocument } from "@meercad/schema";
import { restored, snapshot, versionChanges } from "./versions.js";

describe("reference models in versions", () => {
  it("keeps a large reference model once in blobs and restores it", () => {
    const data = "A".repeat(10_000);
    const doc: MeercadDocument = { ...emptyDocument(), references: [{ id: "rf1", name: "Field", format: "glb", data }] };
    const blobs: Record<string, string> = {};
    const v = snapshot(doc, "one", 0, blobs);
    expect(v.state.references![0]!.data).toMatch(/^blob:/);
    expect(Object.values(blobs)).toEqual([data]);
    const back = restored({ ...doc, versions: [v], blobs }, v);
    expect(back.references![0]!.data).toBe(data);
    expect(versionChanges(v.state, doc).other).toBe(false);
  });
});
