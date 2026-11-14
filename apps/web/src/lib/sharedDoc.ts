import type { MeercadDocument } from "@meercad/schema";

/**
 * The document as it is shared: everything that builds and edits it (features, variables,
 * variants, joints, materials, colours, imported files), and the saved versions only when asked,
 * so earlier states do not leave the device by accident.
 *
 * Pure (no app state), so the tests and the share dialog can use it.
 */
export function sharedDoc(doc: MeercadDocument, opts: { versions?: boolean } = {}): MeercadDocument {
  if (opts.versions || (!doc.versions && !doc.blobs)) return doc;
  const { versions: _v, blobs: _b, ...rest } = doc;
  return rest;
}
