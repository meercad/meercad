/** Sharing a design: what goes into the shared file, and which premium packs a design uses. */
import { describe, expect, it } from "vitest";
import { emptyDocument, validateDocument, type Feature, type MeercadDocument } from "@meercad/schema";
import { featurePack, packsUsed, sharedDoc } from "../apps/web/src/lib/packUse";

const gear = { id: "ge1", op: "gear" } as unknown as Feature;
const box = { id: "bx1", op: "box", lid: "snap", width: 80, depth: 60, height: 40 } as unknown as Feature;

describe("packs a design uses", () => {
  it("finds none in a plain design", () => {
    expect(packsUsed({ ...emptyDocument(), features: [box] })).toEqual([]);
  });

  it("names gears, springs, joints, variants, versions and terrain models", () => {
    const doc = {
      ...emptyDocument(),
      features: [box, gear, { id: "sp1", op: "spring" } as unknown as Feature],
      mechanism: {
        joints: [
          { id: "j1", type: "revolute", a: "ge1", b: "ground", anchor: { axis: { ref: "origin.Z" } } },
        ],
      },
      variants: [{ name: "Small", params: {} }],
      versions: [{ name: "v1", at: 0, state: { params: {}, features: [], rollback: null } }],
      references: [{ id: "rf1", name: "Park", format: "glb", data: "" }],
    } as unknown as MeercadDocument;
    expect(packsUsed(doc)).toEqual([
      { pack: "mechanics", what: ["gears", "springs", "joints"] },
      { pack: "scan", what: ["terrain models"] },
      { pack: "versions", what: ["variants", "saved versions"] },
    ]);
  });

  it("locks only the features a pack makes", () => {
    expect(featurePack(gear)).toBe("mechanics");
    expect(featurePack({ op: "spring" })).toBe("mechanics");
    expect(featurePack(box)).toBeNull();
  });
});

describe("the shared file", () => {
  const withVersions = {
    ...emptyDocument(),
    params: { width: "60 mm" },
    features: [box],
    variants: [{ name: "Small", params: { width: "40 mm" } }],
    versions: [{ name: "v1", at: 1, state: { params: {}, features: [], rollback: null } }],
    blobs: { "blob:x": "AAAA" },
  } as unknown as MeercadDocument;

  it("keeps the whole history and the variants, but leaves the saved versions out unless asked", () => {
    const out = sharedDoc(withVersions);
    expect(out.versions).toBeUndefined();
    expect(out.blobs).toBeUndefined();
    expect(out.features).toEqual(withVersions.features);
    expect(out.params).toEqual(withVersions.params);
    expect(out.variants).toEqual(withVersions.variants);
    expect(sharedDoc(withVersions, { versions: true })).toBe(withVersions);
  });

  it("is a valid meerCAD file either way", () => {
    expect(validateDocument(JSON.parse(JSON.stringify(sharedDoc(withVersions)))).ok).toBe(true);
    expect(validateDocument(JSON.parse(JSON.stringify(sharedDoc(withVersions, { versions: true })))).ok).toBe(
      true,
    );
  });

  it("leaves a design without versions as it is", () => {
    const plain = { ...emptyDocument(), features: [box] };
    expect(sharedDoc(plain)).toBe(plain);
  });
});
