/**
 * New steps from the toolbar (features.ts): every one starts as a valid document entry, those that
 * need a pick say which, and those that need none build with their defaults in the kernel. Names
 * of steps and parts as the lists show them.
 */
import { describe, expect, it } from "vitest";
import { emptyDocument, validateDocument, type Feature, type FeatureOp, type MeercadDocument } from "@meercad/schema";
import { draftFeature, draftProblem, FEATURES, featureName, isFastener, partName, sketchesUsed, TOOLBAR } from "./features";

const ops = Object.keys(FEATURES) as FeatureOp[];
const withFeatures = (features: Feature[]): MeercadDocument => ({ ...emptyDocument(), features });

describe("new steps", () => {
  it("start with a fresh id, and as valid steps where nothing is left to pick", () => {
    for (const op of ops) {
      const f = draftFeature(op, emptyDocument());
      expect(f.op, op).toBe(op);
      expect(f.id, op).toMatch(new RegExp(`^[a-z_]+1$`));
      // A draft that waits for a pick is never saved (draftProblem holds the dialog back).
      if (draftProblem(f)) continue;
      const v = validateDocument(withFeatures([f]));
      expect(v.ok ? [] : v.errors, op).toEqual([]);
    }
    expect(TOOLBAR.length).toBeGreaterThan(20);
  });

  it("say what to pick, and nothing more once it is picked", () => {
    const need = ops.filter((op) => draftProblem(draftFeature(op, emptyDocument())) !== null);
    expect(need.sort()).toEqual(
      ["align", "bend", "boolean", "chamfer", "circular_pattern", "coil", "delete", "draft", "extrude", "fillet", "hole", "import", "linear_pattern", "lithophane", "loft", "mesh_convert", "mirror", "offset_face", "revolve", "rib", "scale", "shell", "snap_hook", "standard_part", "sweep", "thread", "transform"].sort(),
    );
    const filled: Partial<Record<FeatureOp, Partial<Feature>>> = {
      extrude: { profile: { sketch: "sk1" } } as Partial<Feature>,
      fillet: { edges: [{ edge: ["a", "b"] }] } as Partial<Feature>,
      shell: { faces: [{ face: "x" }] } as Partial<Feature>,
      boolean: { target: "a", tools: [] } as Partial<Feature>,
      sweep: { profile: { sketch: "s" }, path: { sketch: "" } } as Partial<Feature>,
      align: { from: { face: { face: "a" } }, to: { face: { face: "" } } } as Partial<Feature>,
    };
    expect(draftProblem({ ...draftFeature("extrude", emptyDocument()), ...filled.extrude } as Feature)).toBeNull();
    expect(draftProblem({ ...draftFeature("fillet", emptyDocument()), ...filled.fillet } as Feature)).toBeNull();
    expect(draftProblem({ ...draftFeature("shell", emptyDocument()), ...filled.shell } as Feature)).toBeNull();
    expect(draftProblem({ ...draftFeature("boolean", emptyDocument()), ...filled.boolean } as Feature)).toBe("Select tool bodies");
    expect(draftProblem({ ...draftFeature("sweep", emptyDocument()), ...filled.sweep } as Feature)).toBe("Pick the path: lines and arcs of a sketch");
    expect(draftProblem({ ...draftFeature("align", emptyDocument()), ...filled.align } as Feature)).toBe("Pick the face to set it onto");
    expect(draftProblem({ id: "g1", op: "gridfinity", kind: "bin", pocket: { body: "" } } as unknown as Feature)).toBe("Pick the part the bin should hold");
  });

  it("follow the last sketch and the steps already there", () => {
    const sk = draftFeature("sketch", emptyDocument());
    const doc = withFeatures([sk]);
    expect(draftFeature("extrude", doc)).toMatchObject({ id: "ex1", profile: { sketch: sk.id }, mode: "new_body" });
    expect(draftFeature("rib", doc)).toMatchObject({ sketch: sk.id });
    const used = withFeatures([sk, { ...draftFeature("extrude", doc), profile: { sketch: sk.id } } as Feature]);
    expect(sketchesUsed(used.features)).toEqual(new Set([sk.id]));
    expect(draftFeature("extrude", used)).toMatchObject({ id: "ex2", profile: { sketch: "" }, mode: "join" });
    expect(draftFeature("primitive", used)).toMatchObject({ mode: "join" });
    // A bin goes into the last baseplate, into the first free cell.
    const plate = { id: "gf1", op: "gridfinity", kind: "baseplate", units: [2, 1] } as Feature;
    const bin1 = draftFeature("gridfinity", withFeatures([plate]));
    expect(bin1).toMatchObject({ kind: "bin", baseplate: "gf1", cell: [0, 0] });
    expect(draftFeature("gridfinity", withFeatures([plate, bin1]))).toMatchObject({ cell: [1, 0] });
    const board = { id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [2, 2] } as Feature;
    const holder = draftFeature("wall", withFeatures([board]));
    expect(holder).toMatchObject({ kind: "holder", board: "wl1", cell: [0, 1] });
    expect(draftFeature("wall", withFeatures([board, holder]))).toMatchObject({ cell: [1, 1] });
  });
});

describe("names in the lists", () => {
  const features = [
    { id: "ex1", op: "extrude" },
    { id: "lp1", op: "linear_pattern" },
    { id: "sp1", op: "standard_part", kind: "socket_screw", size: "M3", length: 12 },
    { id: "ho1", op: "hole", kind: "insert", size: "M3" },
    { id: "bx1", op: "box", width: 80, depth: 60, height: 40 },
    { id: "gf1", op: "gridfinity", kind: "bin", units: [2, 1], height: 3 },
    { id: "wl1", op: "wall", system: "pegboard", kind: "board", units: [6, 4] },
    { id: "lb1", op: "label", text: "M3×10\nsecond line" },
    { id: "jar", op: "box", lid: "screw", width: 60, height: 50 },
  ] as unknown as Feature[];

  it("names steps by what they make", () => {
    expect(features.map(featureName)).toEqual(["Extrude 1", "Linear pattern 1", expect.stringMatching(/M3×12/), "Hole 1", "Box 80×60×40", "Bin 2×1×3", "Pegboard 6×4", "Label M3×10", "Jar ⌀60×50"]);
    expect(featureName({ id: "x", op: "extrude", name: "Base" } as Feature)).toBe("Base");
    // An id without a number (as assistants often choose) names the part, so two do not read alike.
    expect(featureName({ id: "base", op: "extrude" } as Feature)).toBe("Extrude base");
    expect(featureName({ id: "lid", op: "extrude" } as Feature)).toBe("Extrude lid");
  });

  it("names parts, copies and inserts", () => {
    expect(partName("ex1", features)).toBe("Extrude 1");
    expect(partName("lp1_2", features)).toBe("Linear pattern 1 (2)");
    expect(partName("lp1_ex1_3", features)).toBe("Linear pattern 1 (Extrude 1 3)");
    expect(partName("ho1_insert_2", features)).toMatch(/insert \(2\)$/);
    expect(partName("bx1_lid", features)).toBe("Lid of Box 80×60×40");
    expect(partName("zz", features)).toBe("zz");
  });

  it("tells fasteners from other parts, copies too", () => {
    expect(isFastener("sp1", features)).toBe(true);
    expect(isFastener("ho1_insert", features)).toBe(true);
    expect(isFastener("ex1", features)).toBe(false);
    expect(isFastener("lp1_sp1_2", [...features])).toBe(true);
    expect(isFastener("zz", features)).toBe(false);
  });
});
