/**
 * JSON Schema (draft-07) for the meerCAD document format and the Operations-API.
 * Single source of truth for validation of untrusted input and for AI tool definitions.
 */

type Json = Record<string, unknown>;

const ID = "^[A-Za-z_][A-Za-z0-9_]*$";
const id = { type: "string", pattern: ID, maxLength: 64 };
const ref = (name: string) => ({ $ref: `#/definitions/${name}` });
const str = (description?: string) => ({ type: "string", minLength: 1, maxLength: 512, ...(description ? { description } : {}) });
const bool = { type: "boolean" };
const num = { type: "number" };
const vec3 = { type: "array", items: num, minItems: 3, maxItems: 3 };
const vec2 = { type: "array", items: num, minItems: 2, maxItems: 2 };
const arr = (items: Json, extra: Json = {}) => ({ type: "array", items, maxItems: 10000, ...extra });
const obj = (properties: Json, required: string[], description?: string): Json => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...(description ? { description } : {}),
});
const oneOf = (...schemas: Json[]) => ({ oneOf: schemas });
/** Discriminated union on `key` without oneOf's confusing error output. */
const tagged = (key: string, variants: Record<string, Json>): Json => ({
  type: "object",
  required: [key],
  properties: { [key]: { enum: Object.keys(variants) } },
  allOf: Object.entries(variants).map(([k, s]) => ({ if: { properties: { [key]: { const: k } } }, then: s })),
});

const base = { id, name: { type: "string", maxLength: 128 }, suppressed: bool };
const feature = (op: string, props: Json, required: string[]) =>
  obj({ ...base, op: { const: op }, ...props }, ["id", "op", ...required]);

const expr = {
  description: 'Number (mm or degrees), or expression using params: "w", "wall * 2", "5 mm", "30 deg".',
  oneOf: [{ type: "number" }, { type: "string", minLength: 1, maxLength: 256 }],
};

const constraintVariants: Record<string, Json> = {};
const c = (type: string | string[], props: Json, required: string[]) => {
  for (const t of [type].flat()) {
    constraintVariants[t] = obj({ id, type: { const: t }, ...props }, ["id", "type", ...required]);
  }
};
const label = vec2;
c("coincident", { a: str(), b: str() }, ["a", "b"]);
c(["horizontal", "vertical"], { line: str() }, ["line"]);
c(["horizontal_points", "vertical_points"], { a: str(), b: str() }, ["a", "b"]);
c(["parallel", "perpendicular", "collinear", "tangent", "equal"], { a: str(), b: str() }, ["a", "b"]);
c("point_on", { point: str(), curve: str() }, ["point", "curve"]);
c("midpoint", { point: str(), line: str() }, ["point", "line"]);
c("symmetric", { a: str(), b: str(), axis: str() }, ["a", "b", "axis"]);
c("fix", { point: str() }, ["point"]);
c("distance", { a: str(), b: str(), value: ref("expr"), axis: { enum: ["x", "y"] }, label }, ["a", "b", "value"]);
c("length", { line: str(), value: ref("expr"), label }, ["line", "value"]);
c(["radius", "diameter"], { curve: str(), value: ref("expr"), label }, ["curve", "value"]);
c("angle", { a: str(), b: str(), value: ref("expr"), label }, ["a", "b", "value"]);
c("arc_angle", { curve: str(), value: ref("expr"), label }, ["curve", "value"]);

const construction = { construction: bool };

export const definitions: Record<string, Json> = {
  expr,
  faceTag: str('Face tag, e.g. "ex1.end_cap", "ex1.side[sk1.l1]". Suffix [*] matches by prefix.'),
  faceSelector: oneOf(
    obj({ face: ref("faceTag"), near: vec3 }, ["face"], "Faces with this tag; `near` picks the closest when several share it."),
    obj(
      {
        select: { const: "faces" },
        of: id,
        where: obj({ planar: bool, normal: { enum: ["+X", "-X", "+Y", "-Y", "+Z", "-Z"] }, tag: ref("faceTag") }, []),
        pick: { enum: ["largest", "smallest"] },
      },
      ["select"],
    ),
  ),
  edgeSelector: oneOf(
    obj({ edge: arr(ref("faceTag"), { minItems: 2, maxItems: 2 }), near: vec3 }, ["edge"], "The edge shared by two tagged faces."),
    obj({ select: { const: "edges" }, of: id, where: obj({ face: ref("faceTag") }, []) }, ["select"], "All edges around faces matching where.face (relative to `of`)."),
  ),
  edges: oneOf(ref("edgeSelector"), arr(ref("edgeSelector"), { minItems: 1 })),
  planeSpec: oneOf(
    obj({ ref: str('"origin.XY", "origin.XZ", "origin.YZ" or a plane feature id') }, ["ref"]),
    obj({ face: ref("faceSelector") }, ["face"]),
  ),
  axisRef: oneOf(
    obj({ ref: { enum: ["origin.X", "origin.Y", "origin.Z"] } }, ["ref"]),
    obj({ line: str('Sketch line, e.g. "sk1.l3"') }, ["line"]),
    obj({ edge: ref("edgeSelector") }, ["edge"]),
  ),
  profile: oneOf(
    obj(
      { sketch: id, regions: oneOf({ const: "all" }, arr({ type: "string", maxLength: 1024 }, { minItems: 1 })) },
      ["sketch"],
      'Sketch regions; "all" (default) takes regions at odd nesting depth, so circles inside a rectangle become holes.',
    ),
    obj({ face: ref("faceSelector") }, ["face"], "A model face pushed/pulled: a flat face along its normal, a curved one offset along its surface."),
  ),
  patternSource: oneOf(obj({ features: arr(id, { minItems: 1 }) }, ["features"]), obj({ bodies: arr(id, { minItems: 1 }) }, ["bodies"])),
  mode: { enum: ["new_body", "join", "cut", "intersect"] },
  entity: tagged("type", {
    point: obj({ id, type: { const: "point" }, x: num, y: num, ...construction }, ["id", "type", "x", "y"]),
    line: obj({ id, type: { const: "line" }, p1: id, p2: id, ...construction }, ["id", "type", "p1", "p2"]),
    circle: obj({ id, type: { const: "circle" }, center: id, radius: { type: "number", exclusiveMinimum: 0 }, ...construction }, ["id", "type", "center", "radius"]),
    arc: obj({ id, type: { const: "arc" }, center: id, start: id, end: id, ...construction }, ["id", "type", "center", "start", "end"]),
    spline: obj({ id, type: { const: "spline" }, points: arr(id, { minItems: 2, maxItems: 500 }), closed: bool, ...construction }, ["id", "type", "points"], "Smooth curve through the points, in order."),
    projection: obj({ id, type: { const: "projection" }, edges: arr(ref("edgeSelector"), { minItems: 1 }), ...construction }, ["id", "type", "edges"]),
  }),
  constraint: tagged("type", constraintVariants),
  jointAnchor: oneOf(
    obj({ axisOf: ref("faceSelector") }, ["axisOf"]),
    obj({ edge: ref("edgeSelector") }, ["edge"]),
    obj({ axis: obj({ ref: { enum: ["origin.X", "origin.Y", "origin.Z"] } }, ["ref"]) }, ["axis"]),
    obj({ gear: id }, ["gear"]),
  ),
  joint: obj(
    {
      id,
      name: { type: "string", maxLength: 128 },
      type: { enum: ["revolute", "slider", "cylindrical", "fixed"] },
      a: { type: "string", minLength: 1, maxLength: 128 },
      b: { type: "string", minLength: 1, maxLength: 128 },
      anchor: ref("jointAnchor"),
      limits: arr(ref("expr"), { minItems: 2, maxItems: 2 }),
      travel: arr(ref("expr"), { minItems: 2, maxItems: 2 }),
      suppressed: bool,
    },
    ["id", "type", "a", "b", "anchor"],
  ),
  coupling: obj({ id, name: { type: "string", maxLength: 128 }, driver: id, driven: id, ratio: ref("expr") }, ["id", "driver", "driven", "ratio"]),
  reference: obj(
    {
      id,
      name: { type: "string", maxLength: 256 },
      format: { const: "glb" },
      data: { type: "string", maxLength: 256 * 1024 * 1024 },
      hidden: bool,
      scale: { type: "number", exclusiveMinimum: 0 },
      geo: obj({ lat: { type: "number" }, lon: { type: "number" }, alt: { type: "number" } }, ["lat", "lon", "alt"]),
      marks: arr(
        obj(
          {
            id,
            kind: { enum: ["line", "area", "note", "point", "stroke"] },
            points: arr(arr({ type: "number" }, { minItems: 3, maxItems: 3 }), { minItems: 1, maxItems: 10_000 }),
            color: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" },
            text: { type: "string", maxLength: 2000 },
            width: { type: "number", exclusiveMinimum: 0 },
          },
          ["id", "kind", "points", "color"],
        ),
      ),
    },
    ["id", "name", "format", "data"],
  ),
  feature: tagged("op", {
    sketch: feature("sketch", { plane: ref("planeSpec"), entities: arr(ref("entity")), constraints: arr(ref("constraint")) }, ["plane", "entities", "constraints"]),
    plane: feature("plane", { base: ref("planeSpec"), offset: ref("expr"), angle: ref("expr") }, ["base", "offset"]),
    extrude: feature(
      "extrude",
      {
        profile: ref("profile"),
        extent: { enum: ["blind", "symmetric", "two_sided", "through_all"] },
        distance: ref("expr"),
        distance2: ref("expr"),
        flip: bool,
        mode: ref("mode"),
        targets: arr(id),
      },
      ["profile", "extent", "distance", "mode"],
    ),
    revolve: feature(
      "revolve",
      { profile: ref("profile"), axis: ref("axisRef"), angle: ref("expr"), symmetric: bool, mode: ref("mode"), targets: arr(id) },
      ["profile", "axis", "angle", "mode"],
    ),
    scale: feature("scale", { bodies: arr(id, { minItems: 1 }), factor: ref("expr"), center: { enum: ["part", "origin"] } }, ["bodies", "factor"]),
    align: feature(
      "align",
      {
        bodies: arr(id),
        from: oneOf(obj({ face: ref("faceSelector") }, ["face"]), obj({ axisOf: ref("faceSelector") }, ["axisOf"])),
        to: oneOf(obj({ face: ref("faceSelector") }, ["face"]), obj({ axisOf: ref("faceSelector") }, ["axisOf"])),
        offset: ref("expr"),
        angle: ref("expr"),
        flip: bool,
      },
      ["from", "to"],
    ),
    standard_part: feature(
      "standard_part",
      {
        kind: { enum: ["socket_screw", "countersunk_screw", "hex_screw", "set_screw", "hex_nut", "washer", "insert", "bearing", "magnet"] },
        size: { type: "string", maxLength: 16 },
        length: ref("expr"),
        diameter: ref("expr"),
        height: ref("expr"),
        plane: ref("planeSpec"),
        points: arr(arr(ref("expr"), { minItems: 2, maxItems: 2 }), { minItems: 1, maxItems: 500 }),
        flip: bool,
      },
      ["kind", "plane", "points"],
    ),
    text: feature(
      "text",
      {
        plane: ref("planeSpec"),
        text: { type: "string", minLength: 1, maxLength: 2000 },
        position: arr(ref("expr"), { minItems: 2, maxItems: 2 }),
        size: ref("expr"),
        angle: ref("expr"),
        font: { enum: ["sans", "sans-bold", "mono"] },
        align: { enum: ["left", "center", "right"] },
        depth: ref("expr"),
        mode: ref("mode"),
        targets: arr(id),
        flip: bool,
      },
      ["plane", "text", "size", "depth", "mode"],
    ),
    draft: feature("draft", { faces: arr(ref("faceSelector"), { minItems: 1 }), angle: ref("expr"), neutral: ref("planeSpec"), flip: bool }, ["faces", "angle", "neutral"]),
    offset_face: feature("offset_face", { faces: arr(ref("faceSelector"), { minItems: 1 }), distance: ref("expr"), upTo: ref("planeSpec") }, ["faces", "distance"]),
    rib: feature("rib", { sketch: id, curves: arr({ type: "string", maxLength: 256 }, { minItems: 1 }), thickness: ref("expr"), flip: bool }, ["sketch", "thickness"]),
    split: feature("split", { plane: ref("planeSpec"), bodies: arr(id), keep: { enum: ["both", "front", "back"] } }, ["plane", "bodies"]),
    loft: feature(
      "loft",
      { profiles: arr(ref("profile"), { minItems: 2, maxItems: 50 }), ruled: bool, mode: ref("mode"), targets: arr(id) },
      ["profiles", "mode"],
    ),
    sweep: feature(
      "sweep",
      {
        profile: ref("profile"),
        path: obj({ sketch: id, curves: arr({ type: "string", maxLength: 256 }, { minItems: 1 }) }, ["sketch"], "Lines and arcs of a sketch, chained end to end; all non-construction curves unless listed."),
        mode: ref("mode"),
        targets: arr(id),
      },
      ["profile", "path", "mode"],
    ),
    fillet: feature("fillet", { edges: ref("edges"), radius: ref("expr"), radius2: ref("expr") }, ["edges", "radius"]),
    chamfer: feature("chamfer", { edges: ref("edges"), distance: ref("expr") }, ["edges", "distance"]),
    shell: feature("shell", { faces: arr(ref("faceSelector")), thickness: ref("expr"), outward: bool }, ["faces", "thickness"]),
    thread: feature(
      "thread",
      { face: ref("faceSelector"), size: { type: "string", pattern: "^M\\d+(\\.\\d+)?$", maxLength: 8 }, pitch: ref("expr"), length: ref("expr"), clearance: ref("expr"), leftHanded: bool },
      ["face"],
    ),
    gear: feature(
      "gear",
      {
        kind: { enum: ["spur", "internal", "rack"] },
        module: ref("expr"),
        teeth: ref("expr"),
        width: ref("expr"),
        pressureAngle: ref("expr"),
        profileShift: ref("expr"),
        helix: ref("expr"),
        herringbone: bool,
        backlash: ref("expr"),
        clearance: ref("expr"),
        plane: ref("planeSpec"),
        center: arr(ref("expr"), { minItems: 2, maxItems: 2 }),
        rotation: ref("expr"),
        meshWith: obj({ gear: id, direction: ref("expr") }, ["gear"]),
        chamfer: ref("expr"),
        rim: ref("expr"),
        bore: obj({ diameter: ref("expr"), allowance: ref("expr"), shape: { enum: ["round", "d_flat", "hex"] }, flat: ref("expr") }, ["diameter"]),
        hub: obj({ diameter: ref("expr"), length: ref("expr"), side: { enum: ["front", "back", "both"] } }, ["diameter", "length"]),
        mode: ref("mode"),
        targets: arr(id),
      },
      ["kind", "teeth", "width", "mode"],
    ),
    linear_pattern: feature(
      "linear_pattern",
      {
        source: ref("patternSource"),
        direction: ref("axisRef"),
        count: ref("expr"),
        spacing: ref("expr"),
        direction2: ref("axisRef"),
        count2: ref("expr"),
        spacing2: ref("expr"),
      },
      ["source", "direction", "count", "spacing"],
    ),
    circular_pattern: feature("circular_pattern", { source: ref("patternSource"), axis: ref("axisRef"), count: ref("expr"), angle: ref("expr") }, ["source", "axis", "count"]),
    mirror: feature("mirror", { source: ref("patternSource"), plane: ref("planeSpec") }, ["source", "plane"]),
    boolean: feature(
      "boolean",
      { operation: { enum: ["union", "subtract", "intersect"] }, target: id, tools: arr(id, { minItems: 1 }), keepTools: bool },
      ["operation", "target", "tools"],
    ),
    transform: feature(
      "transform",
      {
        bodies: arr(id, { minItems: 1 }),
        translate: arr(ref("expr"), { minItems: 3, maxItems: 3 }),
        rotate: obj({ axis: ref("axisRef"), angle: ref("expr") }, ["axis", "angle"]),
        copy: bool,
      },
      ["bodies"],
    ),
    delete: feature("delete", { bodies: arr(id, { minItems: 1 }) }, ["bodies"]),
    hole: feature(
      "hole",
      {
        plane: ref("planeSpec"),
        points: arr(arr(ref("expr"), { minItems: 2, maxItems: 2 }), { minItems: 1, maxItems: 500 }),
        kind: { enum: ["simple", "clearance", "counterbore", "countersink", "tapped", "insert"] },
        size: { type: "string", pattern: "^M\\d+(\\.\\d+)?$", maxLength: 8 },
        diameter: ref("expr"),
        fit: { enum: ["close", "normal", "loose"] },
        depth: ref("expr"),
        allowance: ref("expr"),
        flip: bool,
      },
      ["plane", "points", "kind"],
    ),
    mesh_convert: feature("mesh_convert", { body: id, tolerance: ref("expr"), angle: ref("expr") }, ["body"]),
    import: feature(
      "import",
      {
        format: { enum: ["step", "stl"] },
        fileName: { type: "string", maxLength: 256 },
        data: { type: "string", maxLength: 64 * 1024 * 1024 },
        split: bool,
        texture: {
          type: "object",
          additionalProperties: false,
          required: ["image", "mime", "uvs"],
          properties: { image: { type: "string", maxLength: 32 * 1024 * 1024 }, mime: { enum: ["image/jpeg", "image/png"] }, uvs: { type: "string", maxLength: 64 * 1024 * 1024 }, hidden: bool },
        },
      },
      ["format", "fileName", "data"],
    ),
  }),
};

/** A variant's name: shown in the variables list, e.g. "M8" or "Pipe 25 mm". */
const VARIANT_NAME = { type: "string", minLength: 1, maxLength: 64 } as const;
/** A version's name, e.g. "Before the fillets" or "Sent to the workshop". */
const VERSION_NAME = { type: "string", minLength: 1, maxLength: 80 } as const;

export const documentSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://meercad.dev/schema/document.json",
  ...obj(
    {
      format: { const: "meercad/1" },
      params: { type: "object", propertyNames: { pattern: ID }, additionalProperties: ref("expr") },
      autoParams: arr(id),
      partOrder: arr({ type: "string", maxLength: 128 }),
      partColors: { type: "object", propertyNames: { maxLength: 128 }, additionalProperties: { type: "string", pattern: "^#[0-9a-fA-F]{6}$" } },
      seeThrough: arr({ type: "string", maxLength: 128 }),
      partMaterials: { type: "object", propertyNames: { maxLength: 128 }, additionalProperties: { type: "string", pattern: "^[a-z0-9]{1,32}$" } },
      partGroups: arr(obj({ name: { type: "string", minLength: 1, maxLength: 128 }, parts: arr({ type: "string", maxLength: 128 }) }, ["name", "parts"])),
      units: { enum: ["mm", "in"] },
      features: arr(ref("feature")),
      mechanism: obj({ joints: arr(ref("joint")), couplings: arr(ref("coupling")), clearance: ref("expr") }, ["joints"]),
      references: arr(ref("reference")),
      variants: arr(obj({ name: VARIANT_NAME, params: { type: "object", propertyNames: { pattern: ID }, additionalProperties: ref("expr") } }, ["name", "params"])),
      variant: VARIANT_NAME,
      // A version's state is checked when it is restored, as the whole document it then becomes.
      versions: arr(obj({ name: VERSION_NAME, at: { type: "number" }, state: { type: "object" } }, ["name", "at", "state"])),
      blobs: { type: "object", propertyNames: { pattern: "^blob:[0-9a-z:]{1,64}$" }, additionalProperties: { type: "string", maxLength: 64 * 1024 * 1024 } },
      rollback: oneOf({ type: "null" }, id),
    },
    ["format", "params", "features", "rollback"],
  ),
  definitions,
};

export const docOpSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://meercad.dev/schema/op.json",
  ...tagged("type", {
    add_features: obj({ type: true, features: arr(ref("feature"), { minItems: 1 }), after: oneOf({ type: "null" }, id) }, ["features"]),
    edit_feature: obj({ type: true, id, patch: { type: "object" } }, ["id", "patch"]),
    delete_feature: obj({ type: true, id }, ["id"]),
    move_feature: obj({ type: true, id, after: oneOf({ type: "null" }, id) }, ["id", "after"]),
    set_param: obj({ type: true, name: id, expr: oneOf({ type: "null" }, ref("expr")), auto: bool }, ["name", "expr"]),
    rename_param: obj({ type: true, name: id, to: id }, ["name", "to"]),
    set_rollback: obj({ type: true, id: oneOf({ type: "null" }, id) }, ["id"]),
    replace: obj({ type: true, doc: { type: "object" } }, ["doc"]),
    set_part_color: obj({ type: true, part: id, color: oneOf({ type: "null" }, { type: "string", pattern: "^#[0-9a-fA-F]{6}$" }) }, ["part", "color"]),
    set_see_through: obj({ type: true, parts: arr(id), on: bool }, ["parts", "on"]),
    set_part_list: obj({ type: true, groups: oneOf({ type: "null" }, arr(obj({ name: { type: "string", minLength: 1, maxLength: 80 }, parts: arr(id) }, ["name", "parts"]))), order: oneOf({ type: "null" }, arr(id)) }, []),
    set_units: obj({ type: true, units: { enum: ["mm", "in"] } }, ["units"]),
    set_joint: obj({ type: true, joint: ref("joint") }, ["joint"]),
    delete_joint: obj({ type: true, id }, ["id"]),
    set_coupling: obj({ type: true, coupling: ref("coupling") }, ["coupling"]),
    delete_coupling: obj({ type: true, id }, ["id"]),
    set_reference: obj({ type: true, reference: ref("reference") }, ["reference"]),
    delete_reference: obj({ type: true, id }, ["id"]),
    set_material: obj({ type: true, part: id, material: oneOf({ type: "null" }, { type: "string", pattern: "^[a-z0-9]{1,32}$" }) }, ["part", "material"]),
    set_variant: obj({ type: true, name: VARIANT_NAME, params: { type: "object", propertyNames: { pattern: ID }, additionalProperties: ref("expr") }, rename: VARIANT_NAME }, ["name", "params"]),
    delete_variant: obj({ type: true, name: VARIANT_NAME }, ["name"]),
    use_variant: obj({ type: true, name: oneOf({ type: "null" }, VARIANT_NAME) }, ["name"]),
    save_version: obj({ type: true, name: VERSION_NAME }, ["name"]),
    restore_version: obj({ type: true, name: VERSION_NAME }, ["name"]),
    rename_version: obj({ type: true, name: VERSION_NAME, to: VERSION_NAME }, ["name", "to"]),
    delete_version: obj({ type: true, name: VERSION_NAME }, ["name"]),
  }),
  definitions,
};
