/** Sharing a design: what goes into the shared file. */
import { describe, expect, it } from "vitest";
import { emptyDocument, validateDocument, type Feature, type MeercadDocument } from "@meercad/schema";
import { sharedDoc } from "../apps/web/src/lib/sharedDoc";

const box = { id: "bx1", op: "box", lid: "snap", width: 80, depth: 60, height: 40 } as unknown as Feature;

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
