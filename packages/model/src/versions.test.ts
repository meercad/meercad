import { describe, expect, it } from "vitest";
import { emptyDocument, validateDocument, type MeercadDocument } from "@meercad/schema";
import { applyOp } from "./store.js";
import { freeVersionName, restored, snapshot, versionChanges, versionFile } from "./versions.js";

describe("reference models in versions", () => {
  it("keeps a large reference model once in blobs and restores it", () => {
    const data = "A".repeat(10_000);
    const doc: MeercadDocument = {
      ...emptyDocument(),
      references: [{ id: "rf1", name: "Field", format: "glb", data }],
    };
    const blobs: Record<string, string> = {};
    const v = snapshot(doc, "one", 0, blobs);
    expect(v.state.references![0]!.data).toMatch(/^blob:/);
    expect(Object.values(blobs)).toEqual([data]);

    const back = restored({ ...doc, versions: [v], blobs }, v);
    expect(back.references![0]!.data).toBe(data);
    expect(versionChanges(v.state, doc).other).toBe(false);
  });
});

describe("versions as backup files", () => {
  const big = "B".repeat(10_000);
  const design = (): MeercadDocument => ({
    ...emptyDocument(),
    params: { w: "10 mm" },
    features: [{ id: "import1", op: "import", format: "stl", fileName: "part.stl", data: big }],
  });

  it("writes a version as a project of its own, imports filled in, other versions left out", () => {
    let doc = applyOp(design(), { type: "save_version", name: "first" });
    doc = applyOp(applyOp(doc, { type: "set_param", name: "w", expr: "20 mm" }), {
      type: "save_version",
      name: "second",
    });

    const file = versionFile(doc, "first");
    expect(file.versions).toBeUndefined();
    expect(file.blobs).toBeUndefined();
    expect(file.params["w"]).toBe("10 mm");
    expect(file.features[0]).toMatchObject({ op: "import", data: big });
    expect(validateDocument(JSON.parse(JSON.stringify(file))).ok).toBe(true);
    expect(() => versionFile(doc, "none")).toThrow(/unknown version/);
  });

  it("brings a backup file back in as a version, leaving the design as it is", () => {
    const doc = applyOp(design(), { type: "save_version", name: "first" });
    const file = versionFile(doc, "first");
    const now = applyOp(applyOp(doc, { type: "set_param", name: "w", expr: "30 mm" }), {
      type: "delete_version",
      name: "first",
    });
    const back = applyOp(now, {
      type: "save_version",
      name: "from file",
      doc: { ...file, versions: doc.versions!, blobs: doc.blobs! },
      at: 1234,
    });
    expect(back.params["w"]).toBe("30 mm");
    expect(back.versions!.map((v) => [v.name, v.at])).toEqual([["from file", 1234]]);
    expect(applyOp(back, { type: "restore_version", name: "from file" }).params["w"]).toBe("10 mm");
    // The scan is kept once, as a blob.
    expect(Object.values(back.blobs!)).toEqual([big]);
  });

  it("refuses a file that is not a valid design", () => {
    expect(() =>
      applyOp(design(), {
        type: "save_version",
        name: "x",
        doc: { features: "no" } as unknown as MeercadDocument,
      }),
    ).toThrow();
  });

  it("finds a free name", () => {
    const doc = applyOp(applyOp(design(), { type: "save_version", name: "a" }), {
      type: "save_version",
      name: "a (2)",
    });
    expect(freeVersionName(doc, "a")).toBe("a (3)");
    expect(freeVersionName(doc, "b")).toBe("b");
  });
});
