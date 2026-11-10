import { MATERIALS, materialById } from "./materials.js";
import { emptyDocument, isPausedOp, validateDocument, validateOp, type DocOp, type Expr, type Feature, type MeercadDocument } from "@meercad/schema";
import { renameInExpr } from "./expr.js";
import { FIT_VAR } from "./fit.js";
import { mapFeatureExprs } from "./resolve.js";
import { designOf, pruneBlobs, restored, snapshot } from "./versions.js";

export class OpError extends Error {}

/** Applies one Operations-API op to a document, returning a new document. Validates input and result. */
export function applyOp(doc: MeercadDocument, input: unknown): MeercadDocument {
  const v = validateOp(input);
  if (!v.ok) throw new OpError(`invalid op: ${v.errors.join("; ")}`);
  const op = v.value;
  const next = structuredClone(doc);
  switch (op.type) {
    case "add_features": {
      const paused = op.features.find((f) => isPausedOp(f.op));
      if (paused) throw new OpError(`${paused.op} steps are not available in this version`);
      let at = next.features.length;
      if (op.after !== undefined) {
        at = op.after === null ? 0 : indexOf(next, op.after) + 1;
      } else if (next.rollback !== null) {
        at = indexOf(next, next.rollback) + 1;
      }
      next.features.splice(at, 0, ...structuredClone(op.features));
      if (next.rollback !== null && op.after === undefined) next.rollback = op.features.at(-1)!.id;
      break;
    }
    case "edit_feature": {
      const i = indexOf(next, op.id);
      if (isPausedOp(next.features[i]!.op) || isPausedOp(op.patch["op"])) throw new OpError(`${String(op.patch["op"] ?? next.features[i]!.op)} steps are not available in this version`);
      if ("id" in op.patch && op.patch["id"] !== op.id) throw new OpError("edit_feature cannot change a feature id");
      const merged = { ...next.features[i], ...structuredClone(op.patch) };
      for (const [k, val] of Object.entries(merged)) if (val === null) delete (merged as Record<string, unknown>)[k];
      next.features[i] = merged as Feature;
      break;
    }
    case "delete_feature": {
      const i = indexOf(next, op.id);
      next.features.splice(i, 1);
      if (next.rollback === op.id) next.rollback = next.features[i - 1]?.id ?? null;
      break;
    }
    case "move_feature": {
      const i = indexOf(next, op.id);
      const [f] = next.features.splice(i, 1);
      const at = op.after === null ? 0 : indexOf(next, op.after) + 1;
      next.features.splice(at, 0, f!);
      break;
    }
    case "rename_param": {
      if (!(op.name in next.params)) throw new OpError(`unknown parameter "${op.name}"`);
      if (op.to in next.params) throw new OpError(`parameter "${op.to}" already exists`);
      if (op.to === FIT_VAR) throw new OpError(`"${FIT_VAR}" is the design's fit (set_fit); choose another name`);
      next.params = Object.fromEntries(Object.entries(next.params).map(([k, v]) => [k === op.name ? op.to : k, renameInExpr(v, op.name, op.to)]));
      if (next.autoParams) next.autoParams = next.autoParams.map((n) => (n === op.name ? op.to : n));
      next.features = next.features.map((f) => mapFeatureExprs(f, (e) => renameInExpr(e, op.name, op.to)));
      for (const v of next.variants ?? []) v.params = Object.fromEntries(Object.entries(v.params).map(([k, e]) => [k === op.name ? op.to : k, renameInExpr(e, op.name, op.to)]));
      if (next.mechanism) {
        const ren = (e: Expr) => renameInExpr(e, op.name, op.to);
        for (const j of next.mechanism.joints) if (j.limits) j.limits = [ren(j.limits[0]), ren(j.limits[1])];
        for (const c of next.mechanism.couplings ?? []) c.ratio = ren(c.ratio);
        if (next.mechanism.clearance !== undefined) next.mechanism.clearance = ren(next.mechanism.clearance);
      }
      if (next.fit !== undefined) next.fit = renameInExpr(next.fit, op.name, op.to);
      break;
    }
    case "set_param": {
      // `fit` is the design's fit; only a variable of that name from before it existed stays editable.
      if (op.name === FIT_VAR && op.expr !== null && !(op.name in next.params)) throw new OpError(`"${FIT_VAR}" is the design's fit: set it with set_fit`);
      if (op.expr === null) {
        delete next.params[op.name];
        for (const v of next.variants ?? []) delete v.params[op.name];
      } else next.params[op.name] = op.expr;
      const auto = new Set(next.autoParams ?? []);
      if (op.expr === null || op.auto === false) auto.delete(op.name);
      else if (op.auto) auto.add(op.name);
      if (auto.size) next.autoParams = [...auto];
      else delete next.autoParams;
      break;
    }
    case "set_rollback":
      if (op.id !== null) indexOf(next, op.id);
      next.rollback = op.id;
      break;
    case "replace": {
      // A document read back without its versions (get_model leaves them out) keeps them.
      const keep = !op.doc.versions && doc.versions ? { versions: doc.versions, ...(doc.blobs ? { blobs: doc.blobs } : {}) } : {};
      return checked({ ...op.doc, ...keep });
    }
    case "set_part_color": {
      const colors = { ...(next.partColors ?? {}) };
      if (op.color) colors[op.part] = op.color.toLowerCase();
      else delete colors[op.part];
      if (Object.keys(colors).length) next.partColors = colors;
      else delete next.partColors;
      break;
    }
    case "set_see_through": {
      const set = new Set(next.seeThrough ?? []);
      for (const p of op.parts) op.on ? set.add(p) : set.delete(p);
      if (set.size) next.seeThrough = [...set];
      else delete next.seeThrough;
      break;
    }
    case "set_part_list":
      if (op.groups !== undefined) {
        if (op.groups?.length) next.partGroups = structuredClone(op.groups);
        else delete next.partGroups;
      }
      if (op.order !== undefined) {
        if (op.order?.length) next.partOrder = [...op.order];
        else delete next.partOrder;
      }
      break;
    case "set_fit":
      if (op.fit === null) delete next.fit;
      else next.fit = op.fit;
      break;
    case "set_units":
      if (op.units === "in") next.units = "in";
      else delete next.units;
      break;
    case "set_joint": {
      const m = (next.mechanism ??= { joints: [] });
      const i = m.joints.findIndex((j) => j.id === op.joint.id);
      if (i >= 0) m.joints[i] = structuredClone(op.joint);
      else m.joints.push(structuredClone(op.joint));
      break;
    }
    case "delete_joint": {
      const m = next.mechanism;
      if (!m?.joints.some((j) => j.id === op.id)) throw new OpError(`unknown joint "${op.id}"`);
      m.joints = m.joints.filter((j) => j.id !== op.id);
      // Couplings of a deleted joint go with it.
      if (m.couplings) m.couplings = m.couplings.filter((c) => c.driver !== op.id && c.driven !== op.id);
      // Motions forget the joint.
      for (const mo of m.motions ?? []) for (const k of mo.keys) for (const j of Object.keys(k.values)) if (j === op.id || j.startsWith(`${op.id}.`)) delete k.values[j];
      if (!m.joints.length && !m.couplings?.length && !m.motions?.length) delete next.mechanism;
      break;
    }
    case "set_coupling": {
      const m = (next.mechanism ??= { joints: [] });
      const list = (m.couplings ??= []);
      const i = list.findIndex((c) => c.id === op.coupling.id);
      if (i >= 0) list[i] = structuredClone(op.coupling);
      else list.push(structuredClone(op.coupling));
      break;
    }
    case "set_material": {
      if (op.material !== null && !materialById(op.material, next.materials)) throw new OpError(`unknown material "${op.material}": use one of ${[...(next.materials ?? []), ...MATERIALS].map((m) => m.id).join(", ")}`);
      const picked = { ...(next.partMaterials ?? {}) };
      if (op.material) picked[op.part] = op.material;
      else delete picked[op.part];
      if (Object.keys(picked).length) next.partMaterials = picked;
      else delete next.partMaterials;
      break;
    }
    case "define_material": {
      const m = structuredClone(op.material);
      if (MATERIALS.some((x) => x.id === m.id)) throw new OpError(`"${m.id}" is a library material; give your own material another id`);
      if (!materialById(m.base)) throw new OpError(`unknown base material "${m.base}": use one of ${MATERIALS.map((x) => x.id).join(", ")}`);
      const list = (next.materials ??= []);
      const i = list.findIndex((x) => x.id === m.id);
      if (i >= 0) list[i] = m;
      else list.push(m);
      break;
    }
    case "delete_material": {
      const list = next.materials ?? [];
      const m = list.find((x) => x.id === op.id);
      if (!m) throw new OpError(`no own material "${op.id}"`);
      // Parts keep what they are made of: the base material.
      for (const [part, id] of Object.entries(next.partMaterials ?? {})) if (id === op.id) next.partMaterials![part] = m.base;
      next.materials = list.filter((x) => x !== m);
      if (!next.materials.length) delete next.materials;
      break;
    }
    case "set_variant": {
      const list = (next.variants ??= []);
      const i = list.findIndex((v) => v.name === op.name);
      const name = op.rename ?? op.name;
      if (name !== op.name && list.some((v) => v.name === name)) throw new OpError(`a variant named "${name}" already exists`);
      const v = { name, params: structuredClone(op.params) };
      if (i >= 0) list[i] = v;
      else list.push(v);
      if (next.variant === op.name) next.variant = name;
      break;
    }
    case "delete_variant": {
      if (!next.variants?.some((v) => v.name === op.name)) throw new OpError(`unknown variant "${op.name}"`);
      next.variants = next.variants.filter((v) => v.name !== op.name);
      if (!next.variants.length) delete next.variants;
      if (next.variant === op.name) delete next.variant;
      break;
    }
    case "use_variant": {
      if (op.name === null) delete next.variant;
      else if (!next.variants?.some((v) => v.name === op.name)) throw new OpError(`unknown variant "${op.name}"`);
      else next.variant = op.name;
      break;
    }
    case "save_version": {
      const blobs = { ...(next.blobs ?? {}) };
      // A design brought in from a file is checked like a replace, and saved as it is.
      const v = snapshot(op.doc ? checked(designOf(op.doc)) : next, op.name, op.at ?? Date.now(), blobs);
      next.versions = [...(next.versions ?? []).filter((x) => x.name !== op.name), v];
      next.blobs = blobs;
      pruneBlobs(next);
      break;
    }
    case "restore_version": {
      const v = next.versions?.find((x) => x.name === op.name);
      if (!v) throw new OpError(`unknown version "${op.name}"`);
      try {
        return checked(restored(next, v));
      } catch (e) {
        throw e instanceof OpError ? new OpError(`version "${op.name}" cannot be restored: ${e.message}`) : new OpError(String((e as Error).message ?? e));
      }
    }
    case "rename_version": {
      const v = next.versions?.find((x) => x.name === op.name);
      if (!v) throw new OpError(`unknown version "${op.name}"`);
      if (op.to !== op.name && next.versions!.some((x) => x.name === op.to)) throw new OpError(`a version named "${op.to}" already exists`);
      v.name = op.to;
      break;
    }
    case "delete_version": {
      if (!next.versions?.some((x) => x.name === op.name)) throw new OpError(`unknown version "${op.name}"`);
      next.versions = next.versions.filter((x) => x.name !== op.name);
      if (!next.versions.length) delete next.versions;
      pruneBlobs(next);
      break;
    }
    case "set_reference": {
      const list = (next.references ??= []);
      const i = list.findIndex((r) => r.id === op.reference.id);
      if (i >= 0) list[i] = structuredClone(op.reference);
      else list.push(structuredClone(op.reference));
      break;
    }
    case "delete_reference": {
      if (!next.references?.some((r) => r.id === op.id)) throw new OpError(`unknown reference model "${op.id}"`);
      next.references = next.references.filter((r) => r.id !== op.id);
      if (!next.references.length) delete next.references;
      break;
    }
    case "delete_coupling": {
      const m = next.mechanism;
      if (!m?.couplings?.some((c) => c.id === op.id)) throw new OpError(`unknown coupling "${op.id}"`);
      m.couplings = m.couplings.filter((c) => c.id !== op.id);
      if (!m.couplings.length) delete m.couplings;
      break;
    }
    case "set_motion": {
      const m = (next.mechanism ??= { joints: [] });
      const list = (m.motions ??= []);
      const motion = structuredClone(op.motion);
      motion.keys.sort((a, b) => a.at - b.at);
      const i = list.findIndex((x) => x.id === motion.id);
      if (i >= 0) list[i] = motion;
      else list.push(motion);
      break;
    }
    case "delete_motion": {
      const m = next.mechanism;
      if (!m?.motions?.some((x) => x.id === op.id)) throw new OpError(`unknown motion "${op.id}"`);
      m.motions = m.motions.filter((x) => x.id !== op.id);
      if (!m.motions.length) delete m.motions;
      break;
    }
  }
  return checked(next);
}

function checked(doc: unknown): MeercadDocument {
  const v = validateDocument(doc);
  if (!v.ok) throw new OpError(v.errors.join("; "));
  return v.value;
}

function indexOf(doc: MeercadDocument, id: string): number {
  const i = doc.features.findIndex((f) => f.id === id);
  if (i < 0) throw new OpError(`unknown feature "${id}"`);
  return i;
}

/** Next unused feature id for an op, e.g. "ex2". */
export function nextFeatureId(doc: MeercadDocument, op: Feature["op"]): string {
  const prefix: Record<Feature["op"], string> = {
    sketch: "sk",
    primitive: "pr",
    plane: "pl",
    extrude: "ex",
    revolve: "rv",
    fillet: "fi",
    chamfer: "ch",
    shell: "sh",
    thread: "th",
    gear: "gr",
    coil: "co",
    spring: "spr",
    screw: "scr",
    cable: "cab",
    linear_pattern: "lp",
    circular_pattern: "cp",
    mirror: "mi",
    boolean: "bo",
    transform: "mv",
    delete: "del",
    import: "im",
    mesh_convert: "mc",
    bend: "bd",
    hole: "ho",
    loft: "lo",
    split: "sp",
    rib: "rb",
    draft: "dr",
    offset_face: "of",
    text: "tx",
    standard_part: "np",
    gridfinity: "gf",
    label: "lb",
    box: "bx",
    snap_hook: "sh",
    wall: "wl",
    lithophane: "li",
    align: "al",
    scale: "sc",
    sweep: "sw",
  };
  const used = new Set(doc.features.map((f) => f.id));
  let n = 1;
  while (used.has(`${prefix[op]}${n}`)) n++;
  return `${prefix[op]}${n}`;
}

type Listener = (doc: MeercadDocument) => void;

/** Holds the current document and its undo history. Undo/redo is a position in the history of documents. */
export class DocumentStore {
  private history: MeercadDocument[];
  private position = 0;
  private listeners = new Set<Listener>();

  constructor(initial: MeercadDocument = emptyDocument()) {
    this.history = [checked(initial)];
  }

  get doc(): MeercadDocument {
    return this.history[this.position]!;
  }

  get canUndo(): boolean {
    return this.position > 0;
  }

  get canRedo(): boolean {
    return this.position < this.history.length - 1;
  }

  /** Applies ops atomically as one undo step. Throws OpError and leaves the store unchanged on failure. */
  apply(...ops: DocOp[]): MeercadDocument {
    const next = ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), this.doc);
    this.history.length = this.position + 1;
    this.history.push(next);
    this.position++;
    this.emit();
    return next;
  }

  /** Applies ops but replaces the current undo step instead of adding one (continuous edits). */
  amend(...ops: DocOp[]): MeercadDocument {
    if (this.position === 0) return this.apply(...ops);
    const next = ops.reduce<MeercadDocument>((d, op) => applyOp(d, op), this.doc);
    this.history.length = this.position + 1;
    this.history[this.position] = next;
    this.emit();
    return next;
  }

  undo(): void {
    if (!this.canUndo) return;
    this.position--;
    this.emit();
  }

  redo(): void {
    if (!this.canRedo) return;
    this.position++;
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.doc);
  }
}
