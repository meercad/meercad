import { emptyDocument, validateDocument, validateOp, type DocOp, type Feature, type MeercadDocument } from "@meercad/schema";
import { renameInExpr } from "./expr.js";
import { mapFeatureExprs } from "./resolve.js";

export class OpError extends Error {}

/** Applies one Operations-API op to a document, returning a new document. Validates input and result. */
export function applyOp(doc: MeercadDocument, input: unknown): MeercadDocument {
  const v = validateOp(input);
  if (!v.ok) throw new OpError(`invalid op: ${v.errors.join("; ")}`);
  const op = v.value;
  const next = structuredClone(doc);
  switch (op.type) {
    case "add_features": {
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
      next.params = Object.fromEntries(Object.entries(next.params).map(([k, v]) => [k === op.name ? op.to : k, renameInExpr(v, op.name, op.to)]));
      if (next.autoParams) next.autoParams = next.autoParams.map((n) => (n === op.name ? op.to : n));
      next.features = next.features.map((f) => mapFeatureExprs(f, (e) => renameInExpr(e, op.name, op.to)));
      break;
    }
    case "set_param": {
      if (op.expr === null) delete next.params[op.name];
      else next.params[op.name] = op.expr;
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
    case "replace":
      return checked(op.doc);
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
    plane: "pl",
    extrude: "ex",
    revolve: "rv",
    fillet: "fi",
    chamfer: "ch",
    shell: "sh",
    thread: "th",
    linear_pattern: "lp",
    circular_pattern: "cp",
    mirror: "mi",
    boolean: "bo",
    transform: "mv",
    delete: "del",
    import: "im",
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
