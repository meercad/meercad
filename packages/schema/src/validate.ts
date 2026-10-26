import Ajv, { type ErrorObject } from "ajv";
import { docOpSchema, documentSchema } from "./schema.js";
import type { DocOp, EdgeSelector, OpencadDocument } from "./types.js";

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const ajv = new Ajv({ allErrors: true, strict: false });
const checkDocumentShape = ajv.compile(documentSchema);
const checkOpShape = ajv.compile(docOpSchema);

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  // `if/then` produce an extra "must match then schema" per failure; the real cause is listed separately.
  return (errors ?? [])
    .filter((e) => e.keyword !== "if")
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}${formatParams(e)}`);
}

function formatParams(e: ErrorObject): string {
  if (e.keyword === "additionalProperties") return ` (${String(e.params["additionalProperty"])})`;
  if (e.keyword === "enum") return ` (${(e.params["allowedValues"] as unknown[]).join(", ")})`;
  if (e.keyword === "const") return ` (${JSON.stringify(e.params["allowedValue"])})`;
  return "";
}

/** Structural (JSON Schema) and referential validation of a document. Expressions are checked by the model. */
export function validateDocument(input: unknown): Validation<OpencadDocument> {
  if (!checkDocumentShape(input)) return { ok: false, errors: formatErrors(checkDocumentShape.errors) };
  const doc = input as OpencadDocument;
  const errors: string[] = [];
  const seen = new Map<string, OpencadDocument["features"][number]>();
  for (const f of doc.features) {
    const at = `feature ${f.id}`;
    if (seen.has(f.id)) errors.push(`${at}: duplicate id`);
    switch (f.op) {
      case "sketch": {
        const ids = new Set<string>();
        for (const e of f.entities) {
          if (ids.has(e.id)) errors.push(`${at}: duplicate entity id ${e.id}`);
          ids.add(e.id);
        }
        break;
      }
      case "extrude": {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\.region$/.exec(f.profile.ref);
        if (!m) {
          errors.push(`${at}: profile ref must look like "<sketch>.<entity>.region", got "${f.profile.ref}"`);
          break;
        }
        const sk = seen.get(m[1]!);
        if (!sk || sk.op !== "sketch") errors.push(`${at}: profile refers to unknown or later sketch "${m[1]}"`);
        else if (!sk.entities.some((e) => e.id === m[2])) errors.push(`${at}: sketch ${m[1]} has no entity "${m[2]}"`);
        break;
      }
      case "fillet": {
        for (const sel of asArray(f.edges)) {
          if ("select" in sel && sel.of !== undefined && !seen.has(sel.of)) {
            errors.push(`${at}: selector refers to unknown or later feature "${sel.of}"`);
          }
        }
        break;
      }
    }
    seen.set(f.id, f);
  }
  if (doc.rollback !== null && !seen.has(doc.rollback)) errors.push(`rollback: unknown feature "${doc.rollback}"`);
  return errors.length ? { ok: false, errors } : { ok: true, value: doc };
}

export function validateOp(input: unknown): Validation<DocOp> {
  if (!checkOpShape(input)) return { ok: false, errors: formatErrors(checkOpShape.errors) };
  return { ok: true, value: input as DocOp };
}

export function asArray(edges: EdgeSelector | EdgeSelector[]): EdgeSelector[] {
  return Array.isArray(edges) ? edges : [edges];
}
