/** Large strings left out of what assistants read, and put back from the document. */
import { describe, expect, it } from "vitest";
import type { DocOp, Feature, MeercadDocument } from "@meercad/schema";
import { lightDocument, restoreElided } from "./elide";

const big = "A".repeat(3000);
const doc: MeercadDocument = {
  format: "meercad/1",
  params: {},
  features: [
    { id: "im1", op: "import", name: "scan", format: "stl", data: big } as unknown as Feature,
    { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 5, mode: "new_body" },
  ],
  references: [{ id: "r1", name: "photo", image: big } as never],
  rollback: null,
};

describe("lightDocument", () => {
  it("replaces long strings by their length and keeps the rest", () => {
    const light = lightDocument(doc);

    expect((light.features[0] as unknown as { data: string }).data).toBe("…elided:3000 chars…");
    expect(light.features[1]).toEqual(doc.features[1]);
    expect(light.rollback).toBeNull();
  });
});

describe("restoreElided", () => {
  const light = lightDocument(doc);
  const placeholder = (light.features[0] as unknown as { data: string }).data;

  it("puts the real values back in edits, added features, references and whole documents", () => {
    const ops = [
      { type: "edit_feature", id: "im1", patch: { name: "scan 2", data: placeholder } },
      { type: "add_features", features: [light.features[0]] },
      { type: "set_reference", reference: { id: "r1", name: "photo 2", image: placeholder } },
      { type: "replace", doc: light },
      { type: "set_param", name: "w", expr: 3 },
    ] as unknown as DocOp[];
    const [edit, add, reference, replace, other] = restoreElided(ops, doc) as unknown as Record<
      string,
      any
    >[];

    expect(edit!.patch).toEqual({ name: "scan 2", data: big });
    expect(add!.features[0].data).toBe(big);
    expect(reference!.reference).toEqual({ id: "r1", name: "photo 2", image: big });
    expect(replace!.doc.features[0].data).toBe(big);
    expect(replace!.doc.features[1]).toEqual(doc.features[1]);
    expect(other).toBe(ops[4]);
  });

  it("refuses a placeholder where the document has no string", () => {
    const op = (patch: unknown) => [{ type: "edit_feature", id: "ex1", patch } as unknown as DocOp];

    expect(() => restoreElided(op({ distance: placeholder }), doc)).toThrow(/elided value was sent back/);
    expect(() => restoreElided(op({ list: [placeholder] }), doc)).toThrow(/elided value/);
    expect(() =>
      restoreElided([{ type: "set_reference", reference: { id: "r9", image: placeholder } } as never], {
        ...doc,
        references: undefined,
      }),
    ).toThrow(/elided value/);
    expect(() =>
      restoreElided(
        [{ type: "add_features", features: [{ id: "new", data: { inner: placeholder } }] } as never],
        doc,
      ),
    ).toThrow(/elided value/);
  });
});
