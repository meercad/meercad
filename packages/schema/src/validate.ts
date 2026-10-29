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
    const refs = e.type === "line" ? [e.p1, e.p2] : e.type === "circle" ? [e.center] : e.type === "arc" ? [e.center, e.start, e.end] : [];
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

export function validateDocument(input: unknown): Validation<MeercadDocument> {
  // Files from before the rename (leocad) are the same format under another name.
  if (input && typeof input === "object" && LEGACY_FORMATS.includes((input as { format?: unknown }).format as string)) input = { ...input, format: FORMAT };
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
  // A body id is a feature id, or a feature id with a copy suffix (pattern copies: "lp1_2").
  const body = (b: string, at: string) => earlier(seen.has(b) ? b : b.split("_")[0]!, at, "body");
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
        for (const t of f.targets ?? []) earlier(t, at, "target body");
        break;
      case "loft":
        for (const p of f.profiles) if ("sketch" in p) earlier(p.sketch, at, "profile", ["sketch"]);
        for (const t of f.targets ?? []) earlier(t, at, "target body");
        break;
      case "sweep":
        if ("sketch" in f.profile) earlier(f.profile.sketch, at, "profile", ["sketch"]);
        earlier(f.path.sketch, at, "path", ["sketch"]);
        for (const t of f.targets ?? []) earlier(t, at, "target body");
        break;
      case "fillet":
      case "chamfer":
        edgeSelectors(f.edges, at);
        break;
      case "thread":
        if ("select" in f.face && f.face.of !== undefined) earlier(f.face.of, at, "selector");
        break;
      case "gear":
        if (f.meshWith) earlier(f.meshWith.gear, at, "meshWith", ["gear"]);
        else if (f.module === undefined) errors.push(`${at}: a gear needs a module (or meshWith)`);
        if (f.plane) planeSpec(f.plane, at);
        if (f.kind !== "spur" && f.bore) errors.push(`${at}: only spur gears take a bore`);
        if (f.kind !== "spur" && f.hub) errors.push(`${at}: only spur gears take a hub`);
        if (f.kind === "rack" && f.chamfer !== undefined) errors.push(`${at}: racks have no tooth chamfer yet`);
        for (const t of f.targets ?? []) earlier(t, at, "target body");
        break;
      case "linear_pattern":
      case "circular_pattern":
      case "mirror": {
        const ids = "features" in f.source ? f.source.features : f.source.bodies;
        for (const s of ids) earlier(s, at, "pattern source");
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
      case "rib":
        earlier(f.sketch, at, "sketch", ["sketch"]);
        break;
      case "split":
        planeSpec(f.plane, at);
        for (const b of f.bodies) body(b, at);
        break;
      case "mesh_convert":
        body(f.body, at);
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
