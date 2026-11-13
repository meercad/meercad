/**
 * Values out of range: each feature must fail with a message that names the limit (never build
 * something else), and borderline values must build with a warning that says what was changed.
 */
import { describe, expect, it } from "vitest";
import type { Feature } from "@meercad/schema";
import { circle, doc, newSession, rect, sketch } from "./helpers.js";

/** A 2 × 2 pixel grey picture (4 bytes, base64). */
const pixels = "AAAAAA==";
const board = { id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [2, 2] };
const holder = (more: object) => ({
  id: "f",
  op: "wall",
  system: "opengrid",
  kind: "holder",
  units: [1, 1],
  board: "wl1",
  ...more,
});
const bin = (more: object) => ({ id: "f", op: "gridfinity", kind: "bin", units: [1, 1], height: 3, ...more });
const baseplate = (more: object) => ({ id: "f", op: "gridfinity", kind: "baseplate", ...more });
const lithophane = (more: object) => ({
  id: "f",
  op: "lithophane",
  image: { width: 2, height: 2, pixels },
  ...more,
});

/** A 40 × 20 × 10 block and a plane through its middle to split it at. */
const block = [
  sketch("sk1", { ref: "origin.XY" }, rect("l", 0, 0, 40, 20)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 10, mode: "new_body" },
  { id: "pl1", op: "plane", base: { ref: "origin.YZ" }, offset: 20 },
];
const split = (connectors: object) => [
  ...block,
  { id: "f", op: "split", plane: { ref: "pl1" }, bodies: ["ex1"], connectors },
];
/** An Ø8 rod, 20 long, and a thread on its round face. */
const rod = [
  sketch("sk1", { ref: "origin.XY" }, circle("k", 0, 0, 4)),
  { id: "ex1", op: "extrude", profile: { sketch: "sk1" }, extent: "blind", distance: 20, mode: "new_body" },
];
const thread = (face: object, more: object = {}) => [...rod, { id: "f", op: "thread", face, ...more }];

/** Status and message of feature "f" after building `features`. */
async function outcome(features: unknown[]) {
  const session = await newSession();
  const { report } = session.rebuild(doc(features as Feature[]));
  const feature = report.features.find((entry) => entry.id === "f")!;

  return { status: feature.status, message: feature.message ?? "" };
}

describe("values out of range are refused with the limit named", () => {
  it.each([
    ["a bin floor lower than the feet", [bin({ floor: 1 })], /the floor must be at least 4\.75 mm high/],
    [
      "bin magnets wider than 12 mm",
      [bin({ magnets: true, magnetDiameter: 15 })],
      /magnet holes must be under 12 mm wide and under 4\.75 mm deep/,
    ],
    [
      "a label tab 1 mm wide",
      [bin({ tab: { width: 1 } })],
      /the label tab must be between 3 and 37\.1 mm wide/,
    ],
    [
      "baseplate magnets in a thin floor",
      [baseplate({ units: [1, 1], magnets: true, floor: 0.5 })],
      /magnets need a floor of at least 2\.8 mm/,
    ],
    [
      "baseplate screws in a thin floor",
      [baseplate({ units: [1, 1], screws: true, floor: 1 })],
      /countersunk screws need a floor of at least 2\.3 mm/,
    ],
    [
      "drawer baseplate magnets in a thin floor",
      [baseplate({ drawer: [100, 100], magnets: true, floor: 0.5 })],
      /magnets need a floor of at least 2\.8 mm/,
    ],
    [
      "drawer baseplate screws in a thin floor",
      [baseplate({ drawer: [100, 100], screws: true, floor: 1 })],
      /countersunk screws need a floor of at least 2\.3 mm/,
    ],
    [
      "an engraving deeper than the label",
      [{ id: "f", op: "label", style: "engraved", depth: 5, thickness: 1, text: "A" }],
      /engraving must stay under 0\.8 mm deep \(the label is 1 mm thick\)/,
    ],
    [
      "pegboard holes of 1 mm",
      [{ id: "f", op: "wall", system: "pegboard", kind: "board", units: [2, 2], hole: 1 }],
      /the holes must be between 2 and 23\.4 mm/,
    ],
    [
      "a pegboard 50 mm thick",
      [{ id: "f", op: "wall", system: "pegboard", kind: "board", units: [2, 2], thickness: 50 }],
      /the board must be between 0\.5 and 30 mm thick/,
    ],
    [
      "a holder plate 30 mm thick",
      [board, holder({ plate: 30 })],
      /the plate must be between 1 and 20 mm thick/,
    ],
    [
      "a hook reaching 400 mm",
      [board, holder({ accessory: "hook", depth: 400 })],
      /the hook must reach between 8 and 300 mm/,
    ],
    [
      "a ring 300 mm off the plate",
      [board, holder({ accessory: "ring", depth: 300 })],
      /the ring must stand between 0 and 200 mm off the plate/,
    ],
    [
      "a shelf 5 mm deep",
      [board, holder({ accessory: "shelf", depth: 5 })],
      /the shelf must be between 10 and 300 mm deep/,
    ],
    [
      "a lithophane curved by 400°",
      [lithophane({ width: 20, curve: 400 })],
      /the curve must be between 0 and 360 degrees/,
    ],
    [
      "a lithophane curved tighter than its thickness allows",
      [lithophane({ width: 5, curve: 350, thickness: 3 })],
      /the curve is too tight for a 5 mm wide picture: at most 71°/,
    ],
    [
      "a sweep along a path with a gap",
      [
        sketch("sk3", { ref: "origin.XZ" }, circle("c", 0, 0, 1)),
        sketch("sk4", { ref: "origin.XY" }, [
          { id: "ma", type: "point", x: 0, y: 0 },
          { id: "mb", type: "point", x: 0, y: 10 },
          { id: "m", type: "line", p1: "ma", p2: "mb" },
          { id: "na", type: "point", x: 5, y: 20 },
          { id: "nb", type: "point", x: 5, y: 30 },
          { id: "n", type: "line", p1: "na", p2: "nb" },
        ]),
        { id: "f", op: "sweep", profile: { sketch: "sk3" }, path: { sketch: "sk4" }, mode: "new_body" },
      ],
      /the path has gaps: its lines and arcs must join end to end/,
    ],
    [
      "split connectors of no size",
      split({ kind: "pins", size: 0 }),
      /the connector size must be greater than zero/,
    ],
    [
      "split connectors of no depth",
      split({ kind: "pins", depth: 0 }),
      /the connector depth must be greater than zero/,
    ],
    ["pins longer than the part", split({ kind: "pins", depth: 100 }), /no room for pins inside the part/],
    [
      "dowels longer than the part",
      split({ kind: "dowels", depth: 100 }),
      /no room for dowels inside the part/,
    ],
    [
      "a dovetail larger than the cut",
      split({ kind: "dovetail", size: 100 }),
      /no room for a dovetail at the cut/,
    ],
    [
      "a thread with more play than its pitch allows",
      thread({ face: "ex1.side[sk1.k]" }, { pitch: 1, clearance: 5 }),
      /clearance must be between 0 and 0\.25 mm for this pitch/,
    ],
    [
      "a thread on a selector that matches several faces",
      thread({ select: "faces", of: "ex1" }),
      /the face selector matches 3 faces; pick exactly one cylindrical face/,
    ],
    [
      "a screw of no length",
      [{ id: "f", op: "screw", kind: "screw", diameter: 4, length: 0, mode: "new_body" }],
      /the screw's length must be greater than zero/,
    ],
  ])("refuses %s", async (_name, features, message) => {
    const { status, message: got } = await outcome(features);

    expect(status).toBe("error");
    expect(got).toMatch(message);
  });
});

describe("borderline values build, with a warning that says what happened", () => {
  it.each([
    [
      "a scoop larger than the compartments",
      [bin({ dividers: [2, 2], scoop: 100 })],
      /the scoop is 9\.8 mm \(as large as the compartments allow\)/,
    ],
    [
      "a label text too large for the label",
      [{ id: "f", op: "label", text: "A very long text for this label", size: 20, width: 20, height: 10 }],
      /the text is smaller than 20 mm so it fits on the label/,
    ],
    [
      "bin screw holes in a low floor",
      [bin({ screws: true, floor: 5 })],
      /the screw holes are 4\.2 mm deep: raise the floor for the full 6 mm/,
    ],
    [
      "a tightly wound spring",
      [{ id: "f", op: "spring", kind: "compression", wire: 2, diameter: 7, coils: 5, mode: "new_body" }],
      /tightly wound: a spring index \(mean diameter ÷ wire\) below 3/,
    ],
  ])("warns about %s", async (_name, features, message) => {
    const { status, message: got } = await outcome(features);

    expect(status).toBe("warning");
    expect(got).toMatch(message);
  });

  it.each([
    ["a solid bin", [bin({ solid: true })]],
    ["a bin without stacking lip", [bin({ lip: false })]],
    ["a baseplate with screw holes", [baseplate({ units: [1, 1], screws: true, floor: 3 })]],
    ["a drawer baseplate with screw holes", [baseplate({ drawer: [100, 100], screws: true, floor: 3 })]],
    ["a split with a dovetail", split({ kind: "dovetail" })],
  ])("builds %s", async (_name, features) => {
    expect((await outcome(features)).status).toBe("ok");
  });
});
