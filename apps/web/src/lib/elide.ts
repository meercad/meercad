/**
 * Large embedded strings (imported files, pictures, terrains) left out of what assistants read, and
 * put back when ops send the placeholder back unchanged.
 */
import { designOf } from "@meercad/model";
import type { DocOp, MeercadDocument } from "@meercad/schema";

/** Strings longer than this (base64 files, pictures) are left out of what assistants read. */
const LONG = 2048;
const ELIDED = "…elided:";

/**
 * The document without its large embedded files: every long string becomes "…elided:<n> chars…".
 * Ops may send such a placeholder back unchanged; it then keeps the value that is there now.
 */
export function lightDocument(doc: MeercadDocument): MeercadDocument {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > LONG ? `${ELIDED}${v.length} chars…` : v;
    if (Array.isArray(v)) return v.map(walk);

    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }

    return v;
  };

  return walk(designOf(doc)) as MeercadDocument;
}

const isElided = (v: unknown) => typeof v === "string" && v.startsWith(ELIDED);

/** `value` with every placeholder replaced by what `now` has at the same place. */
function fill(value: unknown, now: unknown): unknown {
  if (isElided(value)) {
    if (typeof now !== "string") {
      throw new Error(
        "an elided value was sent back where the model has none: send the real value (get_model with full: true)",
      );
    }

    return now;
  }

  if (Array.isArray(value)) return value.map((x, i) => fill(x, Array.isArray(now) ? now[i] : undefined));

  if (value && typeof value === "object") {
    const o = now && typeof now === "object" ? (now as Record<string, unknown>) : {};

    return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, fill(x, o[k])]));
  }

  return value;
}

/** Ops with placeholders from `lightDocument` filled in from the document as it is. */
export function restoreElided(ops: DocOp[], doc: MeercadDocument): DocOp[] {
  return ops.map((op) => {
    switch (op.type) {
      case "edit_feature":
        return {
          ...op,
          patch: fill(
            op.patch,
            doc.features.find((feature) => feature.id === op.id),
          ) as Record<string, unknown>,
        };
      case "add_features":
        return {
          ...op,
          features: op.features.map(
            (feature) =>
              fill(
                feature,
                doc.features.find((x) => x.id === feature.id),
              ) as typeof feature,
          ),
        };
      case "set_reference":
        return {
          ...op,
          reference: fill(
            op.reference,
            doc.references?.find((reference) => reference.id === op.reference.id),
          ) as typeof op.reference,
        };
      case "replace":
        return { ...op, doc: fill(op.doc, doc) as MeercadDocument };
      default:
        return op;
    }
  });
}
