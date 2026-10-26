/**
 * JSON Schema (draft-07) for the opencad document format and the
 * Operations-API. Single source of truth for validation of untrusted input
 * and for AI tool definitions.
 */

const id = { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", maxLength: 64 } as const;
const expr = {
  description: "Number in mm, or expression string using params, e.g. \"w\", \"wall * 2\", \"5 mm\".",
  oneOf: [{ type: "number" }, { type: "string", minLength: 1, maxLength: 256 }],
} as const;
const faceTag = {
  type: "string",
  minLength: 1,
  maxLength: 256,
  description:
    "Face tag, e.g. \"ex1.end_cap\", \"ex1.start_cap\", \"ex1.side[sk1.r1.top]\". Suffix [*] matches all tags with that prefix.",
} as const;
const common = { id, suppressed: { type: "boolean" } } as const;

export const definitions = {
  expr,
  faceTag,
  edgeSelector: {
    oneOf: [
      {
        type: "object",
        description: "The single edge shared by two tagged faces.",
        properties: { edge: { type: "array", items: faceTag, minItems: 2, maxItems: 2 } },
        required: ["edge"],
        additionalProperties: false,
      },
      {
        type: "object",
        description:
          "All edges bounding faces matching where.face. A tag without a dot is relative to `of` (feature id).",
        properties: {
          select: { const: "edges" },
          of: id,
          where: {
            type: "object",
            properties: { face: faceTag },
            additionalProperties: false,
          },
        },
        required: ["select"],
        additionalProperties: false,
      },
    ],
  },
  sketch: {
    type: "object",
    properties: {
      ...common,
      op: { const: "sketch" },
      plane: {
        type: "object",
        properties: { ref: { enum: ["origin.XY", "origin.XZ", "origin.YZ"] } },
        required: ["ref"],
        additionalProperties: false,
      },
      entities: {
        type: "array",
        maxItems: 1000,
        items: {
          type: "object",
          description:
            "Rectangle with lower-left corner and size [width, height]. Its edges are named bottom, right, top, left; its region is <sketch>.<entity>.region.",
          properties: {
            id,
            type: { const: "rectangle" },
            corner: { type: "array", items: { $ref: "#/definitions/expr" }, minItems: 2, maxItems: 2 },
            size: { type: "array", items: { $ref: "#/definitions/expr" }, minItems: 2, maxItems: 2 },
          },
          required: ["id", "type", "corner", "size"],
          additionalProperties: false,
        },
      },
      constraints: {
        type: "array",
        maxItems: 1000,
        items: { type: "object", properties: { type: { type: "string" } }, required: ["type"] },
      },
    },
    required: ["id", "op", "plane", "entities"],
    additionalProperties: false,
  },
  extrude: {
    type: "object",
    properties: {
      ...common,
      op: { const: "extrude" },
      profile: {
        type: "object",
        properties: { ref: { type: "string", description: "e.g. \"sk1.r1.region\"" } },
        required: ["ref"],
        additionalProperties: false,
      },
      distance: { $ref: "#/definitions/expr" },
      mode: { enum: ["new_body"] },
    },
    required: ["id", "op", "profile", "distance", "mode"],
    additionalProperties: false,
  },
  fillet: {
    type: "object",
    properties: {
      ...common,
      op: { const: "fillet" },
      edges: {
        oneOf: [
          { $ref: "#/definitions/edgeSelector" },
          { type: "array", items: { $ref: "#/definitions/edgeSelector" }, minItems: 1 },
        ],
      },
      radius: { $ref: "#/definitions/expr" },
    },
    required: ["id", "op", "edges", "radius"],
    additionalProperties: false,
  },
  feature: {
    type: "object",
    required: ["op"],
    properties: { op: { enum: ["sketch", "extrude", "fillet"] } },
    allOf: [
      { if: { properties: { op: { const: "sketch" } } }, then: { $ref: "#/definitions/sketch" } },
      { if: { properties: { op: { const: "extrude" } } }, then: { $ref: "#/definitions/extrude" } },
      { if: { properties: { op: { const: "fillet" } } }, then: { $ref: "#/definitions/fillet" } },
    ],
  },
} as const;

export const documentSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://opencad.dev/schema/document.json",
  type: "object",
  properties: {
    format: { const: "opencad/1" },
    params: {
      type: "object",
      propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" },
      additionalProperties: { $ref: "#/definitions/expr" },
    },
    features: { type: "array", maxItems: 10000, items: { $ref: "#/definitions/feature" } },
    rollback: { oneOf: [{ type: "null" }, id] },
  },
  required: ["format", "params", "features", "rollback"],
  additionalProperties: false,
  definitions,
} as const;

export const docOpSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://opencad.dev/schema/op.json",
  type: "object",
  required: ["type"],
  properties: {
    type: { enum: ["add_features", "edit_feature", "delete_feature", "set_param", "set_rollback", "replace"] },
  },
  allOf: [
    {
      if: { properties: { type: { const: "add_features" } } },
      then: {
        properties: {
          type: true,
          features: { type: "array", items: { $ref: "#/definitions/feature" }, minItems: 1 },
          after: { oneOf: [{ type: "null" }, id] },
        },
        required: ["features"],
        additionalProperties: false,
      },
    },
    {
      if: { properties: { type: { const: "edit_feature" } } },
      then: {
        properties: { type: true, id, patch: { type: "object" } },
        required: ["id", "patch"],
        additionalProperties: false,
      },
    },
    {
      if: { properties: { type: { const: "delete_feature" } } },
      then: { properties: { type: true, id }, required: ["id"], additionalProperties: false },
    },
    {
      if: { properties: { type: { const: "set_param" } } },
      then: {
        properties: {
          type: true,
          name: id,
          expr: { oneOf: [{ type: "null" }, { $ref: "#/definitions/expr" }] },
        },
        required: ["name", "expr"],
        additionalProperties: false,
      },
    },
    {
      if: { properties: { type: { const: "set_rollback" } } },
      then: { properties: { type: true, id: { oneOf: [{ type: "null" }, id] } }, required: ["id"], additionalProperties: false },
    },
    {
      if: { properties: { type: { const: "replace" } } },
      then: { properties: { type: true, doc: { type: "object" } }, required: ["doc"], additionalProperties: false },
    },
  ],
  definitions,
} as const;
