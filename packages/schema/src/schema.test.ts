import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateDocument, validateOp } from "./index.js";

const corpus = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/corpus/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;

describe("validateDocument", () => {
  it("accepts the reference box", () => {
    const r = validateDocument(corpus("box-fillet.meercad.json"));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("reads files saved before the rename (leocad/1) as the current format", () => {
    const r = validateDocument({ ...corpus("box-fillet.meercad.json"), format: "leocad/1" });
    expect(r.ok ? r.value.format : r.errors).toBe("meercad/1");
  });

  it("rejects unknown properties and ops with readable messages", () => {
    const r = validateDocument({
      format: "meercad/1",
      params: {},
      features: [{ id: "x", op: "loft" }, { id: "e", op: "extrude", profile: { sketch: "x" }, extent: "blind", distance: 1, mode: "new_body", color: "red" }],
      rollback: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("allowed values");
      expect(r.errors.join("\n")).toContain("(color)");
    }
  });

  it("rejects dangling references inside sketches and between features", () => {
    const doc = corpus("box-fillet.meercad.json") as { features: Record<string, unknown>[]; rollback: unknown };
    const sk = doc.features[0] as { constraints: unknown[]; entities: unknown[] };
    sk.constraints.push({ id: "c9", type: "length", line: "l9", value: 1 });
    sk.entities.push({ id: "l5", type: "line", p1: "p1", p2: "nope" });
    doc.features[1] = { ...doc.features[1], profile: { sketch: "sk9" } };
    doc.rollback = "nope";
    const r = validateDocument(doc);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(4);
  });
});

describe("validateOp", () => {
  it("validates set_param and rejects junk", () => {
    expect(validateOp({ type: "set_param", name: "h", expr: "12 mm" }).ok).toBe(true);
    expect(validateOp({ type: "set_param", name: "1h", expr: 1 }).ok).toBe(false);
    expect(validateOp({ type: "move_feature", id: "a", after: null }).ok).toBe(true);
    expect(validateOp({ type: "explode" }).ok).toBe(false);
  });
});
