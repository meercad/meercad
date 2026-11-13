import Ajv, { type ErrorObject } from "ajv";
import { docOpSchema, documentSchema } from "./schema.js";
import {
  FORMAT,
  type DocOp,
  type EdgeSelector,
  type Feature,
  type MeercadDocument,
  type PlaneSpec,
  type SketchFeature,
} from "./types.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const checkDocumentShape = ajv.compile(documentSchema);
const checkOpShape = ajv.compile(docOpSchema);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  // `if/then` add a generic "must match then schema" per failure; the real cause is listed separately.
  const out = (errors ?? [])
    .filter((e) => e.keyword !== "if" && e.keyword !== "oneOf")
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}${formatParams(e)}`);

  return [...new Set(out)].slice(0, 20);
}

function formatParams(e: ErrorObject): string {
  if (e.keyword === "additionalProperties") return ` (${String(e.params["additionalProperty"])})`;
  if (e.keyword === "enum") return ` (${(e.params["allowedValues"] as unknown[]).join(", ")})`;
  if (e.keyword === "const") return ` (${JSON.stringify(e.params["allowedValue"])})`;

  return "";
}

const CURVE_POINTS: Record<string, string[]> = {
  line: ["p1", "p2"],
  circle: ["center"],
  arc: ["center", "start", "end"],
};

/** Ids a sketch exposes: entities and their characteristic points ("l1.p1", "c1.center"). */
export function sketchSymbols(sketch: SketchFeature): { points: Set<string>; curves: Map<string, string> } {
  const points = new Set<string>(["origin"]);
  const curves = new Map<string, string>();

  for (const entity of sketch.entities) {
    if (entity.type === "point") {
      points.add(entity.id);
    } else if (entity.type === "projection") {
      curves.set(entity.id, "projection");
    } else {
      curves.set(entity.id, entity.type);
      for (const pointName of CURVE_POINTS[entity.type] ?? []) points.add(`${entity.id}.${pointName}`);
    }
  }

  return { points, curves };
}

function checkSketch(sketch: SketchFeature, at: string, errors: string[]): void {
  const ids = new Set<string>();
  const types = new Map<string, string>();

  for (const entity of sketch.entities) {
    if (ids.has(entity.id)) errors.push(`${at}: duplicate entity id ${entity.id}`);

    ids.add(entity.id);
    types.set(entity.id, entity.type);
  }

  const isPoint = (pointId: string) => types.get(pointId) === "point";

  for (const entity of sketch.entities) {
    const refs =
      entity.type === "line"
        ? [entity.p1, entity.p2]
        : entity.type === "circle"
          ? [entity.center]
          : entity.type === "arc"
            ? [entity.center, entity.start, entity.end]
            : entity.type === "spline"
              ? entity.points
              : [];

    if (entity.type === "spline" && entity.closed && entity.points.length < 3) {
      errors.push(`${at}: closed spline ${entity.id} needs at least 3 points`);
    }

    for (const ref of refs) {
      if (!isPoint(ref)) errors.push(`${at}: entity ${entity.id} refers to missing point "${ref}"`);
    }
  }

  const { points, curves } = sketchSymbols(sketch);
  // Projected geometry exposes "<id>.<n>" curves and their points; only known at rebuild time.
  const projected = (ref: string) =>
    [...curves].some(([curveId, curveType]) => curveType === "projection" && ref.startsWith(`${curveId}.`));
  const isKnownPoint = (ref: string) => points.has(ref) || projected(ref);
  const isKnownCurve = (ref: string) =>
    (curves.has(ref) && curves.get(ref) !== "projection") ||
    projected(ref) ||
    ref === "origin.x" ||
    ref === "origin.y";
  const constraintIds = new Set<string>();

  for (const constraint of sketch.constraints) {
    if (constraintIds.has(constraint.id) || ids.has(constraint.id)) {
      errors.push(`${at}: duplicate constraint id ${constraint.id}`);
    }

    constraintIds.add(constraint.id);

    const reportUnknown = (what: string, ref: string) =>
      errors.push(
        `${at}: constraint ${constraint.id} (${constraint.type}) refers to unknown ${what} "${ref}"`,
      );

    switch (constraint.type) {
      case "coincident":
      case "horizontal_points":
      case "vertical_points":
        if (!isKnownPoint(constraint.a)) reportUnknown("point", constraint.a);
        if (!isKnownPoint(constraint.b)) reportUnknown("point", constraint.b);

        break;
      case "horizontal":
      case "vertical":
      case "length":
        if (!isKnownCurve(constraint.line)) reportUnknown("line", constraint.line);

        break;
      case "parallel":
      case "perpendicular":
      case "collinear":
      case "tangent":
      case "equal":
      case "angle":
        if (!isKnownCurve(constraint.a)) reportUnknown("curve", constraint.a);
        if (!isKnownCurve(constraint.b)) reportUnknown("curve", constraint.b);

        break;
      case "point_on":
        if (!isKnownPoint(constraint.point)) reportUnknown("point", constraint.point);
        if (!isKnownCurve(constraint.curve)) reportUnknown("curve", constraint.curve);

        break;
      case "midpoint":
        if (!isKnownPoint(constraint.point)) reportUnknown("point", constraint.point);
        if (!isKnownCurve(constraint.line)) reportUnknown("line", constraint.line);

        break;
      case "symmetric":
        if (!isKnownPoint(constraint.a)) reportUnknown("point", constraint.a);
        if (!isKnownPoint(constraint.b)) reportUnknown("point", constraint.b);
        if (!isKnownCurve(constraint.axis)) reportUnknown("line", constraint.axis);

        break;
      case "fix":
        if (!isKnownPoint(constraint.point)) reportUnknown("point", constraint.point);

        break;
      case "distance":
        if (!isKnownPoint(constraint.a)) reportUnknown("point", constraint.a);

        if (!isKnownPoint(constraint.b) && !isKnownCurve(constraint.b)) {
          reportUnknown("point or line", constraint.b);
        }

        break;
      case "radius":
      case "diameter":
        if (!isKnownCurve(constraint.curve)) reportUnknown("circle or arc", constraint.curve);

        break;
      case "arc_angle":
        if (!isKnownCurve(constraint.curve)) reportUnknown("arc", constraint.curve);

        break;
    }
  }
}

/**
 * Structural (JSON Schema) and referential validation of a document. Expressions are checked by the model.
 */
/** Formats written by earlier versions, read as the current one. */
export const LEGACY_FORMATS: readonly string[] = ["leocad/1"];

/**
 * Steps earlier versions had and this one no longer offers: "texture" (the surface pattern) and
 * "cable" (cables laid through points, removed Nov 2026).
 */
export const REMOVED_OPS: readonly string[] = ["texture", "cable"];

/** Fields of a step that name parts: a removed step's part is taken out of them. */
const PART_LISTS = ["bodies", "tools", "targets", "catchIn"] as const;
/** Fields that name one part: a step whose part is gone goes with it. */
const PART_FIELDS = ["target", "body"] as const;

/**
 * A design without the steps of REMOVED_OPS, and the ids of those it dropped. A texture only ever
 * changed the look of faces; a cable was a part of its own that nothing builds on. What named a
 * dropped cable lets go of it: later steps' part lists, joints that moved it (and their couplings
 * and moments in motions), its colour, material and place in the parts list. A step left with no
 * part to work on goes too. A rollback to a dropped step moves back to the step before. Anything
 * that is not a design comes back as it was.
 */
export function withoutRemovedFeatures<T>(input: T): { doc: T; removed: string[] } {
  const d = input as { features?: unknown; rollback?: unknown } & Record<string, unknown>;
  if (!d || typeof d !== "object" || !Array.isArray(d.features)) return { doc: input, removed: [] };

  const opOf = (f: unknown) => (f && typeof f === "object" ? (f as { op?: unknown }).op : undefined);
  const features = d.features as unknown[];
  if (!features.some((f) => REMOVED_OPS.includes(opOf(f) as string))) return { doc: input, removed: [] };

  const removed: string[] = [];
  /** Parts of dropped steps: the step's id, and its copies' ids ("<id>_…"). */
  const gonePart = (b: unknown) =>
    typeof b === "string" && removed.some((r) => b === r || b.startsWith(`${r}_`));
  const kept: unknown[] = [];
  let rollback = d.rollback;

  for (const f of features) {
    let step = f as Record<string, unknown>;
    let drop = REMOVED_OPS.includes(opOf(f) as string);

    if (!drop && step && typeof step === "object" && removed.length) {
      for (const k of PART_FIELDS) if (gonePart(step[k])) drop = true;

      for (const k of PART_LISTS) {
        const list = step[k];
        if (!Array.isArray(list) || !list.some(gonePart)) continue;

        const rest = list.filter((b) => !gonePart(b));
        if (!rest.length && k !== "targets" && k !== "catchIn") drop = true;

        step = { ...step, [k]: rest };
      }

      const source = step["source"] as { bodies?: unknown[] } | undefined;

      if (source && Array.isArray(source.bodies) && source.bodies.some(gonePart)) {
        const rest = source.bodies.filter((b) => !gonePart(b));
        if (!rest.length) drop = true;

        step = { ...step, source: { ...source, bodies: rest } };
      }
    }

    if (!drop) {
      kept.push(step);
      continue;
    }

    const id = (f as { id?: unknown }).id;
    if (typeof id === "string") removed.push(id);

    if (id !== undefined && id === rollback) {
      const before = kept[kept.length - 1] as { id?: unknown } | undefined;
      rollback = before && typeof before.id === "string" ? before.id : null;
    }
  }

  const out: Record<string, unknown> = { ...d, features: kept, ...("rollback" in d ? { rollback } : {}) };
  const without = (r: unknown) =>
    r && typeof r === "object" ? Object.fromEntries(Object.entries(r).filter(([k]) => !gonePart(k))) : r;
  const listWithout = (l: unknown) => (Array.isArray(l) ? l.filter((x) => !gonePart(x)) : l);
  for (const k of ["partColors", "partMaterials"]) if (k in d) out[k] = without(d[k]);
  for (const k of ["partOrder", "seeThrough"]) if (k in d) out[k] = listWithout(d[k]);

  if (Array.isArray(d["partGroups"])) {
    out["partGroups"] = (d["partGroups"] as { parts?: unknown }[]).map((g) => ({
      ...g,
      parts: listWithout(g.parts),
    }));
  }

  const mech = d["mechanism"] as
    | {
        joints?: { id: string; a?: unknown; b?: unknown }[];
        couplings?: { driver: string; driven: string }[];
        motions?: { keys?: { values?: Record<string, unknown> }[] }[];
      }
    | undefined;

  if (mech && Array.isArray(mech.joints) && mech.joints.some((j) => gonePart(j.a) || gonePart(j.b))) {
    const goneJoints = new Set(mech.joints.filter((j) => gonePart(j.a) || gonePart(j.b)).map((j) => j.id));
    const jointGone = (k: string) => goneJoints.has(k.replace(/\.(turn|slide)$/, ""));
    out["mechanism"] = {
      ...mech,
      joints: mech.joints.filter((j) => !goneJoints.has(j.id)),
      ...(mech.couplings
        ? { couplings: mech.couplings.filter((c) => !goneJoints.has(c.driver) && !goneJoints.has(c.driven)) }
        : {}),
      ...(mech.motions
        ? {
            motions: mech.motions.map((m) => ({
              ...m,
              keys: (m.keys ?? []).map((k) => ({
                ...k,
                values: Object.fromEntries(Object.entries(k.values ?? {}).filter(([j]) => !jointGone(j))),
              })),
            })),
          }
        : {}),
    };
  }

  return { doc: out as T, removed };
}

export function validateDocument(input: unknown): Validation<MeercadDocument> {
  // Files from before the rename (leocad) are the same format under another name.
  if (
    input &&
    typeof input === "object" &&
    LEGACY_FORMATS.includes((input as { format?: unknown }).format as string)
  ) {
    input = { ...input, format: FORMAT };
  }

  input = withoutRemovedFeatures(input).doc;
  if (!checkDocumentShape(input)) return { ok: false, errors: formatErrors(checkDocumentShape.errors) };

  const doc = input as MeercadDocument;
  const errors: string[] = [];
  const seen = new Map<string, Feature>();

  const earlier = (fid: string, at: string, what: string, ops?: string[]) => {
    const feature = seen.get(fid);

    if (!feature) {
      errors.push(`${at}: ${what} refers to unknown or later feature "${fid}"`);
    } else if (ops && !ops.includes(feature.op)) {
      errors.push(`${at}: ${what} "${fid}" must be a ${ops.join(" or ")}`);
    }
  };

  const planeSpec = (plane: PlaneSpec, at: string) => {
    if ("ref" in plane && !plane.ref.startsWith("origin.")) earlier(plane.ref, at, "plane", ["plane"]);

    if (
      "ref" in plane &&
      plane.ref.startsWith("origin.") &&
      !["origin.XY", "origin.XZ", "origin.YZ"].includes(plane.ref)
    ) {
      errors.push(`${at}: unknown plane "${plane.ref}"`);
    }
  };

  // A body id is a feature id, or a feature id with a copy suffix: pattern copies "lp1_2", transform copies
  // "tr1_ex1", mirror copies "mi1_ex1_1". Feature ids may hold underscores themselves ("tr_knee"), so the
  // longest earlier feature id the body id starts with is the one that made it.
  const bodyFeature = (b: string): string => {
    if (seen.has(b)) return b;

    const parts = b.split("_");

    for (let i = parts.length - 1; i > 0; i--) {
      const prefix = parts.slice(0, i).join("_");
      if (seen.has(prefix)) return prefix;
    }

    return parts[0]!;
  };

  const body = (b: string, at: string, what = "body") => earlier(bodyFeature(b), at, what);

  const edgeSelectors = (edges: EdgeSelector | EdgeSelector[], at: string) => {
    for (const sel of asArray(edges)) {
      if ("select" in sel && sel.of !== undefined) earlier(sel.of, at, "selector");
    }
  };

  for (const feature of doc.features) {
    const at = `feature ${feature.id}`;
    if (seen.has(feature.id)) errors.push(`${at}: duplicate id`);

    switch (feature.op) {
      case "sketch":
        planeSpec(feature.plane, at);
        checkSketch(feature, at, errors);
        break;
      case "plane":
        planeSpec(feature.base, at);
        break;
      case "extrude":
      case "revolve":
        if ("sketch" in feature.profile) earlier(feature.profile.sketch, at, "profile", ["sketch"]);

        if (feature.op === "extrude" && feature.extent === "two_sided" && feature.distance2 === undefined) {
          errors.push(`${at}: two_sided extrude needs distance2`);
        }

        if (feature.op === "revolve" && "line" in feature.axis) {
          earlier(feature.axis.line.split(".")[0]!, at, "axis", ["sketch"]);
        }

        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "loft":
        for (const profile of feature.profiles) {
          if ("sketch" in profile) earlier(profile.sketch, at, "profile", ["sketch"]);
        }

        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "sweep":
        if ("sketch" in feature.profile) earlier(feature.profile.sketch, at, "profile", ["sketch"]);

        earlier(feature.path.sketch, at, "path", ["sketch"]);
        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "fillet":
      case "chamfer":
        edgeSelectors(feature.edges, at);
        break;
      case "thread":
        if ("select" in feature.face && feature.face.of !== undefined) {
          earlier(feature.face.of, at, "selector");
        }

        break;
      case "coil":
        if ("sketch" in feature.profile) earlier(feature.profile.sketch, at, "profile", ["sketch"]);
        if ("line" in feature.axis) earlier(feature.axis.line.split(".")[0]!, at, "axis", ["sketch"]);

        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "spring":
      case "screw":
        if (feature.plane) planeSpec(feature.plane, at);

        if (feature.op === "screw" && feature.kind === "nut" && feature.head === "socket") {
          errors.push(`${at}: nuts are hex, round or knob`);
        }

        if (feature.op === "screw" && feature.kind === "nut" && feature.threadLength !== undefined) {
          errors.push(`${at}: threadLength is for screws`);
        }

        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "gear":
        if (feature.meshWith) earlier(feature.meshWith.gear, at, "meshWith", ["gear"]);
        else if (feature.module === undefined) errors.push(`${at}: a gear needs a module (or meshWith)`);
        if (feature.plane) planeSpec(feature.plane, at);
        if (feature.kind !== "spur" && feature.bore) errors.push(`${at}: only spur gears take a bore`);
        if (feature.kind !== "spur" && feature.hub) errors.push(`${at}: only spur gears take a hub`);

        if (feature.kind === "rack" && feature.chamfer !== undefined) {
          errors.push(`${at}: racks have no tooth chamfer yet`);
        }

        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "linear_pattern":
      case "circular_pattern":
      case "mirror": {
        const ids = "features" in feature.source ? feature.source.features : feature.source.bodies;
        if ("features" in feature.source) for (const s of ids) earlier(s, at, "pattern source");
        else for (const s of ids) body(s, at, "pattern source");
        if (feature.op === "mirror") planeSpec(feature.plane, at);

        break;
      }

      case "transform":
      case "delete":
        for (const b of feature.bodies) body(b, at);
        break;
      case "draft":
        planeSpec(feature.neutral, at);
        break;
      case "offset_face":
        if (feature.upTo) planeSpec(feature.upTo, at);

        break;
      case "lithophane":
        if (feature.plane) planeSpec(feature.plane, at);

        if (
          !feature.image.pixels.startsWith("blob:") &&
          feature.image.pixels.length !== Math.ceil((feature.image.width * feature.image.height) / 3) * 4
        ) {
          errors.push(`${at}: image.pixels must hold width × height bytes (base64)`);
        }

        break;
      case "scale":
        for (const b of feature.bodies) body(b, at);
        break;
      case "align":
        if ("face" in feature.from !== "face" in feature.to) {
          errors.push(`${at}: align needs two flat faces or two round faces (axisOf)`);
        }

        for (const b of feature.bodies ?? []) body(b, at);
        break;
      case "standard_part":
        planeSpec(feature.plane, at);
        if (feature.kind !== "magnet" && !feature.size) errors.push(`${at}: a ${feature.kind} needs a size`);

        break;
      case "primitive":
        if (feature.shape === "box" && !feature.size) errors.push(`${at}: a box needs a size [x, y, z]`);

        if (feature.shape !== "box" && feature.diameter === undefined) {
          errors.push(`${at}: a ${feature.shape} needs a diameter`);
        }

        if (feature.shape === "cylinder" && feature.height === undefined) {
          errors.push(`${at}: a cylinder needs a height`);
        }

        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "text":
        planeSpec(feature.plane, at);
        for (const t of feature.targets ?? []) body(t, at, "target body");
        break;
      case "gridfinity":
        if (feature.plane) planeSpec(feature.plane, at);

        if (feature.baseplate) {
          earlier(feature.baseplate, at, "baseplate", ["gridfinity"]);

          const bp = seen.get(feature.baseplate);

          if (bp && bp.op === "gridfinity" && bp.kind !== "baseplate") {
            errors.push(`${at}: "${feature.baseplate}" is a bin, not a baseplate`);
          }
        }

        if (feature.kind === "baseplate" && feature.baseplate) {
          errors.push(`${at}: a baseplate cannot sit in a baseplate`);
        }

        if (feature.kind === "bin" && feature.drawer) errors.push(`${at}: drawer is for baseplates`);

        if (feature.kind === "bin" && (feature.outline || feature.bed || feature.fill !== undefined)) {
          errors.push(`${at}: outline, fill and bed are for baseplates`);
        }

        if (feature.outline) earlier(feature.outline.sketch, at, "outline", ["sketch"]);
        if (feature.outline && feature.drawer) errors.push(`${at}: give a drawer or an outline, not both`);

        if (feature.pocket) {
          if (feature.kind !== "bin") errors.push(`${at}: pocket is for bins`);
          else body(feature.pocket.body, at, "pocket body");
        }

        if (
          !feature.units &&
          !(feature.kind === "bin" && feature.pocket) &&
          !(feature.kind === "baseplate" && (feature.drawer || feature.outline))
        ) {
          errors.push(`${at}: units are required`);
        }

        break;
      case "box":
        if (feature.plane) planeSpec(feature.plane, at);

        if (feature.lid === "screw" && feature.shape === "rect") {
          errors.push(`${at}: screw lids need a round box`);
        }

        if (feature.lid === "screw" && feature.depth !== undefined) {
          errors.push(`${at}: a round box has no depth (width is its diameter)`);
        }

        break;
      case "snap_hook":
        planeSpec(feature.plane, at);
        for (const b of feature.catchIn ?? []) body(b, at);
        for (const b of feature.targets ?? []) body(b, at);
        break;
      case "wall":
        if (feature.plane) planeSpec(feature.plane, at);

        if (feature.board) {
          earlier(feature.board, at, "board", ["wall"]);

          const bd = seen.get(feature.board);

          if (bd && bd.op === "wall" && bd.kind !== "board") {
            errors.push(`${at}: "${feature.board}" is a holder, not a board`);
          }

          if (bd && bd.op === "wall" && bd.system !== feature.system) {
            errors.push(`${at}: "${feature.board}" is a ${bd.system} board, not ${feature.system}`);
          }
        }

        if (feature.kind === "board" && feature.board) errors.push(`${at}: a board cannot sit on a board`);

        if (feature.accessory === "screw" && feature.system !== "opengrid") {
          errors.push(`${at}: the screw snap is for openGrid boards`);
        }

        break;
      case "label":
        if (feature.plane) planeSpec(feature.plane, at);

        if (!feature.text?.trim() && (feature.symbol ?? "none") === "none") {
          errors.push(`${at}: a label needs a text or a symbol`);
        }

        break;
      case "rib":
        earlier(feature.sketch, at, "sketch", ["sketch"]);
        break;
      case "split":
        planeSpec(feature.plane, at);
        for (const b of feature.bodies) body(b, at);

        if (feature.connectors && (feature.keep ?? "both") !== "both") {
          errors.push(`${at}: connectors need both pieces (keep "both")`);
        }

        if (feature.connectors?.points && feature.connectors.kind === "dovetail") {
          errors.push(`${at}: points are for pins and dowels`);
        }

        break;
      case "mesh_convert":
        body(feature.body, at);
        break;
      case "bend":
        for (const b of feature.bodies) body(b, at);

        if (
          feature.mode === "bend"
            ? feature.angle === undefined && feature.radius === undefined
            : feature.radius === undefined
        ) {
          errors.push(
            `${at}: ${feature.mode === "bend" ? "a bend needs an angle or a radius" : `${feature.mode} needs a radius`}`,
          );
        }

        break;
      case "hole":
        planeSpec(feature.plane, at);

        if (feature.kind === "simple" ? feature.diameter === undefined : !feature.size) {
          errors.push(
            `${at}: a ${feature.kind} hole needs ${feature.kind === "simple" ? "a diameter" : "a size such as M3"}`,
          );
        }

        break;
      case "boolean":
        for (const b of [feature.target, ...feature.tools]) body(b, at);
        if (feature.tools.includes(feature.target)) errors.push(`${at}: target cannot also be a tool`);

        break;
      default:
        break;
    }

    seen.set(feature.id, feature);
  }

  if (doc.variants) {
    const names = new Set<string>();

    for (const variant of doc.variants) {
      if (names.has(variant.name)) errors.push(`variant "${variant.name}": duplicate name`);

      names.add(variant.name);

      for (const p of Object.keys(variant.params)) {
        if (!(p in doc.params)) errors.push(`variant "${variant.name}": unknown parameter "${p}"`);
      }
    }
  }

  if (doc.variant !== undefined && !doc.variants?.some((variant) => variant.name === doc.variant)) {
    errors.push(`variant "${doc.variant}" is in use but not defined`);
  }

  if (doc.versions) {
    const names = new Set<string>();

    for (const version of doc.versions) {
      if (names.has(version.name)) errors.push(`version "${version.name}": duplicate name`);

      names.add(version.name);
    }
  }

  const mech = doc.mechanism;

  if (mech) {
    const jointIds = new Set<string>();

    for (const j of mech.joints) {
      const at = `joint ${j.id}`;
      if (jointIds.has(j.id)) errors.push(`${at}: duplicate id`);

      jointIds.add(j.id);
      if (j.a === j.b) errors.push(`${at}: a part cannot be jointed to itself`);
      if (j.a === "ground") errors.push(`${at}: the moving part cannot be the ground`);
      if ("gear" in j.anchor) earlier(j.anchor.gear, at, "gear", ["gear"]);
    }

    const motionIds = new Set<string>();

    for (const motion of mech.motions ?? []) {
      const at = `motion ${motion.id}`;
      if (motionIds.has(motion.id)) errors.push(`${at}: duplicate id`);

      motionIds.add(motion.id);

      for (const k of motion.keys) {
        if (k.at > motion.duration + 1e-9) {
          errors.push(`${at}: a moment at ${k.at} s lies after the end (${motion.duration} s)`);
        }

        // Cylindrical joints move as "<id>.turn" and "<id>.slide".
        for (const j of Object.keys(k.values)) {
          if (!jointIds.has(j.replace(/\.(turn|slide)$/, ""))) errors.push(`${at}: unknown joint "${j}"`);
        }
      }
    }

    for (const coupling of mech.couplings ?? []) {
      const at = `coupling ${coupling.id}`;

      for (const r of [coupling.driver, coupling.driven]) {
        if (!jointIds.has(r)) errors.push(`${at}: unknown joint "${r}"`);
      }

      if (coupling.driver === coupling.driven) errors.push(`${at}: a joint cannot drive itself`);
    }
  }

  if (doc.rollback !== null && !seen.has(doc.rollback)) {
    errors.push(`rollback: unknown feature "${doc.rollback}"`);
  }

  for (const n of doc.autoParams ?? []) {
    if (!(n in doc.params)) errors.push(`autoParams: unknown parameter "${n}"`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: doc };
}

export function validateOp(input: unknown): Validation<DocOp> {
  if (!checkOpShape(input)) return { ok: false, errors: formatErrors(checkOpShape.errors) };

  return { ok: true, value: input as DocOp };
}

export function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}
