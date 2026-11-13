/**
 * Which premium packs a design uses, for designs shared with someone who may not have them. What
 * is in the file always opens, builds, shows and exports; without the pack only changing those
 * parts is closed (with a hint which pack it needs), and saving keeps them as they are.
 *
 * Pure (no app state), so the tests and the share dialog can use it.
 */
import type { Feature, MeercadDocument } from "@meercad/schema";

export type PackId = "mechanics" | "scan" | "drawings" | "versions";

/** Features only the pack makes or changes. */
const FEATURE_PACK: Partial<Record<Feature["op"], PackId>> = { gear: "mechanics", spring: "mechanics" };

/** The pack a feature needs to be changed, or null when it is free. */
export function featurePack(f: Pick<Feature, "op">): PackId | null {
  return FEATURE_PACK[f.op] ?? null;
}

export interface PackUse {
  pack: PackId;
  /** What in the design uses it, as English texts for t(). */
  what: string[];
}

/** The packs a design uses, each with what uses it; empty for a design without any. */
export function packsUsed(doc: MeercadDocument): PackUse[] {
  const use = new Map<PackId, Set<string>>();
  const add = (pack: PackId, what: string) =>
    (use.get(pack) ?? use.set(pack, new Set()).get(pack)!).add(what);

  for (const f of doc.features) {
    if (f.op === "gear") add("mechanics", "gears");
    else if (f.op === "spring") add("mechanics", "springs");
  }

  if (doc.mechanism?.joints.length) add("mechanics", "joints");
  if (doc.mechanism?.motions?.length) add("mechanics", "motions");
  if (doc.variants?.length) add("versions", "variants");
  if (doc.versions?.length) add("versions", "saved versions");
  if (doc.references?.length) add("scan", "terrain models");

  const order: PackId[] = ["mechanics", "scan", "drawings", "versions"];

  return order.filter((p) => use.has(p)).map((pack) => ({ pack, what: [...use.get(pack)!] }));
}

/**
 * The document as it is shared: everything that builds and edits it (features, variables,
 * variants, joints, materials, colours, imported files), and the saved versions only when asked,
 * so earlier states do not leave the device by accident.
 */
export function sharedDoc(doc: MeercadDocument, opts: { versions?: boolean } = {}): MeercadDocument {
  if (opts.versions || (!doc.versions && !doc.blobs)) return doc;

  const { versions: _v, blobs: _b, ...rest } = doc;

  return rest;
}
