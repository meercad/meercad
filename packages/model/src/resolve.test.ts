/**
 * Renaming a variable reaches every place a step can use it (lists, nested settings, sketch
 * dimensions), and resolving refuses counts and sizes outside what can be built.
 */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { mapFeatureExprs, resolveFeature } from "./resolve.js";

const W = "w";
/** Every string "w" in a value, with where it is. */
function where(v: unknown, path = ""): string[] {
  if (v === W) return [path];
  if (Array.isArray(v)) return v.flatMap((x, i) => where(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => where(x, `${path}.${k}`));
  return [];
}

const steps = [
  { id: "a", op: "transform", bodies: ["b"], translate: [W, W, W], rotate: { axis: { ref: "origin.Z" }, angle: W } },
  { id: "b", op: "text", plane: { ref: "origin.XY" }, text: "x", position: [W, W], size: W, angle: W, depth: W },
  { id: "c", op: "primitive", shape: "box", size: [W, W, W], center: [W, W, W] },
  { id: "d", op: "gridfinity", kind: "baseplate", units: [W, W], drawer: [W, W], position: [W, W], bed: { size: [W, W], margin: [W, W] }, height: W },
  { id: "e", op: "gridfinity", kind: "bin", units: [W, W], dividers: [W, W], cell: [W, W], pocket: { body: "x", sink: W, clearance: W }, tab: { width: W, angle: W } },
  { id: "f", op: "box", width: W, depth: W, height: W, position: [W, W] },
  { id: "g", op: "snap_hook", plane: { ref: "origin.XY" }, points: [[W, W]], length: W },
  { id: "h", op: "wall", system: "opengrid", kind: "board", units: [W, W], position: [W, W], cell: [W, W], thickness: W },
  { id: "i", op: "lithophane", image: { width: 1, height: 1, pixels: "" }, width: W, position: [W, W] },
  { id: "j", op: "label", text: "x", position: [W, W], width: W },
  { id: "k", op: "standard_part", kind: "screw", plane: { ref: "origin.XY" }, points: [[W, W]], length: W },
  { id: "l", op: "hole", kind: "simple", plane: { ref: "origin.XY" }, points: [[W, W]], diameter: W, depth: W },
  { id: "n", op: "spring", kind: "compression", wire: W, diameter: W, coils: W, length: W, center: [W, W] },
  { id: "o", op: "screw", kind: "screw", diameter: W, length: W, center: [W, W] },
  { id: "p", op: "gear", kind: "spur", module: W, teeth: W, width: W, center: [W, W], meshWith: { gear: "q", direction: W }, bore: { diameter: W, allowance: W, flat: W }, hub: { diameter: W, length: W } },
  { id: "q", op: "sketch", plane: { ref: "origin.XY" }, entities: [], constraints: [{ id: "c1", type: "length", line: "l1", value: W }, { id: "c2", type: "horizontal", line: "l1" }] },
  { id: "r", op: "extrude", profile: { sketch: "q" }, extent: "two_sided", distance: W, distance2: W, mode: "new_body" },
  { id: "s", op: "linear_pattern", source: { features: ["r"] }, direction: { ref: "origin.X" }, count: W, spacing: W, count2: W, spacing2: W },
] as unknown as Feature[];

describe("renaming a variable", () => {
  it.each(steps.map((f) => [f.op, f] as const))("reaches every use in a %s step", (_op, f) => {
    expect(where(f).length, "the test step uses the variable").toBeGreaterThan(0);
    const renamed = mapFeatureExprs(f, (e) => (e === W ? "width" : e));
    expect(where(renamed)).toEqual([]);
    // The original is left as it was.
    expect(where(f).length).toBeGreaterThan(0);
  });
});

describe("resolving refuses what cannot be built", () => {
  const scope = new Map([["n", 0]]);
  it("pattern counts between 1 and 1000", () => {
    const f = { id: "lp", op: "linear_pattern", source: { features: ["x"] }, direction: { ref: "origin.X" }, count: "n", spacing: 5 } as unknown as Feature;
    expect(() => resolveFeature(f, scope)).toThrow(/count must be between 1 and 1000/);
    expect(() => resolveFeature({ ...f, count: 1001 } as Feature, scope)).toThrow(/between 1 and 1000/);
  });
  it("gear teeth: at least 4 on a wheel, 1 on a rack", () => {
    const g = { id: "g", op: "gear", kind: "spur", module: 1, teeth: 3, width: 5, mode: "new_body" } as unknown as Feature;
    expect(() => resolveFeature(g, scope)).toThrow(/teeth: must be between 4 and 1000/);
    expect(() => resolveFeature({ ...g, kind: "rack", teeth: 1 } as Feature, scope)).not.toThrow();
  });
  it("a negative print bed margin", () => {
    const g = { id: "g", op: "gridfinity", kind: "baseplate", units: [2, 2], bed: { size: [200, 200], margin: [-1, 0] } } as unknown as Feature;
    expect(() => resolveFeature(g, scope)).toThrow(/bed.margin: must not be negative/);
  });
  it("a baseplate without units", () => {
    expect(() => resolveFeature({ id: "g", op: "gridfinity", kind: "baseplate" } as unknown as Feature, scope)).toThrow(/units: required/);
  });
  it("names the field whose formula is wrong", () => {
    expect(() => resolveFeature({ id: "d", op: "draft", faces: [], neutral: { ref: "origin.XY" }, angle: "nope" } as unknown as Feature, scope)).toThrow(/angle/);
  });
  it("resolves plain steps with their numbers", () => {
    const s = new Map([["w", 4]]);
    expect(resolveFeature({ id: "o", op: "offset_face", faces: [], distance: "w / 2" } as unknown as Feature, s)).toMatchObject({ distance: 2 });
    expect(resolveFeature({ id: "s", op: "scale", bodies: [], factor: "w" } as unknown as Feature, s)).toMatchObject({ factor: 4 });
    expect(resolveFeature({ id: "a", op: "align", bodies: [], from: {}, to: {}, offset: "w", angle: 90 } as unknown as Feature, s)).toMatchObject({ offset: 4, angle: 90 });
    expect(resolveFeature({ id: "r", op: "rib", sketch: "q", thickness: "w" } as unknown as Feature, s)).toMatchObject({ thickness: 4 });
    expect(resolveFeature({ id: "p", op: "primitive", shape: "cylinder", diameter: "w", height: "w * 2" } as unknown as Feature, s)).toMatchObject({ diameter: 4, height: 8, center: [0, 0, 0] });
    expect(resolveFeature({ id: "t", op: "text", plane: { ref: "origin.XY" }, text: "x", size: "w", depth: 1 } as unknown as Feature, s)).toMatchObject({ size: 4, position: [0, 0], angle: 0 });
    const sp = resolveFeature({ id: "sp", op: "standard_part", kind: "screw", plane: { ref: "origin.XY" }, points: [["w", 1]], length: "w * 3" } as unknown as Feature, s);
    expect(sp).toMatchObject({ points: [[4, 1]], length: 12 });
  });
});
