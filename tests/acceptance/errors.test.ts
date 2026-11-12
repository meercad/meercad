/**
 * Steps that cannot be built say why, on the step, in words a person can act on, and the rest of
 * the design still builds. One case per message the kernel gives.
 */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

const box: Feature[] = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
];
const two = sketch("sk2", { ref: "origin.XY" }, [...rect("m", 60, 0, 10, 10), ...rect("n", 80, 0, 10, 10)]);
const line = sketch("sk3", { ref: "origin.XZ" }, [{ id: "a", type: "point", x: 0, y: 0 }, { id: "b", type: "point", x: 0, y: 30 }, { id: "ln", type: "line", p1: "a", p2: "b" }]);

/** Builds `extra` after the box and returns the message of the step `id` (which must fail). */
async function fails(extra: Feature[], id = extra.at(-1)!.id) {
  const { report } = (await newSession()).rebuild(doc([...box, ...extra]));
  const st = report.features.find((f) => f.id === id)!;
  expect(st.status, `${id}: ${st.message}`).toBe("error");
  // Everything before it still built.
  expect(report.features.find((f) => f.id === "ex1")!.status).toBe("ok");
  return `${st.message ?? ""} ${st.hint ?? ""}`;
}

describe("steps that cannot be built say why", () => {
  it.each([
    ["an extrude of 0 mm", [{ id: "e2", op: "extrude", profile: { face: { face: "ex1.end_cap" } }, extent: "blind", distance: 0, mode: "join" }], /must not be zero/],
    ["an extrude of a sketch region that is gone", [sketch("sk9", { ref: "origin.XY" }, circle("c", 100, 100, 3)), { id: "e2", op: "extrude", profile: { sketch: "sk9", regions: ["zz"] }, extent: "blind", distance: 5, mode: "new_body" }], /no longer exist: zz/],
    ["a push/pull on a face that is not there", [{ id: "e2", op: "extrude", profile: { face: { face: "ex1.nope" } }, extent: "blind", distance: 3, mode: "join" }], /face|no/],
    ["a revolve of 0°", [sketch("sk9", { ref: "origin.XZ" }, rect("r", 50, 0, 5, 5)), { ...line, id: "sk8" } as Feature, { id: "r1", op: "revolve", profile: { sketch: "sk9" }, axis: { line: "sk8.ln" }, angle: 0, mode: "new_body" }], /must not be zero/],
    ["a revolve about a line that is not there", [sketch("sk9", { ref: "origin.XZ" }, rect("r", 50, 0, 5, 5)), { id: "r1", op: "revolve", profile: { sketch: "sk9" }, axis: { line: "sk9.zz" }, angle: 90, mode: "new_body" }], /axis line "sk9.zz" not found/],
    ["a revolve of a face", [{ id: "r1", op: "revolve", profile: { face: { face: "ex1.end_cap" } }, axis: { ref: "origin.Z" }, angle: 90, mode: "join" }], /needs a sketch profile/],
    ["a loft of one profile", [sketch("sk9", { ref: "origin.XY" }, circle("c", 100, 0, 5)), { id: "lo1", op: "loft", profiles: [{ sketch: "sk9" }], mode: "new_body" }], /at least two profiles/],
    ["a loft from a sketch with two regions", [two, sketch("sk9", { ref: "origin.XY" }, circle("c", 100, 0, 5)), { id: "lo1", op: "loft", profiles: [{ sketch: "sk2" }, { sketch: "sk9" }], mode: "new_body" }], /2 closed regions, pick one/],
    ["a sweep along a sketch without curves", [sketch("sk9", { ref: "origin.XY" }, circle("c", 100, 0, 2)), sketch("sk8", { ref: "origin.XZ" }, [{ id: "q", type: "point", x: 0, y: 0 }]), { id: "sw1", op: "sweep", profile: { sketch: "sk9" }, path: { sketch: "sk8" }, mode: "new_body" }], /no lines, arcs or splines/],
    ["a sweep along a path with a gap", [sketch("sk9", { ref: "origin.YZ" }, circle("c", 0, 0, 1)), sketch("sk8", { ref: "origin.XY" }, [{ id: "p1", type: "point", x: 0, y: 0 }, { id: "p2", type: "point", x: 10, y: 0 }, { id: "p3", type: "point", x: 20, y: 5 }, { id: "p4", type: "point", x: 30, y: 5 }, { id: "g1", type: "line", p1: "p1", p2: "p2" }, { id: "g2", type: "line", p1: "p3", p2: "p4" }]), { id: "sw1", op: "sweep", profile: { sketch: "sk9" }, path: { sketch: "sk8" }, mode: "new_body" }], /has gaps/],
    ["a coil of pitch 0", [sketch("sk9", { ref: "origin.XZ" }, circle("c", 60, 0, 2)), { id: "co1", op: "coil", profile: { sketch: "sk9" }, axis: { ref: "origin.Z" }, pitch: 0, turns: 3, mode: "new_body" }], /pitch must be greater than zero/],
    ["a coil tapered too far", [sketch("sk9", { ref: "origin.XZ" }, circle("c", 60, 0, 2)), { id: "co1", op: "coil", profile: { sketch: "sk9" }, axis: { ref: "origin.Z" }, pitch: 5, turns: 3, taper: 70, mode: "new_body" }], /between −60° and 60°/],
    ["a coil whose profile sits on its axis", [sketch("sk9", { ref: "origin.XZ" }, circle("c", 0, 0, 2)), { id: "co1", op: "coil", profile: { sketch: "sk9" }, axis: { ref: "origin.Z" }, pitch: 5, turns: 3, mode: "new_body" }], /touches or crosses the axis|centre lies on the axis/],
    ["scaling nothing", [{ id: "sc1", op: "scale", bodies: [], factor: 2 }], /pick the parts to scale/],
    ["a sphere of no size", [{ id: "pr1", op: "primitive", shape: "sphere", diameter: 0, mode: "new_body" }], /sphere needs a diameter greater than zero/],
    ["a cylinder of no height", [{ id: "pr1", op: "primitive", shape: "cylinder", diameter: 5, height: 0, mode: "new_body" }], /diameter and a height greater than zero/],
    ["text of no depth", [{ id: "tx1", op: "text", plane: { face: { face: "ex1.end_cap" } }, text: "A", size: 5, depth: 0, mode: "join" }], /depth must be greater than zero/],
    ["text with no letters", [{ id: "tx1", op: "text", plane: { face: { face: "ex1.end_cap" } }, text: "   ", size: 5, depth: 1, mode: "join" }], /text is empty|no letters/],
    ["a draft of no faces", [{ id: "dr1", op: "draft", faces: [], neutral: { ref: "origin.XY" }, angle: 3 }], /select the faces to draft/],
    ["moving no faces", [{ id: "of1", op: "offset_face", faces: [], distance: 2 }], /select the faces to move/],
    ["a rib of no thickness", [sketch("sk9", { ref: "origin.XZ" }, [{ id: "a", type: "point", x: 0, y: 10 }, { id: "b", type: "point", x: 10, y: 0 }, { id: "ln", type: "line", p1: "a", p2: "b" }]), { id: "rb1", op: "rib", sketch: "sk9", thickness: 0 }], /thickness must be greater than zero/],
    ["a rib from a sketch without lines", [sketch("sk9", { ref: "origin.XZ" }, circle("c", 5, 5, 2)), { id: "rb1", op: "rib", sketch: "sk9", thickness: 2 }], /no lines for a rib/],
    ["a fillet of 0 mm", [{ id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1" }, radius: 0 }], /must be greater than zero/],
    ["a fillet too big for its edges", [{ id: "fi1", op: "fillet", edges: { select: "edges", of: "ex1" }, radius: 30 }], /fillet of 30 mm failed|cannot be treated/],
    ["a variable fillet with an end radius of 0", [{ id: "fi1", op: "fillet", edges: [{ edge: ["ex1.side[sk1.l1]", "ex1.side[sk1.l2]"] }], radius: 1, radius2: 0 }], /end radius must be greater than zero/],
    ["a shell of 0 mm", [{ id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 0 }], /shell thickness must be greater than zero/],
    ["a pattern of one", [{ id: "lp1", op: "linear_pattern", source: { bodies: ["ex1"] }, direction: { ref: "origin.X" }, count: 1, spacing: 50 }], /count of at least 2/],
    ["a cut that misses everything", [sketch("sk9", { ref: "origin.XY" }, circle("c", 200, 200, 3)), { id: "e2", op: "extrude", profile: { sketch: "sk9" }, extent: "blind", distance: 5, mode: "cut" }], /nothing to cut/],
    ["an import that is not base64", [{ id: "im1", op: "import", format: "stl", fileName: "x.stl", data: "not base64!!" }], /must be the file's contents encoded as base64/],
    ["an STL with no triangles", [{ id: "im1", op: "import", format: "stl", fileName: "x.stl", data: Buffer.from(new Uint8Array(84)).toString("base64") }], /contains no triangles|could not read/],
    ["a STEP file that is no STEP", [{ id: "im1", op: "import", format: "step", fileName: "x.step", data: Buffer.from("hello").toString("base64") }], /could not read STEP file "x.step"/],
    ["holes without points", [{ id: "ho1", op: "hole", kind: "simple", plane: { face: { face: "ex1.end_cap" } }, points: [], diameter: 3, depth: 10 }], /place at least one hole/],
    ["standard parts without points", [{ id: "np1", op: "standard_part", kind: "screw", size: "M3", plane: { face: { face: "ex1.end_cap" } }, points: [], length: 10 }], /place at least one part/],
    ["bending nothing", [{ id: "bd1", op: "bend", mode: "bend", bodies: [], angle: 90, axis: { ref: "origin.Y" } }], /pick the parts to bend/],
    ["converting a mesh of a part that is not there", [{ id: "mc1", op: "mesh_convert", body: "zz" }], /body "zz" not found/],
    ["a bin in a baseplate that is not there", [{ id: "gf1", op: "gridfinity", kind: "bin", units: [1, 1], height: 3, baseplate: "zz" }], /baseplate "zz" not found/],
    ["a holder on a board that is not there", [{ id: "wl1", op: "wall", system: "opengrid", kind: "holder", units: [1, 1], accessory: "hook", board: "zz", cell: [0, 0] }], /board "zz" not found/],
  ] as [string, Feature[], RegExp][])("%s", async (_name, extra, msg) => {
    expect(await fails(extra)).toMatch(msg);
  });
});

/** A second part beside the box, and a round shaft standing on it. */
const part2: Feature[] = [
  sketch("skb", { ref: "origin.XY" }, rect("q", 60, 0, 10, 10)),
  { id: "exb", op: "extrude", profile: { sketch: "skb" }, extent: "blind", distance: 10, mode: "new_body" },
];
const shaft: Feature[] = [
  sketch("skc", { ref: "origin.XY" }, circle("c", 100, 0, 5)),
  { id: "exc", op: "extrude", profile: { sketch: "skc" }, extent: "blind", distance: 10, mode: "new_body" },
];
const allFaces = { select: "faces", of: "ex1" } as const;
const round = { face: "exc.side[skc.c]" };
const pathSketch = (entities: Parameters<typeof sketch>[2]) => [sketch("sk9", { ref: "origin.YZ" }, circle("c", 0, 0, 1)), sketch("sk8", { ref: "origin.XY" }, entities)];

describe("more steps that cannot be built say why", () => {
  it.each([
    ["a sketch on a curved face", [...shaft, sketch("sk9", { face: round }, circle("c", 0, 0, 1))], /the selected face is not planar/],
    ["a sketch on several faces that are not one plane", [sketch("sk9", { face: allFaces }, circle("c", 0, 0, 1))], /face selector matches 6 faces; pick exactly one/],
    ["a sketch on a face selector that finds nothing", [sketch("sk9", { face: { select: "faces", of: "ex1", where: { tag: "ex1.nope" } } }, circle("c", 0, 0, 1))], /no face matches the selector/],
    ["a push/pull of several faces", [{ id: "e2", op: "extrude", profile: { face: allFaces }, extent: "blind", distance: 3, mode: "join" }], /push\/pull needs exactly one face/],
    ["an extrude of a sketch by 0 mm", [sketch("sk9", { ref: "origin.XY" }, circle("c", 100, 100, 3)), { id: "e2", op: "extrude", profile: { sketch: "sk9" }, extent: "blind", distance: 0, mode: "new_body" }], /must not be zero/],
    ["a loft from several faces at once", [sketch("sk9", { ref: "origin.XY" }, circle("c", 100, 0, 5)), { id: "lo1", op: "loft", profiles: [{ face: allFaces }, { sketch: "sk9" }], mode: "new_body" }], /pick exactly one face/],
    ["a loft from a curved face", [...shaft, sketch("sk9", { ref: "origin.XY" }, circle("c", 200, 0, 5)), { id: "lo1", op: "loft", profiles: [{ face: round }, { sketch: "sk9" }], mode: "new_body" }], /the face must be flat/],
    ["a sweep along lines that are gone", [...pathSketch([{ id: "p1", type: "point", x: 0, y: 0 }, { id: "p2", type: "point", x: 10, y: 0 }, { id: "g1", type: "line", p1: "p1", p2: "p2" }]), { id: "sw1", op: "sweep", profile: { sketch: "sk9" }, path: { sketch: "sk8", curves: ["zz"] }, mode: "new_body" }], /path curve\(s\) no longer exist: zz/],
    ["a sweep along a circle and a line", [...pathSketch([...circle("o", 50, 50, 10), { id: "p1", type: "point", x: 0, y: 0 }, { id: "p2", type: "point", x: 10, y: 0 }, { id: "g1", type: "line", p1: "p1", p2: "p2" }]), { id: "sw1", op: "sweep", profile: { sketch: "sk9" }, path: { sketch: "sk8" }, mode: "new_body" }], /a circle can only be a path on its own/],
    ["a coil of no turns", [sketch("sk9", { ref: "origin.XZ" }, circle("c", 60, 0, 2)), { id: "co1", op: "coil", profile: { sketch: "sk9" }, axis: { ref: "origin.Z" }, pitch: 5, turns: 0, mode: "new_body" }], /at least a fraction of a turn/],
    ["a coil of too many turns", [sketch("sk9", { ref: "origin.XZ" }, circle("c", 60, 0, 2)), { id: "co1", op: "coil", profile: { sketch: "sk9" }, axis: { ref: "origin.Z" }, pitch: 5, turns: 501, mode: "new_body" }], /at most 500 turns/],
    ["aligning by several faces", [...part2, { id: "al1", op: "align", from: { face: { select: "faces", of: "exb" } }, to: { face: { face: "ex1.end_cap" } } }], /the face to move: pick exactly one face/],
    ["aligning a curved face flat", [...shaft, { id: "al1", op: "align", from: { face: round }, to: { face: { face: "ex1.end_cap" } } }], /the face to move: the face must be flat/],
    ["aligning on the axis of a flat face", [...part2, { id: "al1", op: "align", from: { axisOf: { face: "exb.end_cap" } }, to: { axisOf: { face: "ex1.end_cap" } } }], /must be round \(a hole, a shaft\)/],
    ["aligning a part to itself", [{ id: "al1", op: "align", from: { face: { face: "ex1.start_cap" } }, to: { face: { face: "ex1.end_cap" } } }], /the target face belongs to a part being moved/],
    ["a draft across two parts", [...part2, { id: "dr1", op: "draft", faces: [{ face: "ex1.side[sk1.l1]" }, { face: "exb.side[skb.q1]" }], neutral: { ref: "origin.XY" }, angle: 3 }], /draft faces must belong to one part/],
    ["moving faces of two parts", [...part2, { id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }, { face: "exb.end_cap" }], distance: 2 }], /the faces must belong to one part/],
    ["moving a curved face up to a plane", [...shaft, { id: "of1", op: "offset_face", faces: [round], distance: 0, upTo: { ref: "origin.XY" } }], /is not flat/],
    ["a rib along lines that are gone", [sketch("sk9", { ref: "origin.XZ" }, [{ id: "a", type: "point", x: 0, y: 10 }, { id: "b", type: "point", x: 10, y: 0 }, { id: "ln", type: "line", p1: "a", p2: "b" }]), { id: "rb1", op: "rib", sketch: "sk9", curves: ["zz"], thickness: 2 }], /rib line\(s\) no longer exist: zz/],
    // OCCT reports success and hands the part back solid: 2 mm walls were never made.
    ["a shell whose opening's edge is rounded", [{ id: "fi1", op: "fillet", edges: [{ edge: ["ex1.end_cap", "ex1.side[sk1.l1]"] }], radius: 3 }, { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }], thickness: 2 }], /shell failed: the part came back solid.*shell before rounding/],
    ["a shell removing no faces", [{ id: "sh1", op: "shell", faces: [], thickness: 1 }], /select at least one face to remove/],
    ["a shell across two parts", [...part2, { id: "sh1", op: "shell", faces: [{ face: "ex1.end_cap" }, { face: "exb.end_cap" }], thickness: 1 }], /shell faces must belong to one body/],
    ["bending with a tolerance of 0", [{ id: "bd1", op: "bend", mode: "bend", bodies: ["ex1"], angle: 90, axis: { ref: "origin.Y" }, tolerance: 0 }], /tolerance must be greater than zero/],
  ] as [string, Feature[], RegExp][])("%s", async (_name, extra, msg) => {
    expect(await fails(extra)).toMatch(msg);
  });

  it("a rib with no part to stand on", async () => {
    const { report } = (await newSession()).rebuild(doc([sketch("sk9", { ref: "origin.XZ" }, [{ id: "a", type: "point", x: 0, y: 10 }, { id: "b", type: "point", x: 10, y: 0 }, { id: "ln", type: "line", p1: "a", p2: "b" }]), { id: "rb1", op: "rib", sketch: "sk9", thickness: 2 }]));
    expect(report.features.find((f) => f.id === "rb1")!.message).toMatch(/a rib needs a part to stand on/);
  });
});
