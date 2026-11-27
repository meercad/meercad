/** What the 3D view shows of a rebuild, the joint symbols, and which feature a pick opens. */
import { describe, expect, it } from "vitest";
import type { RebuildOutput } from "@meercad/kernel/client";
import type { Feature, Joint } from "@meercad/schema";
import type { Pick } from "@meercad/viewport";
import { CUSTOM_PLANE_COLOR } from "../PlaneChooser";
import { EMPTY_SCENE, featureOfPick, ghostOpacity, jointGlyphsFor, ORIGIN_FRAMES, sceneFor } from "./scene";

const frame = ORIGIN_FRAMES["origin.XY"]!;
const sketchView = (id: string) => ({
  id,
  frame,
  curves: [],
  regions: [{ key: "r1", polygons: [], depth: 1, area: 1, sample: [0, 0] }],
});
const mesh = (bodyId: string, faceTags: string[][]) => ({
  bodyId,
  faceTags,
  edgeLines: new Float32Array(6),
  edgeRanges: new Int32Array([0, 2, 0]),
});

const features = [
  { id: "sk1", op: "sketch" },
  { id: "sk2", op: "sketch" },
  { id: "sk3", op: "sketch" },
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" } },
  { id: "im1", op: "import", format: "stl" },
  { id: "pl1", op: "plane", name: "Shelf" },
  { id: "fi1", op: "fillet" },
] as unknown as Feature[];

const output = {
  meshes: [
    mesh("ex1", [["ex1.side"]]),
    mesh("im1", [["im1.f1"]]),
    { ...mesh("im2", [["im1.f2"]]), edgeRanges: new Int32Array() },
  ],
  references: [],
  report: {
    bodies: [{ id: "ex1", bbox: { min: [-200, 0, 0], max: [10, 10, 10] } }],
    sketches: [sketchView("sk1"), sketchView("sk2"), sketchView("sk3")],
    planes: [
      { id: "pl1", frame },
      { id: "pl2", frame },
    ],
  },
} as unknown as RebuildOutput;

describe("sceneFor", () => {
  it("shows unused sketches, the planes sized to the model and mesh parts without edges", () => {
    const scene = sceneFor(output, { features, seeThrough: ["im1"] }, new Set(["sk3"]), null, "");

    expect(scene.sketches.map((s) => s.id)).toEqual(["sk2"]);
    expect(scene.sketches[0]!.regions).toEqual([{ key: "r1", polygons: [] }]);
    expect(scene.planes.map((p) => [p.id, p.label, p.size])).toEqual([
      ["origin.XY", expect.any(String), 120],
      ["origin.XZ", expect.any(String), 120],
      ["origin.YZ", expect.any(String), 120],
      ["pl1", "Shelf", 120],
      ["pl2", "pl2", 120],
    ]);
    expect(scene.planes[3]!.color).toBe(CUSTOM_PLANE_COLOR);
    expect(scene.bodies[0]!.edgeRanges.length).toBe(3);
    expect(scene.bodies[1]!.edgeRanges.length).toBe(0);
    expect(scene.bodies[2]).toBe(output.meshes[2]);
    expect([...scene.ghostBodies!]).toEqual(["im1"]);
    expect(scene.ghostOpacity).toBeUndefined();
  });

  it("draws a see-through part as solid as its amount says", () => {
    const scene = sceneFor(
      output,
      { features, seeThrough: ["im1", "ex1"], seeThroughAmount: { im1: 0.3, ex1: 1 } },
      new Set(),
      null,
      "",
    );

    expect([...scene.ghostOpacity!]).toEqual([
      ["im1", 0.7],
      ["ex1", 0.05],
    ]);
    // The usual see-through look is an amount of 0.75; nothing is drawn fully solid or not at all.
    expect(ghostOpacity(0.75)).toBe(0.25);
    expect(ghostOpacity(0.01)).toBe(0.95);
    expect(ghostOpacity(1)).toBe(0.05);
  });

  it("keeps used sketches while one is edited or a profile tool is open", () => {
    expect(sceneFor(output, { features }, new Set(), "sk1", "").sketches.map((s) => s.id)).toEqual([
      "sk1",
      "sk2",
      "sk3",
    ]);
    expect(sceneFor(output, { features }, new Set(), null, "extrude").sketches).toHaveLength(3);
  });

  it("gives an empty design planes of the smallest size", () => {
    const empty = {
      ...output,
      meshes: [],
      report: { ...output.report, bodies: [], sketches: [], planes: [] },
    };
    const scene = sceneFor(empty as unknown as RebuildOutput, { features: [] }, new Set(), null, "");

    expect(scene.planes.map((p) => p.size)).toEqual([36, 36, 36]);
    expect([...scene.ghostBodies!]).toEqual([]);
    expect(EMPTY_SCENE.bodies).toEqual([]);
  });
});

describe("jointGlyphsFor", () => {
  const joints = [
    { id: "j1", type: "revolute", a: "p1", b: "ground" },
    { id: "j2", type: "slider", a: "p1", b: "p2" },
    { id: "j3", type: "cylindrical", a: "p2", b: "p3" },
    { id: "j4", type: "cylindrical", a: "p2", b: "ground" },
    { id: "j5", type: "revolute", a: "p1", b: "ground", suppressed: true },
    { id: "j6", type: "revolute", a: "p1", b: "ground" },
    { id: "j7", type: "revolute", a: "p1", b: "ground" },
  ] as unknown as Joint[];
  const at = { origin: [0, 0, 0], axis: [0, 0, 1] };
  const frames = [
    { id: "j1", ...at },
    { id: "j2", ...at },
    { id: "j3", ...at },
    { id: "j4", ...at },
    { id: "j5", ...at },
    { id: "j6", ...at, error: "no axis" },
  ] as unknown as RebuildOutput["report"]["joints"];

  it("shows every working joint while the panel is open, a cylindrical one as ring and arrow", () => {
    const glyphs = jointGlyphsFor(joints, frames, "j2", true);

    expect(glyphs.map((g) => [g.id, g.type, g.parent, g.active])).toEqual([
      ["j1", "revolute", undefined, false],
      ["j2", "slider", "p2", true],
      ["j3.turn", "revolute", "j3~carrier", false],
      ["j3.slide", "slider", "p3", false],
      ["j4.turn", "revolute", "j4~carrier", false],
      ["j4.slide", "slider", undefined, false],
    ]);
  });

  it("shows only the joint being edited while symbols are off", () => {
    expect(jointGlyphsFor(joints, frames, "j1", false).map((g) => g.id)).toEqual(["j1"]);
    expect(jointGlyphsFor(joints, frames, undefined, false)).toEqual([]);
  });
});

describe("featureOfPick", () => {
  const point = [0, 0, 0] as [number, number, number];
  const face = (tags: string[], bodyId = "ex1"): Pick => ({
    kind: "face",
    bodyId,
    face: 0,
    tags,
    point,
    normal: null,
  });

  it("opens a pick's sketch, own plane or the latest feature that shaped the face", () => {
    expect(featureOfPick({ kind: "region", sketchId: "sk1", key: "r", point }, features)).toBe("sk1");
    expect(featureOfPick({ kind: "sketch_curve", sketchId: "sk2", curveId: "l1", point }, features)).toBe(
      "sk2",
    );
    expect(featureOfPick({ kind: "plane", planeId: "pl1", point }, features)).toBe("pl1");
    expect(featureOfPick({ kind: "plane", planeId: "origin.XY", point }, features)).toBeNull();
    expect(featureOfPick(face(["ex1.side", "fi1.round[e1]"]), features)).toBe("fi1");
    expect(featureOfPick(face(["ex1.side@lp1.2"]), features)).toBe("ex1");
  });

  it("falls back to the part's own feature for faces and edges", () => {
    expect(featureOfPick(face(["xx.side"]), features)).toBe("ex1");
    expect(featureOfPick(face([], "nope"), features)).toBeNull();
    expect(featureOfPick({ kind: "edge", bodyId: "im1", edge: 0, point }, features)).toBe("im1");
    expect(featureOfPick({ kind: "edge", bodyId: "nope", edge: 0, point }, features)).toBeNull();
  });
});
