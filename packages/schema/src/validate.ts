import Ajv, { type ErrorObject } from "ajv";
import { docOpSchema, documentSchema } from "./schema.js";
import { FORMAT, type DocOp, type EdgeSelector, type Feature, type MeercadDocument, type PlaneSpec, type SketchFeature } from "./types.js";

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

const CURVE_POINTS: Record<string, string[]> = { line: ["p1", "p2"], circle: ["center"], arc: ["center", "start", "end"] };

/** Ids a sketch exposes: entities and their characteristic points ("l1.p1", "c1.center"). */
export function sketchSymbols(sk: SketchFeature): { points: Set<string>; curves: Map<string, string> } {
  const points = new Set<string>(["origin"]);
  const curves = new Map<string, string>();
  for (const e of sk.entities) {
    if (e.type === "point") points.add(e.id);
    else if (e.type === "projection") curves.set(e.id, "projection");
    else {
      curves.set(e.id, e.type);
      for (const p of CURVE_POINTS[e.type] ?? []) points.add(`${e.id}.${p}`);
    }
  }
  return { points, curves };
}

function checkSketch(sk: SketchFeature, at: string, errors: string[]): void {
  const ids = new Set<string>();
  const types = new Map<string, string>();
  for (const e of sk.entities) {
    if (ids.has(e.id)) errors.push(`${at}: duplicate entity id ${e.id}`);
    ids.add(e.id);
    types.set(e.id, e.type);
  }
  const isPoint = (pid: string) => types.get(pid) === "point";
  for (const e of sk.entities) {
    const refs = e.type === "line" ? [e.p1, e.p2] : e.type === "circle" ? [e.center] : e.type === "arc" ? [e.center, e.start, e.end] : e.type === "spline" ? e.points : [];
    if (e.type === "spline" && e.closed && e.points.length < 3) errors.push(`${at}: closed spline ${e.id} needs at least 3 points`);
    for (const r of refs) if (!isPoint(r)) errors.push(`${at}: entity ${e.id} refers to missing point "${r}"`);
  }
  const { points, curves } = sketchSymbols(sk);
  // Projected geometry exposes "<id>.<n>" curves and their points; only known at rebuild time.
  const projected = (r: string) => [...curves].some(([cid, t]) => t === "projection" && r.startsWith(`${cid}.`));
  const point = (r: string) => points.has(r) || projected(r);
  const curve = (r: string) => (curves.has(r) && curves.get(r) !== "projection") || projected(r) || r === "origin.x" || r === "origin.y";
  const cids = new Set<string>();
  for (const c of sk.constraints) {
    if (cids.has(c.id) || ids.has(c.id)) errors.push(`${at}: duplicate constraint id ${c.id}`);
    cids.add(c.id);
    const bad = (what: string, r: string) => errors.push(`${at}: constraint ${c.id} (${c.type}) refers to unknown ${what} "${r}"`);
    switch (c.type) {
      case "coincident":
      case "horizontal_points":
      case "vertical_points":
        if (!point(c.a)) bad("point", c.a);
        if (!point(c.b)) bad("point", c.b);
        break;
      case "horizontal":
      case "vertical":
      case "length":
        if (!curve(c.line)) bad("line", c.line);
        break;
      case "parallel":
      case "perpendicular":
      case "collinear":
      case "tangent":
      case "equal":
      case "angle":
        if (!curve(c.a)) bad("curve", c.a);
        if (!curve(c.b)) bad("curve", c.b);
        break;
      case "point_on":
        if (!point(c.point)) bad("point", c.point);
        if (!curve(c.curve)) bad("curve", c.curve);
        break;
      case "midpoint":
        if (!point(c.point)) bad("point", c.point);
        if (!curve(c.line)) bad("line", c.line);
        break;
      case "symmetric":
        if (!point(c.a)) bad("point", c.a);
        if (!point(c.b)) bad("point", c.b);
        if (!curve(c.axis)) bad("line", c.axis);
        break;
      case "fix":
        if (!point(c.point)) bad("point", c.point);
        break;
      case "distance":
        if (!point(c.a)) bad("point", c.a);
        if (!point(c.b) && !curve(c.b)) bad("point or line", c.b);
        break;
      case "radius":
      case "diameter":
        if (!curve(c.curve)) bad("circle or arc", c.curve);
        break;
    }
  }
}

/** Structural (JSON Schema) and referential validation of a document. Expressions are checked by the model. */
/** Formats written by earlier versions, read as the current one. */
export const LEGACY_FORMATS: readonly string[] = ["leocad/1"];

/** Steps earlier versions had and this one no longer offers ("texture": the surface pattern). */
export const REMOVED_OPS: readonly string[] = ["texture"];

/**
 * Whether cables are offered. While they are switched off, designs that hold cable steps still open
 * and keep them as they are (nothing is removed from the file), but the steps are not built, not
 * shown and cannot be added or changed. Switch back on to bring the feature back as it was.
 */
export const CABLES_ENABLED = false;

/** Steps this version keeps in a design but does not build or offer (see CABLES_ENABLED). */
export const PAUSED_OPS: readonly string[] = CABLES_ENABLED ? [] : ["cable"];

/** Whether a step is kept in the design but switched off in this version. */
export const isPausedOp = (op: unknown): boolean => PAUSED_OPS.includes(op as string);

/**
 * A design without the steps of REMOVED_OPS, and the ids of those it dropped. They only ever changed
 * the look of faces, never the solid, so no later step depends on them; a rollback to one of them
 * moves back to the step before. Anything that is not a design comes back as it was.
 */
export function withoutRemovedFeatures<T>(input: T): { doc: T; removed: string[] } {
  const d = input as { features?: unknown; rollback?: unknown } | null;
  if (!d || typeof d !== "object" || !Array.isArray(d.features)) return { doc: input, removed: [] };
  const gone = (f: unknown) => !!f && typeof f === "object" && REMOVED_OPS.includes((f as { op?: unknown }).op as string);
  const features = d.features as unknown[];
  if (!features.some(gone)) return { doc: input, removed: [] };
  const removed: string[] = [];
  const kept: unknown[] = [];
  let rollback = d.rollback;
  for (const f of features) {
    if (!gone(f)) {
      kept.push(f);
      continue;
    }
    const id = (f as { id?: unknown }).id;
    if (typeof id === "string") removed.push(id);
    if (id !== undefined && id === rollback) {
      const before = kept[kept.length - 1] as { id?: unknown } | undefined;
      rollback = before && typeof before.id === "string" ? before.id : null;
    }
  }
  return { doc: { ...d, features: kept, ...("rollback" in d ? { rollback } : {}) } as T, removed };
}

export function validateDocument(input: unknown): Validation<MeercadDocument> {
  // Files from before the rename (leocad) are the same format under another name.
  if (input && typeof input === "object" && LEGACY_FORMATS.includes((input as { format?: unknown }).format as string)) input = { ...input, format: FORMAT };
  input = withoutRemovedFeatures(input).doc;
  if (!checkDocumentShape(input)) return { ok: false, errors: formatErrors(checkDocumentShape.errors) };
  const doc = input as MeercadDocument;
  const errors: string[] = [];
  const seen = new Map<string, Feature>();
  const earlier = (fid: string, at: string, what: string, ops?: string[]) => {
    const f = seen.get(fid);
    if (!f) errors.push(`${at}: ${what} refers to unknown or later feature "${fid}"`);
    else if (ops && !ops.includes(f.op)) errors.push(`${at}: ${what} "${fid}" must be a ${ops.join(" or ")}`);
  };
  const planeSpec = (p: PlaneSpec, at: string) => {
    if ("ref" in p && !p.ref.startsWith("origin.")) earlier(p.ref, at, "plane", ["plane"]);
    if ("ref" in p && p.ref.startsWith("origin.") && !["origin.XY", "origin.XZ", "origin.YZ"].includes(p.ref)) errors.push(`${at}: unknown plane "${p.ref}"`);
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
    for (const sel of asArray(edges)) if ("select" in sel && sel.of !== undefined) earlier(sel.of, at, "selector");
  };

  for (const f of doc.features) {
    const at = `feature ${f.id}`;
    if (seen.has(f.id)) errors.push(`${at}: duplicate id`);
    switch (f.op) {
      case "sketch":
        planeSpec(f.plane, at);
        checkSketch(f, at, errors);
        break;
      case "plane":
        planeSpec(f.base, at);
        break;
      case "extrude":
      case "revolve":
        if ("sketch" in f.profile) earlier(f.profile.sketch, at, "profile", ["sketch"]);
        if (f.op === "extrude" && f.extent === "two_sided" && f.distance2 === undefined) errors.push(`${at}: two_sided extrude needs distance2`);
        if (f.op === "revolve" && "line" in f.axis) earlier(f.axis.line.split(".")[0]!, at, "axis", ["sketch"]);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "loft":
        for (const p of f.profiles) if ("sketch" in p) earlier(p.sketch, at, "profile", ["sketch"]);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "sweep":
        if ("sketch" in f.profile) earlier(f.profile.sketch, at, "profile", ["sketch"]);
        earlier(f.path.sketch, at, "path", ["sketch"]);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "fillet":
      case "chamfer":
        edgeSelectors(f.edges, at);
        break;
      case "thread":
        if ("select" in f.face && f.face.of !== undefined) earlier(f.face.of, at, "selector");
        break;
      case "coil":
        if ("sketch" in f.profile) earlier(f.profile.sketch, at, "profile", ["sketch"]);
        if ("line" in f.axis) earlier(f.axis.line.split(".")[0]!, at, "axis", ["sketch"]);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "spring":
      case "screw":
        if (f.plane) planeSpec(f.plane, at);
        if (f.op === "screw" && f.kind === "nut" && f.head === "socket") errors.push(`${at}: nuts are hex, round or knob`);
        if (f.op === "screw" && f.kind === "nut" && f.threadLength !== undefined) errors.push(`${at}: threadLength is for screws`);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "gear":
        if (f.meshWith) earlier(f.meshWith.gear, at, "meshWith", ["gear"]);
        else if (f.module === undefined) errors.push(`${at}: a gear needs a module (or meshWith)`);
        if (f.plane) planeSpec(f.plane, at);
        if (f.kind !== "spur" && f.bore) errors.push(`${at}: only spur gears take a bore`);
        if (f.kind !== "spur" && f.hub) errors.push(`${at}: only spur gears take a hub`);
        if (f.kind === "rack" && f.chamfer !== undefined) errors.push(`${at}: racks have no tooth chamfer yet`);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "linear_pattern":
      case "circular_pattern":
      case "mirror": {
        const ids = "features" in f.source ? f.source.features : f.source.bodies;
        if ("features" in f.source) for (const s of ids) earlier(s, at, "pattern source");
        else for (const s of ids) body(s, at, "pattern source");
        if (f.op === "mirror") planeSpec(f.plane, at);
        break;
      }
      case "transform":
      case "delete":
        for (const b of f.bodies) body(b, at);
        break;
      case "draft":
        planeSpec(f.neutral, at);
        break;
      case "offset_face":
        if (f.upTo) planeSpec(f.upTo, at);
        break;
      case "lithophane":
        if (f.plane) planeSpec(f.plane, at);
        if (!f.image.pixels.startsWith("blob:") && f.image.pixels.length !== Math.ceil((f.image.width * f.image.height) / 3) * 4)
          errors.push(`${at}: image.pixels must hold width × height bytes (base64)`);
        break;
      case "scale":
        for (const b of f.bodies) body(b, at);
        break;
      case "align":
        if ("face" in f.from !== "face" in f.to) errors.push(`${at}: align needs two flat faces or two round faces (axisOf)`);
        for (const b of f.bodies ?? []) body(b, at);
        break;
      case "standard_part":
        planeSpec(f.plane, at);
        if (f.kind !== "magnet" && !f.size) errors.push(`${at}: a ${f.kind} needs a size`);
        break;
      case "primitive":
        if (f.shape === "box" && !f.size) errors.push(`${at}: a box needs a size [x, y, z]`);
        if (f.shape !== "box" && f.diameter === undefined) errors.push(`${at}: a ${f.shape} needs a diameter`);
        if (f.shape === "cylinder" && f.height === undefined) errors.push(`${at}: a cylinder needs a height`);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "text":
        planeSpec(f.plane, at);
        for (const t of f.targets ?? []) body(t, at, "target body");
        break;
      case "gridfinity":
        if (f.plane) planeSpec(f.plane, at);
        if (f.baseplate) {
          earlier(f.baseplate, at, "baseplate", ["gridfinity"]);
          const bp = seen.get(f.baseplate);
          if (bp && bp.op === "gridfinity" && bp.kind !== "baseplate") errors.push(`${at}: "${f.baseplate}" is a bin, not a baseplate`);
        }
        if (f.kind === "baseplate" && f.baseplate) errors.push(`${at}: a baseplate cannot sit in a baseplate`);
        if (f.kind === "bin" && f.drawer) errors.push(`${at}: drawer is for baseplates`);
        if (f.kind === "bin" && (f.outline || f.bed || f.fill !== undefined)) errors.push(`${at}: outline, fill and bed are for baseplates`);
        if (f.outline) earlier(f.outline.sketch, at, "outline", ["sketch"]);
        if (f.outline && f.drawer) errors.push(`${at}: give a drawer or an outline, not both`);
        if (f.pocket) {
          if (f.kind !== "bin") errors.push(`${at}: pocket is for bins`);
          else body(f.pocket.body, at, "pocket body");
        }
        if (!f.units && !(f.kind === "bin" && f.pocket) && !(f.kind === "baseplate" && (f.drawer || f.outline))) errors.push(`${at}: units are required`);
        break;
      case "box":
        if (f.plane) planeSpec(f.plane, at);
        if (f.lid === "screw" && f.shape === "rect") errors.push(`${at}: screw lids need a round box`);
        if (f.lid === "screw" && f.depth !== undefined) errors.push(`${at}: a round box has no depth (width is its diameter)`);
        break;
      case "snap_hook":
        planeSpec(f.plane, at);
        for (const b of f.catchIn ?? []) body(b, at);
        for (const b of f.targets ?? []) body(b, at);
        break;
      case "wall":
        if (f.plane) planeSpec(f.plane, at);
        if (f.board) {
          earlier(f.board, at, "board", ["wall"]);
          const bd = seen.get(f.board);
          if (bd && bd.op === "wall" && bd.kind !== "board") errors.push(`${at}: "${f.board}" is a holder, not a board`);
          if (bd && bd.op === "wall" && bd.system !== f.system) errors.push(`${at}: "${f.board}" is a ${bd.system} board, not ${f.system}`);
        }
        if (f.kind === "board" && f.board) errors.push(`${at}: a board cannot sit on a board`);
        if (f.accessory === "screw" && f.system !== "opengrid") errors.push(`${at}: the screw snap is for openGrid boards`);
        break;
      case "label":
        if (f.plane) planeSpec(f.plane, at);
        if (!f.text?.trim() && (f.symbol ?? "none") === "none") errors.push(`${at}: a label needs a text or a symbol`);
        break;
      case "rib":
        earlier(f.sketch, at, "sketch", ["sketch"]);
        break;
      case "split":
        planeSpec(f.plane, at);
        for (const b of f.bodies) body(b, at);
        if (f.connectors && (f.keep ?? "both") !== "both") errors.push(`${at}: connectors need both pieces (keep "both")`);
        if (f.connectors?.points && f.connectors.kind === "dovetail") errors.push(`${at}: points are for pins and dowels`);
        break;
      case "mesh_convert":
        body(f.body, at);
        break;
      case "bend":
        for (const b of f.bodies) body(b, at);
        if (f.mode === "bend" ? f.angle === undefined && f.radius === undefined : f.radius === undefined) errors.push(`${at}: ${f.mode === "bend" ? "a bend needs an angle or a radius" : `${f.mode} needs a radius`}`);
        break;
      case "cable":
        if (f.shape === "ribbon" ? f.diameter !== undefined : f.diameter === undefined) errors.push(`${at}: ${f.shape === "ribbon" ? "a ribbon cable takes conductors, not a diameter" : "a round cable needs a diameter"}`);
        if (f.shape !== "ribbon" && f.conductors !== undefined) errors.push(`${at}: conductors are for ribbon cables`);
        for (const end of [f.start, f.end]) if (end && (end.kind === "xt30" || end.kind === "xt60") && end.pins !== undefined) errors.push(`${at}: ${end.kind} plugs have two contacts`);
        break;
      case "hole":
        planeSpec(f.plane, at);
        if (f.kind === "simple" ? f.diameter === undefined : !f.size) errors.push(`${at}: a ${f.kind} hole needs ${f.kind === "simple" ? "a diameter" : "a size such as M3"}`);
        break;
      case "boolean":
        for (const b of [f.target, ...f.tools]) body(b, at);
        if (f.tools.includes(f.target)) errors.push(`${at}: target cannot also be a tool`);
        break;
      default:
        break;
    }
    seen.set(f.id, f);
  }
  if (doc.variants) {
    const names = new Set<string>();
    for (const v of doc.variants) {
      if (names.has(v.name)) errors.push(`variant "${v.name}": duplicate name`);
      names.add(v.name);
      for (const p of Object.keys(v.params)) if (!(p in doc.params)) errors.push(`variant "${v.name}": unknown parameter "${p}"`);
    }
  }
  if (doc.variant !== undefined && !doc.variants?.some((v) => v.name === doc.variant)) errors.push(`variant "${doc.variant}" is in use but not defined`);
  if (doc.versions) {
    const names = new Set<string>();
    for (const v of doc.versions) {
      if (names.has(v.name)) errors.push(`version "${v.name}": duplicate name`);
      names.add(v.name);
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
    for (const m of mech.motions ?? []) {
      const at = `motion ${m.id}`;
      if (motionIds.has(m.id)) errors.push(`${at}: duplicate id`);
      motionIds.add(m.id);
      for (const k of m.keys) {
        if (k.at > m.duration + 1e-9) errors.push(`${at}: a moment at ${k.at} s lies after the end (${m.duration} s)`);
        // Cylindrical joints move as "<id>.turn" and "<id>.slide".
        for (const j of Object.keys(k.values)) if (!jointIds.has(j.replace(/\.(turn|slide)$/, ""))) errors.push(`${at}: unknown joint "${j}"`);
      }
    }
    for (const c of mech.couplings ?? []) {
      const at = `coupling ${c.id}`;
      for (const r of [c.driver, c.driven]) if (!jointIds.has(r)) errors.push(`${at}: unknown joint "${r}"`);
      if (c.driver === c.driven) errors.push(`${at}: a joint cannot drive itself`);
    }
  }
  if (doc.rollback !== null && !seen.has(doc.rollback)) errors.push(`rollback: unknown feature "${doc.rollback}"`);
  for (const n of doc.autoParams ?? []) if (!(n in doc.params)) errors.push(`autoParams: unknown parameter "${n}"`);
  return errors.length ? { ok: false, errors } : { ok: true, value: doc };
}

export function validateOp(input: unknown): Validation<DocOp> {
  if (!checkOpShape(input)) return { ok: false, errors: formatErrors(checkOpShape.errors) };
  return { ok: true, value: input as DocOp };
}

export function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}
