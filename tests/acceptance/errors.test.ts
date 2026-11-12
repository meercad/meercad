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
