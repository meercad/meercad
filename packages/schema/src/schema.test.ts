import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { validateDocument, validateOp } from "./index.js";

const corpus = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/corpus/${name}`, import.meta.url), "utf8")) as unknown;

describe("validateDocument", () => {
  it("accepts the reference box", () => {
    const r = validateDocument(corpus("box-fillet.ocad.json"));
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it("rejects unknown properties and ops with readable messages", () => {
    const r = validateDocument({
      format: "opencad/1",
      params: {},
      features: [{ id: "x", op: "loft" }, { id: "e", op: "extrude", profile: { ref: "a.b.region" }, distance: 1, mode: "new_body", color: "red" }],
      rollback: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join("\n")).toContain("allowed values");
      expect(r.errors.join("\n")).toContain("(color)");
    }
  });

  it("rejects dangling references", () => {
    const r = validateDocument({
      format: "opencad/1",
      params: {},
      features: [{ id: "ex1", op: "extrude", profile: { ref: "sk1.r1.region" }, distance: 1, mode: "new_body" }],
      rollback: "nope",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors).toHaveLength(2);
  });
});

describe("validateOp", () => {
  it("validates set_param and rejects junk", () => {
    expect(validateOp({ type: "set_param", name: "h", expr: "12 mm" }).ok).toBe(true);
    expect(validateOp({ type: "set_param", name: "1h", expr: 1 }).ok).toBe(false);
    expect(validateOp({ type: "explode" }).ok).toBe(false);
  });
});
