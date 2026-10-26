import { emptyDocument, validateDocument, validateOp, type DocOp, type Feature, type OpencadDocument } from "@opencad/schema";

export class OpError extends Error {}

/** Applies one Operations-API op to a document, returning a new document. Validates input and result. */
export function applyOp(doc: OpencadDocument, input: unknown): OpencadDocument {
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
    case "set_param":
      if (op.expr === null) delete next.params[op.name];
      else next.params[op.name] = op.expr;
      break;
    case "set_rollback":
      if (op.id !== null) indexOf(next, op.id);
      next.rollback = op.id;
      break;
    case "replace":
      return checked(op.doc);
  }
  return checked(next);
}

function checked(doc: unknown): OpencadDocument {
  const v = validateDocument(doc);
  if (!v.ok) throw new OpError(v.errors.join("; "));
  return v.value;
}

function indexOf(doc: OpencadDocument, id: string): number {
  const i = doc.features.findIndex((f) => f.id === id);
  if (i < 0) throw new OpError(`unknown feature "${id}"`);
  return i;
}

/** Next unused feature id for an op, e.g. "ex2". */
export function nextFeatureId(doc: OpencadDocument, op: Feature["op"]): string {
  const prefix = { sketch: "sk", extrude: "ex", fillet: "fi" }[op];
  const used = new Set(doc.features.map((f) => f.id));
  let n = 1;
  while (used.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

type Listener = (doc: OpencadDocument) => void;

/** Holds the current document and its undo history. Undo/redo is a position in the history of documents. */
export class DocumentStore {
  private history: OpencadDocument[];
  private position = 0;
  private listeners = new Set<Listener>();

  constructor(initial: OpencadDocument = emptyDocument()) {
    this.history = [checked(initial)];
  }

  get doc(): OpencadDocument {
    return this.history[this.position]!;
  }

  get canUndo(): boolean {
    return this.position > 0;
  }

  get canRedo(): boolean {
    return this.position < this.history.length - 1;
  }

  /** Applies ops atomically as one undo step. Throws OpError and leaves the store unchanged on failure. */
  apply(...ops: DocOp[]): OpencadDocument {
    const next = ops.reduce<OpencadDocument>((d, op) => applyOp(d, op), this.doc);
    this.history.length = this.position + 1;
    this.history.push(next);
    this.position++;
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
