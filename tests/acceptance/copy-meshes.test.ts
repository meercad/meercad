/**
 * Parts that are copies of each other share their display mesh (CopyMeshes in the kernel): the
 * copy shows the same triangles as the part it was made from, moved, turned or mirrored the same
 * way. Each such mesh is held against the mesh the part gets by itself.
 */
import { describe, expect, it } from "vitest";
import type { MeercadDocument } from "@meercad/schema";
import { copyMeshProblems } from "../copy-meshes-check.js";
import { corpus, doc, getOcct, newSession } from "./helpers.js";

/**
 * A part without any symmetry: a block with a hole off its middle, a step on one corner and a rounded edge.
 */
const part: MeercadDocument["features"] = [
  { id: "a", op: "primitive", shape: "box", size: [30, 20, 10], center: [0, 0, 5], mode: "new_body" },
  {
    id: "a_hole",
    op: "primitive",
    shape: "cylinder",
    diameter: 6,
    height: 30,
    center: [8, 3, 5],
    mode: "cut",
    targets: ["a"],
  },
  {
    id: "a_step",
    op: "primitive",
    shape: "box",
    size: [6, 5, 4],
    center: [-12, -7.5, 12],
    mode: "join",
    targets: ["a"],
  },
  {
    id: "a_ball",
    op: "primitive",
    shape: "sphere",
    diameter: 8,
    center: [-15, 10, 10],
    mode: "join",
    targets: ["a"],
  },
] as MeercadDocument["features"];

describe("meshes of copied parts", () => {
  it("a moved, a turned, a mirrored and a patterned copy show the part's own triangles in their place", async () => {
    const oc = await getOcct();
    const session = await newSession();
    const r = session.rebuild(
      doc([
        ...part,
        { id: "mv", op: "transform", bodies: ["a"], translate: [60, 5, -3], copy: true },
        {
          id: "quarter",
          op: "transform",
          bodies: ["a"],
          rotate: { axis: { ref: "origin.Z" }, angle: 90 },
          translate: [0, 80, 0],
          copy: true,
        },
        {
          id: "skew",
          op: "transform",
          bodies: ["a"],
          rotate: { axis: { ref: "origin.X" }, angle: 37 },
          translate: [0, -70, 20],
          copy: true,
        },
        { id: "mi", op: "mirror", source: { bodies: ["a"] }, plane: { ref: "origin.YZ" } },
        // A copy of a copy, and a mirrored copy mirrored back.
        {
          id: "mv2",
          op: "transform",
          bodies: ["skew_a"],
          rotate: { axis: { ref: "origin.Y" }, angle: -20 },
          translate: [90, 0, 0],
          copy: true,
        },
        { id: "mi2", op: "mirror", source: { bodies: ["mi_1"] }, plane: { ref: "origin.XZ" } },
        {
          id: "row",
          op: "linear_pattern",
          source: { bodies: ["a"] },
          direction: { ref: "origin.Z" },
          count: 3,
          spacing: 25,
        },
      ] as MeercadDocument["features"]),
      { props: false },
    );
    expect(r.report.features.filter((f) => f.status !== "ok")).toEqual([]);

    const { copies, problems } = copyMeshProblems(oc, session, r.meshes);
    expect(problems).toEqual([]);
    // The part and its eight copies.
    expect(copies).toBe(9);

    // The triangles are the part's own: every copy has as many as the part.
    const tris = new Set(r.meshes.map((m) => m.indices.length));
    expect(tris.size).toBe(1);
    // Each mesh has arrays of its own, as if it had been meshed.
    expect(new Set(r.meshes.map((m) => m.indices.buffer)).size).toBe(r.meshes.length);
  });

  it("a copy that was changed afterwards, or scaled, is meshed by itself", async () => {
    const oc = await getOcct();
    const session = await newSession();
    const r = session.rebuild(
      doc([
        ...part,
        { id: "mv", op: "transform", bodies: ["a"], translate: [60, 0, 0], copy: true },
        {
          id: "mv_cut",
          op: "primitive",
          shape: "box",
          size: [10, 10, 30],
          center: [72, -8, 5],
          mode: "cut",
          targets: ["mv_a"],
        },
        { id: "mv3", op: "transform", bodies: ["a"], translate: [0, 60, 0], copy: true },
        { id: "big", op: "scale", bodies: ["mv3_a"], factor: 2 },
      ] as MeercadDocument["features"]),
      { props: false },
    );
    expect(r.report.features.filter((f) => f.status !== "ok")).toEqual([]);

    const bodies = session.state!.bodies;
    expect(bodies.get("mv_a")!.copyOf).toBeNull();
    expect(bodies.get("mv3_a")!.copyOf).toBeNull();

    const byId = new Map(r.meshes.map((m) => [m.bodyId, m]));
    expect(byId.get("mv_a")!.faceTags.length).not.toBe(byId.get("a")!.faceTags.length);
    expect(copyMeshProblems(oc, session, r.meshes).problems).toEqual([]);
  });

  it("no copy is coarser than it would be alone: the finest of them is the one meshed", async () => {
    const session = await newSession();
    // A long thin bar and a copy turned into the diagonal: its box is smaller, so its mesh alone is finer.
    const r = session.rebuild(
      doc([
        {
          id: "bar",
          op: "primitive",
          shape: "cylinder",
          diameter: 20,
          height: 200,
          center: [0, 0, 100],
          mode: "new_body",
        },
        {
          id: "up",
          op: "transform",
          bodies: ["bar"],
          rotate: { axis: { ref: "origin.X" }, angle: 45 },
          translate: [100, 0, 0],
          copy: true,
        },
        { id: "far", op: "transform", bodies: ["bar"], translate: [0, 300, 0], copy: true },
      ] as MeercadDocument["features"]),
      { props: false },
    );
    const alone = await newSession();
    const single = alone.rebuild(
      doc([
        {
          id: "bar",
          op: "primitive",
          shape: "cylinder",
          diameter: 20,
          height: 200,
          center: [0, 0, 100],
          mode: "new_body",
        },
      ] as MeercadDocument["features"]),
      { props: false },
    );
    const tris = new Map(r.meshes.map((m) => [m.bodyId, m.indices.length / 3]));

    for (const id of ["bar", "up_bar", "far_bar"]) {
      expect(tris.get(id)!, id).toBeGreaterThanOrEqual(single.meshes[0]!.indices.length / 3);
    }
  });

  for (const file of [
    "feature-09-mirrored-t-profile",
    "feature-12-booleans-and-copies",
    "feature-33-assembly-with-align",
  ]) {
    it(`${file}: copies show the same faces and edges as alone`, async () => {
      const oc = await getOcct();
      const session = await newSession();
      const r = session.rebuild(corpus(`${file}.meercad.json`), { props: false });
      expect(copyMeshProblems(oc, session, r.meshes).problems).toEqual([]);
    });
  }
});
