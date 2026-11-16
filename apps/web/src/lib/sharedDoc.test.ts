/** What a shared document holds. */
import { describe, expect, it } from "vitest";
import type { MeercadDocument } from "@meercad/schema";
import { sharedDoc } from "./sharedDoc";

const base: MeercadDocument = { format: "meercad/1", params: { w: 3 }, features: [], rollback: null };

describe("sharedDoc", () => {
  it("leaves saved versions out unless asked", () => {
    const withVersions = { ...base, versions: [{}], blobs: {} } as unknown as MeercadDocument;

    expect(sharedDoc(withVersions)).toEqual(base);
    expect(sharedDoc({ ...base, blobs: {} } as unknown as MeercadDocument)).toEqual(base);
    expect(sharedDoc(withVersions, { versions: true })).toBe(withVersions);
    expect(sharedDoc(base)).toBe(base);
  });
});
