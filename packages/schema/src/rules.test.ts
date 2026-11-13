/**
 * Every rule the document check enforces beyond the JSON shape, one broken document each: a file
 * from elsewhere (or an assistant) that breaks a rule must be refused with a message that names it,
 * never built into something unexpected.
 */
import { describe, expect, it } from "vitest";
import { profileSketch, validateDocument } from "./index.js";

const rect = {
  entities: [
    { id: "p1", type: "point", x: 0, y: 0 },
    { id: "p2", type: "point", x: 10, y: 0 },
    { id: "p3", type: "point", x: 10, y: 10 },
    { id: "l1", type: "line", p1: "p1", p2: "p2" },
    { id: "l2", type: "line", p1: "p2", p2: "p3" },
    { id: "k1", type: "circle", center: "p3", radius: 2 },
  ],
  constraints: [] as Record<string, unknown>[],
};
const sk = (extra: Partial<typeof rect> = {}, id = "sk1") => ({
  id,
  op: "sketch",
  plane: { ref: "origin.XY" },
  entities: extra.entities ?? rect.entities,
  constraints: extra.constraints ?? [],
});
const ex = {
  id: "ex1",
  op: "extrude",
  profile: { sketch: "sk1" },
  extent: "blind",
  distance: 5,
  mode: "new_body",
};
const doc = (features: unknown[], more: Record<string, unknown> = {}) => ({
  format: "meercad/1",
  params: {},
  features,
  rollback: null,
  ...more,
});

const errorsOf = (d: unknown) => {
  const r = validateDocument(d);

  return r.ok ? [] : r.errors;
};

const refuses = (d: unknown, pattern: RegExp) => {
  const errors = errorsOf(d);
  expect(errors.join("\n"), JSON.stringify(errors)).toMatch(pattern);
};

describe("sketch rules", () => {
  it("accepts a sound sketch", () => expect(errorsOf(doc([sk(), ex]))).toEqual([]));

  it.each([
    ["coincident", { type: "coincident", a: "p1", b: "nope" }, /unknown point "nope"/],
    ["horizontal", { type: "horizontal", line: "nope" }, /unknown line "nope"/],
    ["parallel", { type: "parallel", a: "l1", b: "nope" }, /unknown curve "nope"/],
    ["point_on (point)", { type: "point_on", point: "nope", curve: "l1" }, /unknown point "nope"/],
    ["point_on (curve)", { type: "point_on", point: "p1", curve: "nope" }, /unknown curve "nope"/],
    ["midpoint", { type: "midpoint", point: "p1", line: "nope" }, /unknown line "nope"/],
    ["symmetric", { type: "symmetric", a: "p1", b: "p2", axis: "nope" }, /unknown line "nope"/],
    ["fix", { type: "fix", point: "nope" }, /unknown point "nope"/],
    ["distance", { type: "distance", a: "p1", b: "nope", value: 3 }, /unknown point or line "nope"/],
    ["radius", { type: "radius", curve: "nope", value: 3 }, /unknown circle or arc "nope"/],
    ["angle", { type: "angle", a: "l1", b: "nope", value: 30 }, /unknown curve "nope"/],
    ["arc_angle", { type: "arc_angle", curve: "nope", value: 30 }, /unknown arc "nope"/],
  ])("refuses a %s constraint on something that does not exist", (_n, c, pattern) => {
    refuses(doc([sk({ constraints: [{ id: "c1", ...c }] }), ex]), pattern);
  });

  it("refuses duplicate ids between entities and constraints", () => {
    refuses(
      doc([sk({ entities: [...rect.entities, { id: "p1", type: "point", x: 1, y: 1 }] }), ex]),
      /duplicate entity id p1/,
    );
    refuses(
      doc([sk({ constraints: [{ id: "l1", type: "fix", point: "p1" }] }), ex]),
      /duplicate constraint id l1/,
    );
  });

  it("takes the origin and its axes as references", () => {
    expect(
      errorsOf(
        doc([
          sk({
            constraints: [
              { id: "c1", type: "coincident", a: "p1", b: "origin" },
              { id: "c2", type: "parallel", a: "l1", b: "origin.x" },
            ],
          }),
          ex,
        ]),
      ),
    ).toEqual([]);
  });
});

describe("feature rules", () => {
  const base = [sk(), ex];
  it.each([
    [
      "an unknown origin plane",
      [{ id: "sk2", op: "sketch", plane: { ref: "origin.XX" }, entities: [], constraints: [] }],
      /unknown plane "origin.XX"/,
    ],
    [
      "a plane that is no plane",
      [{ id: "pl1", op: "plane", base: { ref: "ex1" }, offset: 1 }],
      /plane "ex1" must be a plane/,
    ],
    [
      "a two-sided extrude without its second distance",
      [{ ...ex, id: "ex2", extent: "two_sided" }],
      /two_sided extrude needs distance2/,
    ],
    [
      "a revolve about a line of a later sketch",
      [
        {
          id: "rv1",
          op: "revolve",
          profile: { sketch: "sk1" },
          axis: { line: "sk9.l1" },
          angle: 90,
          mode: "new_body",
        },
      ],
      /axis refers to unknown or later feature "sk9"/,
    ],
    [
      "a loft from an unknown sketch",
      [{ id: "lo1", op: "loft", profiles: [{ sketch: "sk1" }, { sketch: "sk9" }], mode: "new_body" }],
      /profile refers to unknown or later feature "sk9"/,
    ],
    [
      "a sweep along an unknown path",
      [{ id: "sw1", op: "sweep", profile: { sketch: "sk1" }, path: { sketch: "sk9" }, mode: "new_body" }],
      /path refers to unknown or later feature "sk9"/,
    ],
    [
      "a fillet on edges of an unknown feature",
      [{ id: "fi1", op: "fillet", edges: { select: "edges", of: "ex9" }, radius: 1 }],
      /selector refers to unknown or later feature "ex9"/,
    ],
    [
      "a nut with a socket head",
      [{ id: "sc1", op: "screw", kind: "nut", head: "socket", diameter: 8, mode: "new_body" }],
      /nuts are hex, round or knob/,
    ],
    [
      "a nut with a thread length",
      [{ id: "sc1", op: "screw", kind: "nut", diameter: 8, threadLength: 5, mode: "new_body" }],
      /threadLength is for screws/,
    ],
    [
      "a gear without module or mate",
      [{ id: "gr1", op: "gear", kind: "spur", teeth: 20, width: 5, mode: "new_body" }],
      /needs a module/,
    ],
    [
      "a rack with a bore",
      [
        {
          id: "gr1",
          op: "gear",
          kind: "rack",
          module: 1,
          teeth: 20,
          width: 5,
          bore: { diameter: 5 },
          mode: "new_body",
        },
      ],
      /only spur gears take a bore/,
    ],
    [
      "a gear meshing with a non-gear",
      [
        {
          id: "gr1",
          op: "gear",
          kind: "spur",
          teeth: 20,
          width: 5,
          meshWith: { gear: "ex1" },
          mode: "new_body",
        },
      ],
      /meshWith "ex1" must be a gear/,
    ],
    [
      "a pattern of an unknown body",
      [
        {
          id: "lp1",
          op: "linear_pattern",
          source: { bodies: ["zz9"] },
          direction: { ref: "origin.X" },
          count: 2,
          spacing: 5,
        },
      ],
      /pattern source refers to unknown or later feature "zz9"/,
    ],
    [
      "moving an unknown body",
      [{ id: "tr1", op: "transform", bodies: ["zz9"], translate: [1, 0, 0] }],
      /body refers to unknown or later feature "zz9"/,
    ],
    [
      "a picture whose pixels do not fit its size",
      [{ id: "li1", op: "lithophane", image: { width: 4, height: 4, pixels: "AAAA" }, width: 50 }],
      /image.pixels must hold/,
    ],
    [
      "aligning a flat face to a round one",
      [
        {
          id: "al1",
          op: "align",
          from: { face: { face: "ex1.end_cap" } },
          to: { axisOf: { face: "ex1.side[sk1.k1]" } },
        },
      ],
      /align needs two flat faces or two round faces/,
    ],
    [
      "a box primitive without size",
      [{ id: "pr1", op: "primitive", shape: "box", mode: "new_body" }],
      /a box needs a size/,
    ],
    [
      "a cylinder without diameter and height",
      [{ id: "pr1", op: "primitive", shape: "cylinder", mode: "new_body" }],
      /needs a diameter[\s\S]*needs a height/,
    ],
    [
      "a bin in a bin",
      [
        { id: "gf1", op: "gridfinity", kind: "bin", units: [1, 1], height: 3 },
        { id: "gf2", op: "gridfinity", kind: "bin", units: [1, 1], height: 3, baseplate: "gf1" },
      ],
      /"gf1" is a bin, not a baseplate/,
    ],
    [
      "a bin with a drawer",
      [{ id: "gf1", op: "gridfinity", kind: "bin", units: [1, 1], height: 3, drawer: [100, 100] }],
      /drawer is for baseplates/,
    ],
    ["a baseplate without units", [{ id: "gf1", op: "gridfinity", kind: "baseplate" }], /units are required/],
    [
      "a square box with a screw lid",
      [{ id: "bx1", op: "box", lid: "screw", shape: "rect", width: 50, height: 30 }],
      /screw lids need a round box/,
    ],
    [
      "a holder on a holder",
      [
        { id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [2, 2] },
        {
          id: "wl2",
          op: "wall",
          system: "opengrid",
          kind: "holder",
          units: [1, 1],
          accessory: "hook",
          board: "wl1",
          cell: [0, 0],
        },
        {
          id: "wl3",
          op: "wall",
          system: "opengrid",
          kind: "holder",
          units: [1, 1],
          accessory: "hook",
          board: "wl2",
          cell: [0, 0],
        },
      ],
      /"wl2" is a holder, not a board/,
    ],
    [
      "a board on a board",
      [
        { id: "wl1", op: "wall", system: "opengrid", kind: "board", units: [2, 2] },
        { id: "wl2", op: "wall", system: "opengrid", kind: "board", units: [2, 2], board: "wl1" },
      ],
      /a board cannot sit on a board/,
    ],
    ["a label without text or symbol", [{ id: "lb1", op: "label", text: " " }], /needs a text or a symbol/],
    [
      "a split with connectors keeping one piece",
      [
        {
          id: "sp1",
          op: "split",
          plane: { ref: "origin.XY" },
          bodies: ["ex1"],
          keep: "front",
          connectors: { kind: "pins" },
        },
      ],
      /connectors need both pieces/,
    ],
    [
      "a bend without angle or radius",
      [{ id: "be1", op: "bend", mode: "bend", bodies: ["ex1"], axis: { ref: "origin.Y" } }],
      /a bend needs an a/,
    ],
    [
      "a simple hole without diameter",
      [
        {
          id: "ho1",
          op: "hole",
          kind: "simple",
          plane: { face: { face: "ex1.end_cap" } },
          points: [[1, 1]],
          depth: "through",
        },
      ],
      /needs a diameter/,
    ],
    [
      "a boolean of a body with itself",
      [{ id: "bo1", op: "boolean", operation: "subtract", target: "ex1", tools: ["ex1"] }],
      /target cannot also be a tool/,
    ],
    ["two features with one id", [{ ...ex }], /feature ex1: duplicate id/],
  ])("refuses %s", (_n, extra, pattern) => {
    refuses(doc([...base, ...extra]), pattern);
  });
});

describe("document rules", () => {
  it("refuses variants of unknown variables, twice the same name, and an unknown variant in use", () => {
    refuses(
      doc([sk(), ex], {
        params: { w: 5 },
        variants: [
          { name: "A", params: { w: 6 } },
          { name: "A", params: { nope: 1 } },
        ],
        variant: "B",
      }),
      /duplicate name[\s\S]*unknown parameter "nope"[\s\S]*"B" is in use but not defined/,
    );
  });
  it("refuses two versions of one name", () => {
    const v = { name: "v1", at: 1, doc: { params: {}, features: [] } };
    const errors = errorsOf(doc([sk(), ex], { versions: [v, v] }));
    expect(errors.join("\n")).toMatch(/version "v1": duplicate name|versions/);
  });
  it("refuses joints of a part to itself, a moving ground, unknown gears, and loose motions and couplings", () => {
    const mechanism = {
      joints: [
        { id: "j1", type: "revolute", a: "ex1", b: "ex1", anchor: { axis: { ref: "origin.Z" } } },
        { id: "j1", type: "revolute", a: "ground", b: "ex1", anchor: { gear: "zz9" } },
      ],
      motions: [{ id: "m1", duration: 1, keys: [{ at: 2, values: { j9: 10 } }] }],
      couplings: [
        { id: "k1", driver: "j1", driven: "j1", ratio: 1 },
        { id: "k2", driver: "j8", driven: "j1", ratio: 1 },
      ],
    };
    const errors = errorsOf(doc([sk(), ex], { mechanism })).join("\n");

    for (const p of [
      /cannot be jointed to itself/,
      /duplicate id/,
      /cannot be the ground/,
      /gear refers to unknown or later feature "zz9"/,
      /lies after the end/,
      /unknown joint "j9"/,
      /cannot drive itself/,
      /unknown joint "j8"/,
    ]) {
      expect(errors).toMatch(p);
    }
  });
  it("refuses an unknown rollback point and unknown automatic variables", () => {
    refuses(
      doc([sk(), ex], { rollback: "zz9", autoParams: ["nope"] }),
      /rollback: unknown feature "zz9"[\s\S]*autoParams: unknown parameter "nope"/,
    );
  });
});

describe("rules of the remaining features", () => {
  const base = [sk(), ex];
  const noPlane = { ref: "origin.XX" };

  it.each([
    [
      "a thread on a face of an unknown feature",
      [{ id: "th1", op: "thread", face: { select: "faces", of: "nope" } }],
      [/th1: selector refers to unknown or later feature "nope"/],
    ],
    [
      "a coil with an unknown profile, axis and target",
      [
        {
          id: "co1",
          op: "coil",
          profile: { sketch: "sk9" },
          axis: { line: "sk8.l1" },
          pitch: 2,
          turns: 3,
          mode: "new_body",
          targets: ["zz"],
        },
      ],
      [
        /co1: profile refers to unknown or later feature "sk9"/,
        /co1: axis .*"sk8"/,
        /co1: target body .*"zz"/,
      ],
    ],
    [
      "a spring on an unknown plane with an unknown target",
      [
        {
          id: "sp9",
          op: "spring",
          kind: "compression",
          wire: 1,
          diameter: 8,
          coils: 5,
          mode: "new_body",
          plane: noPlane,
          targets: ["zz"],
        },
      ],
      [/sp9: unknown plane "origin.XX"/, /sp9: target body .*"zz"/],
    ],
    [
      "a nut with a socket head and a thread length",
      [
        {
          id: "sc1",
          op: "screw",
          kind: "nut",
          diameter: 4,
          mode: "new_body",
          head: "socket",
          threadLength: 5,
        },
      ],
      [/sc1: nuts are hex, round or knob/, /sc1: threadLength is for screws/],
    ],
    [
      "a rack with a tooth chamfer",
      [
        {
          id: "ge1",
          op: "gear",
          kind: "rack",
          module: 1,
          teeth: 10,
          width: 5,
          chamfer: 0.5,
          mode: "new_body",
        },
      ],
      [/ge1: racks have no tooth chamfer yet/],
    ],
    [
      "a draft about an unknown plane",
      [{ id: "dr1", op: "draft", faces: [{ face: "ex1.end_cap" }], angle: 3, neutral: noPlane }],
      [/dr1: unknown plane "origin.XX"/],
    ],
    [
      "a face moved up to an unknown plane",
      [{ id: "of1", op: "offset_face", faces: [{ face: "ex1.end_cap" }], distance: 1, upTo: noPlane }],
      [/of1: unknown plane "origin.XX"/],
    ],
    [
      "a lithophane whose picture does not hold width × height bytes",
      [
        {
          id: "li1",
          op: "lithophane",
          image: { width: 2, height: 2, pixels: "AA" },
          width: 10,
          plane: noPlane,
        },
      ],
      [/li1: unknown plane "origin.XX"/, /li1: image.pixels must hold width × height bytes/],
    ],
    [
      "a scale of an unknown body",
      [{ id: "sl1", op: "scale", bodies: ["zz"], factor: 2 }],
      [/sl1: body refers to unknown or later feature "zz"/],
    ],
    [
      "a baseplate in a baseplate, with a pocket, and with both an outline and a drawer",
      [
        { id: "g1", op: "gridfinity", kind: "baseplate", units: [2, 2] },
        {
          id: "g2",
          op: "gridfinity",
          kind: "baseplate",
          units: [1, 1],
          baseplate: "g1",
          pocket: { body: "ex1" },
          outline: { sketch: "sk9" },
          drawer: [100, 100],
        },
      ],
      [
        /g2: a baseplate cannot sit in a baseplate/,
        /g2: outline refers to unknown or later feature "sk9"/,
        /g2: give a drawer or an outline, not both/,
        /g2: pocket is for bins/,
      ],
    ],
    [
      "a bin with a drawer, a fill and a pocket for an unknown body",
      [
        {
          id: "g3",
          op: "gridfinity",
          kind: "bin",
          units: [1, 1],
          drawer: [100, 100],
          fill: true,
          pocket: { body: "zz" },
        },
      ],
      [
        /g3: drawer is for baseplates/,
        /g3: outline, fill and bed are for baseplates/,
        /g3: pocket body refers to unknown or later feature "zz"/,
      ],
    ],
    [
      "a round box with a depth",
      [{ id: "bx1", op: "box", lid: "screw", width: 30, height: 20, depth: 10, plane: noPlane }],
      [/bx1: unknown plane "origin.XX"/, /bx1: a round box has no depth/],
    ],
    [
      "a snap hook on an unknown plane, catching in and joined to unknown bodies",
      [{ id: "sh1", op: "snap_hook", plane: noPlane, points: [[1, 1]], catchIn: ["zz"], targets: ["yy"] }],
      [/sh1: unknown plane "origin.XX"/, /sh1: body .*"zz"/, /sh1: body .*"yy"/],
    ],
    [
      "wall parts on the wrong board",
      [
        { id: "w1", op: "wall", system: "opengrid", kind: "board", units: [2, 2] },
        {
          id: "w2",
          op: "wall",
          system: "pegboard",
          kind: "holder",
          units: [1, 1],
          board: "w1",
          accessory: "screw",
          plane: noPlane,
        },
        { id: "w3", op: "wall", system: "opengrid", kind: "board", units: [1, 1], board: "w1" },
        { id: "w4", op: "wall", system: "pegboard", kind: "holder", units: [1, 1], board: "w2" },
      ],
      [
        /w2: unknown plane "origin.XX"/,
        /w2: "w1" is a opengrid board, not pegboard/,
        /w2: the screw snap is for openGrid boards/,
        /w3: a board cannot sit on a board/,
        /w4: "w2" is a holder, not a board/,
      ],
    ],
    [
      "a rib from an unknown sketch",
      [{ id: "rb1", op: "rib", sketch: "sk9", thickness: 2 }],
      [/rb1: sketch refers to unknown or later feature "sk9"/],
    ],
    [
      "a split with dovetails at points",
      [
        {
          id: "sp1",
          op: "split",
          plane: noPlane,
          bodies: ["zz"],
          connectors: { kind: "dovetail", points: [[1, 1]] },
        },
      ],
      [/sp1: unknown plane "origin.XX"/, /sp1: body .*"zz"/, /sp1: points are for pins and dowels/],
    ],
    [
      "a mesh conversion of an unknown body",
      [{ id: "mc1", op: "mesh_convert", body: "zz" }],
      [/mc1: body refers to unknown or later feature "zz"/],
    ],
  ])("refuses %s", (_name, extra, patterns) => {
    for (const pattern of patterns) refuses(doc([...base, ...extra]), pattern);
  });

  it("takes the curves of projected model edges as references, but not the projection itself", () => {
    const projection = { id: "pr1", type: "projection", edges: [{ edge: ["ex1.end_cap", "ex1.side"] }] };
    const withProjection = (line: string) =>
      doc([
        ...base,
        sk(
          {
            entities: [...rect.entities, projection] as typeof rect.entities,
            constraints: [{ id: "c1", type: "horizontal", line }],
          },
          "sk2",
        ),
      ]);

    expect(errorsOf(withProjection("pr1.0"))).toEqual([]);
    refuses(withProjection("pr1"), /c1 \(horizontal\) refers to unknown line "pr1"/);
  });

  it("names the sketch of a sketch profile and nothing for a face profile", () => {
    expect(profileSketch({ sketch: "sk1" })).toBe("sk1");
    expect(profileSketch({ face: { face: "ex1.end_cap" } })).toBeNull();
  });
});
